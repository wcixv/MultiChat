// MultiChat phone server: watches Twitch chat for giveaway announcements, sends a push notification
// to your iPhone, and enters the giveaway when YOU tap Enter in the app (one account you choose).
// It never enters on its own.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ConfigStore, Platforms, PLATFORMS, LABEL } from './platforms.js';
import { Watcher } from './giveaway.js';
import { Apns } from './apns.js';
import { Telegram } from './telegram.js';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const DEAD_TOKEN = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

export function createApp({ store, platforms, apns = null, dataDir, log = console.log, enteredTtlMs = 6 * 3600 * 1000 }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')); } catch { return d; } };
  const write = (f, v) => {
    const p = path.join(dataDir, f);
    fs.writeFileSync(p + '.tmp', JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(p + '.tmp', p);
  };
  let devices = read('devices.json', []);
  let entered = read('entered.json', {});          // "account|platform|channel|word" -> time it was sent
  const hits = [];                                 // newest first, kept in memory
  const inflight = new Set();
  const cfg = () => store.data;
  const srv = () => cfg().server || {};
  let telegram = null;                             // set by main() or tests via attachTelegram

  // ---------- creators ----------
  const creators = () => Object.entries(cfg().creators || {}).map(([name, v]) => ({
    name, twitch: String(v.twitch || '').toLowerCase(), kick: String(v.kick || ''), youtube: String(v.youtube || '') }));
  const creatorFor = (twitchLogin) => creators().find((c) => c.twitch && c.twitch === String(twitchLogin).toLowerCase());
  function watchChannels() {
    const names = Array.isArray(srv().watch) && srv().watch.length ? new Set(srv().watch) : null;
    const out = creators().filter((c) => c.twitch && (!names || names.has(c.name))).map((c) => c.twitch);
    for (const c of srv().channels || []) out.push(String(c).toLowerCase());
    return [...new Set(out)];
  }

  // ---------- push ----------
  async function notify(rec) {
    if (!apns || !devices.length) return { sent: 0, devices: devices.length };
    const known = !!rec.command;
    const title = rec.test ? 'Test giveaway' : rec.crowd ? `Maybe a giveaway on ${rec.creator}` : `Giveaway on ${rec.creator}`;
    const body = rec.test ? 'Tap Enter to try it. Nothing is sent to chat.'
      : known ? (rec.crowd ? `Chat is typing ${rec.command}` : `Type ${rec.command} to enter`)
              : 'Look at the stream and type the word shown';
    const payload = {
      aps: { alert: { title, body }, sound: 'default', category: known ? 'GIVEAWAY_WORD' : 'GIVEAWAY_TYPE',
        'thread-id': rec.channel, ...(srv().time_sensitive === true ? { 'interruption-level': 'time-sensitive' } : {}) },
      hit: { id: rec.id, creator: rec.creator, channel: rec.channel, command: rec.command, crowd: rec.crowd,
        test: rec.test, text: String(rec.text).slice(0, 200) },
    };
    let sent = 0;
    for (const token of [...devices]) {
      const r = await apns.push(token, payload, { collapseId: rec.id });
      if (r.ok) sent++;
      else if (r.status === 410 || DEAD_TOKEN.has(r.reason)) { devices = devices.filter((d) => d !== token); write('devices.json', devices); }
      else log(`push failed: ${r.status} ${r.reason}`);
    }
    return { sent, devices: devices.length };
  }

  async function handleHit(hit) {
    const creator = creatorFor(hit.channel);
    const rec = { id: crypto.randomBytes(4).toString('hex'), at: Date.now(), channel: hit.channel,
      creator: creator?.name || hit.channel, command: hit.command || null, text: hit.text, crowd: !!hit.crowd,
      test: !!hit.test, user: hit.user };
    hits.unshift(rec);
    hits.length = Math.min(hits.length, 50);
    log(`giveaway: ${rec.creator} ${rec.command || '(word on stream)'}${rec.crowd ? ' [crowd]' : ''}`);
    await notify(rec);
    if (telegram) await telegram.notify(rec);
    return rec;
  }

  // ---------- entering (only ever called when you tap Enter) ----------
  async function enter(body) {
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    if (!word || word.length > 100 || /[\r\n]/.test(word)) return [400, { error: 'The word must be 1-100 characters on one line.' }];
    const account = body.account || 'Main';
    if (!platforms.accounts().some((a) => a.name === account)) return [400, { error: `Unknown account '${account}'.` }];
    const rec = hits.find((h) => h.id === body.hitId);
    if (rec?.test) return [200, { test: true, results: {}, summary: 'Test only. Nothing was sent.' }];
    const creator = (rec && creators().find((c) => c.name === rec.creator))
      || creators().find((c) => c.name === body.creator)
      || (body.channel && creatorFor(body.channel))
      || (rec ? { name: rec.channel, twitch: rec.channel, kick: '', youtube: '' } : null);
    if (!creator) return [400, { error: 'I do not know which creator that is.' }];
    const wanted = Array.isArray(body.platforms) && body.platforms.length ? body.platforms.filter((p) => PLATFORMS.includes(p)) : PLATFORMS;
    const liveOnly = srv().live_only !== false;
    const now = Date.now();
    for (const [k, t] of Object.entries(entered)) if (now - t > enteredTtlMs) delete entered[k];

    const results = {};
    for (const p of wanted) {
      const channel = creator[p];
      if (!channel) { results[p] = { status: 'no-channel' }; continue; }
      const key = `${account}|${p}|${String(channel).toLowerCase()}|${word.toLowerCase()}`;
      if (entered[key]) { results[p] = { status: 'already' }; continue; }          // never enter twice
      if (inflight.has(key)) { results[p] = { status: 'busy' }; continue; }
      inflight.add(key);
      try {
        if (liveOnly && (await platforms.isLive(p, channel)) === false) { results[p] = { status: 'offline' }; continue; }
        const r = await platforms.send(p, account, channel, word);
        if (r.ok) { entered[key] = Date.now(); results[p] = { status: 'sent' }; }
        else results[p] = { status: 'failed', detail: r.detail };
      } finally { inflight.delete(key); }
    }
    write('entered.json', entered);
    const ok = Object.entries(results).filter(([, r]) => r.status === 'sent').map(([p]) => LABEL[p]);
    const bad = Object.entries(results).filter(([, r]) => r.status === 'failed').map(([p, r]) => `${LABEL[p]}: ${r.detail}`);
    const summary = (ok.length ? `Entered as ${account} on ${ok.join(', ')}.` : 'Nothing was sent.') + (bad.length ? ` Not sent: ${bad.join('; ')}` : '');
    return [200, { results, summary }];
  }

  // ---------- http ----------
  const hitsRate = new Map();    // ip -> {n, at}
  const authFails = new Map();   // ip -> {n, at}
  const clientIp = (req) => (srv().trust_proxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
  const reply = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 10240) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/health') return reply(res, 200, { ok: true, watching: watchChannels().length });
      const ip = clientIp(req), now = Date.now();
      const r = hitsRate.get(ip);
      if (!r || now - r.at > 60000) hitsRate.set(ip, { n: 1, at: now });
      else if (++r.n > 60) return reply(res, 429, { error: 'Slow down.' });
      const f = authFails.get(ip);
      if (f && now - f.at < 600000 && f.n >= 10) return reply(res, 429, { error: 'Too many wrong keys. Try again later.' });
      const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!srv().api_key || !safeEqual(given, srv().api_key)) {
        authFails.set(ip, { n: (f && now - f.at < 600000 ? f.n : 0) + 1, at: now });
        return reply(res, 401, { error: 'Wrong key.' });
      }
      authFails.delete(ip);

      if (req.method === 'GET' && url.pathname === '/hits') return reply(res, 200, { hits });
      if (req.method === 'GET' && url.pathname === '/accounts') return reply(res, 200, { accounts: platforms.accounts(), creators: creators() });
      if (req.method === 'POST' && url.pathname === '/register') {
        const { deviceToken } = await readBody(req);
        if (typeof deviceToken !== 'string' || !/^[0-9a-fA-F]{32,200}$/.test(deviceToken)) return reply(res, 400, { error: 'Bad device token.' });
        if (!devices.includes(deviceToken.toLowerCase())) { devices.push(deviceToken.toLowerCase()); devices = devices.slice(-10); write('devices.json', devices); }
        return reply(res, 200, { ok: true, devices: devices.length });
      }
      if (req.method === 'POST' && url.pathname === '/enter') { const [code, out] = await enter(await readBody(req)); return reply(res, code, out); }
      if (req.method === 'POST' && url.pathname === '/test-push') {
        const rec = await handleHit({ channel: watchChannels()[0] || 'test', command: '!test', text: 'This is a test giveaway', user: 'server', test: true });
        return reply(res, 200, { hit: rec, devices: devices.length, pushConfigured: !!apns, telegramLinked: !!telegram?.linked });
      }
      return reply(res, 404, { error: 'Not found.' });
    } catch (e) {
      return reply(res, e.message === 'bad json' || e.message === 'too big' ? 400 : 500, { error: e.message === 'bad json' ? 'Bad JSON.' : e.message === 'too big' ? 'Too big.' : 'Server error.' });
    }
  });

  const attachTelegram = (t) => { telegram = t; };
  const findHit = (id) => hits.find((h) => h.id === id);
  return { server, handleHit, enter, notify, watchChannels, creators, hits, findHit, attachTelegram, get devices() { return devices; } };
}

// ---------- start-up ----------
function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const configPath = process.env.CONFIG || path.join(here, 'config.json');
  if (!fs.existsSync(configPath) && process.env.CONFIG_JSON) {          // first start on a host: seed the file once
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, process.env.CONFIG_JSON, { mode: 0o600 });
    console.log('Created config.json from CONFIG_JSON. From now on the file is used (it keeps refreshed logins).');
  }
  if (!fs.existsSync(configPath)) { console.error(`No config.json at ${configPath}. Copy your data/config.json there and add a "server" block (see config.example.json).`); process.exit(1); }
  const store = new ConfigStore(configPath);
  const s = store.data.server || {};
  if (typeof s.api_key !== 'string' || s.api_key.length < 16) { console.error('server.api_key must be a long random string (16+ characters).'); process.exit(1); }
  let apns = null;
  if (s.apns?.team_id && s.apns?.key_id && s.apns?.bundle_id) {
    const keyPem = s.apns.key_pem || fs.readFileSync(path.resolve(path.dirname(configPath), s.apns.key_file || 'AuthKey.p8'), 'utf8');
    apns = new Apns({ teamId: s.apns.team_id, keyId: s.apns.key_id, bundleId: s.apns.bundle_id, keyPem, sandbox: !!s.apns.sandbox });
  } else console.warn('No server.apns settings: giveaways will be detected but no notifications can be sent.');
  const app = createApp({ store, platforms: new Platforms(store), apns, dataDir: process.env.DATA_DIR || path.join(here, 'data') });
  const tgToken = process.env.TELEGRAM_BOT_TOKEN || s.telegram?.bot_token;
  let telegram = null;
  if (tgToken) {
    const dataDir = process.env.DATA_DIR || path.join(here, 'data');
    telegram = new Telegram({ token: tgToken, apiKey: s.api_key, dataDir, account: s.telegram?.account || null,
      enter: (b) => app.enter(b), findHit: (id) => app.findHit(id), accounts: () => new Platforms(store).accounts(),
      onTest: () => app.handleHit({ channel: app.watchChannels()[0] || 'test', command: '!test', text: 'This is a test giveaway', user: 'server', test: true }),
      log: (m) => console.log(m) });
    app.attachTelegram(telegram);
    telegram.start();
    console.log(`Telegram alerts on (${telegram.linked ? 'chat linked' : 'waiting for /start in Telegram'}).`);
  } else console.log('Telegram alerts off (no TELEGRAM_BOT_TOKEN).');
  const channels = app.watchChannels();
  const watcher = new Watcher({ channels, onHit: (h) => app.handleHit(h).catch((e) => console.error('hit failed:', e.message)), onStatus: (t) => console.log('watcher:', t) });
  if (channels.length) watcher.start(); else console.warn('No Twitch channels to watch. Add creators to config.json or server.channels.');
  const port = Number(process.env.PORT || s.port || 8080);
  app.server.listen(port, () => console.log(`MultiChat phone server on port ${port}, watching: ${channels.join(', ') || '(nothing)'}`));
  const stop = () => { watcher.stop(); telegram?.stop(); apns?.close(); app.server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
// Start only when run directly (node server.js), not when the tests import it. Compare real paths so a
// symlinked folder (common on hosts and Macs) does not make the server silently do nothing.
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) main();

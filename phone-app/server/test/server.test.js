import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import http2 from 'node:http2';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore, Platforms } from '../platforms.js';
import { Apns } from '../apns.js';
import { createApp } from '../server.js';

const KEY = 'test-key-1234567890-abcdef';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcphone-'));
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(s.address().port)));

// ---- a fake Twitch + Kick + YouTube ----
function fakeApis() {
  const st = { live: { twitch: true, kick: true, youtube: true }, sent: [], refreshed: [], twitchDrop: false,
    valid: new Set(['tok-main', 'tok-alt', 'kick-main', 'yt-main']) };
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const u = new URL(req.url, 'http://x'); const p = u.pathname; const q = u.searchParams;
      const token = String(req.headers.authorization || '').replace('Bearer ', '');
      if (p.endsWith('-id/token')) {                                   // token refresh endpoints
        const f = new URLSearchParams(body);
        st.refreshed.push({ p, refresh_token: f.get('refresh_token'), client_id: f.get('client_id'), client_secret: f.get('client_secret') });
        st.valid.add('fresh-' + p.split('/')[1]);
        return json(res, 200, { access_token: 'fresh-' + p.split('/')[1], refresh_token: 'newrefresh-' + p.split('/')[1] });
      }
      if (!st.valid.has(token)) return json(res, 401, { error: 'expired' });
      if (p === '/twitch/users') return json(res, 200, { data: [{ id: q.get('login') ? 'B-' + q.get('login') : (token === 'tok-alt' ? 'U-alt' : 'U-main') }] });
      if (p === '/twitch/streams') return json(res, 200, { data: st.live.twitch ? [{ viewer_count: 5 }] : [] });
      if (p === '/twitch/chat/messages') {
        const b = JSON.parse(body); st.sent.push({ platform: 'twitch', token, ...b });
        return json(res, 200, { data: [st.twitchDrop ? { is_sent: false, drop_reason: { message: 'Your message could not be sent' } } : { is_sent: true }] });
      }
      if (p === '/kick/channels') return json(res, 200, { data: [{ broadcaster_user_id: 777, stream: { is_live: st.live.kick } }] });
      if (p === '/kick/chat') { const b = JSON.parse(body); st.sent.push({ platform: 'kick', token, ...b }); return json(res, 200, { data: { is_sent: true } }); }
      if (p === '/yt/channels') return json(res, 200, { items: [{ id: 'UCxyz' }] });
      if (p === '/yt/search') return json(res, 200, { items: st.live.youtube ? [{ id: { videoId: 'vid1' } }] : [] });
      if (p === '/yt/videos') return json(res, 200, { items: [{ liveStreamingDetails: { activeLiveChatId: 'chat1' } }] });
      if (p === '/yt/liveChat/messages') { const b = JSON.parse(body); st.sent.push({ platform: 'youtube', token, chat: b.snippet.liveChatId, text: b.snippet.textMessageDetails.messageText }); return json(res, 200, {}); }
      return json(res, 404, {});
    });
  });
  return { server, st };
}

// ---- a fake Apple push server ----
function fakeApns() {
  const seen = [];
  const server = http2.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ path: req.headers[':path'], payload: JSON.parse(body) });
      const dead = req.headers[':path'].endsWith('dead00');
      res.writeHead(dead ? 410 : 200, { 'content-type': 'application/json' });
      res.end(dead ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  return { server, seen };
}

const openApps = [];
after(() => openApps.forEach((c) => c()));      // always shut servers down, even when a test fails

async function setup({ withApns = true } = {}) {
  const api = fakeApis(), aps = fakeApns();
  const [apiPort, apnsPort] = [await listen(api.server), await listen(aps.server)];
  const b = `http://127.0.0.1:${apiPort}`;
  const urls = { twitchApi: b + '/twitch', twitchId: b + '/twitch-id/token', kickApi: b + '/kick', kickId: b + '/kick-id/token', ytApi: b + '/yt', ytId: b + '/yt-id/token' };
  const dir = tmp(), cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    twitch: { enabled: true, channel: 'x', client_id: 'twitch-app', access_token: 'tok-main', refresh_token: 'r-main' },
    twitch_app: { client_id: 'twitch-app' },
    kick: { client_id: 'kick-app', client_secret: 'kick-secret', access_token: 'kick-main', refresh_token: 'rk' },
    youtube: { client_id: 'yt-app', client_secret: 'yt-secret', access_token: 'yt-main', refresh_token: 'ry' },
    accounts: { Alt1: { twitch: { access_token: 'tok-alt', refresh_token: 'r-alt' } } },   // an alt with only a Twitch login
    creators: { Kreek: { twitch: 'KreekCraft', kick: 'kreek', youtube: 'kreekcraft' }, Solo: { twitch: 'solo', kick: '', youtube: '' } },
    server: { api_key: KEY, live_only: true },
  }));
  const store = new ConfigStore(cfgPath);
  const apns = withApns ? new Apns({ teamId: 'T', keyId: 'K', bundleId: 'b', url: `http://127.0.0.1:${apnsPort}`,
    keyPem: crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) }) : null;
  const app = createApp({ store, platforms: new Platforms(store, { urls }), apns, dataDir: path.join(dir, 'data'), log: () => {} });
  const port = await listen(app.server);
  const call = async (method, p, body, key = KEY) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const close = () => { app.server.close(); api.server.close(); aps.server.close(); apns?.close(); };
  openApps.push(close);
  return { app, api, aps, call, store, cfgPath, close };
}

test('auth: wrong or missing key is refused, /health is open, repeated wrong keys get locked out', async () => {
  const t = await setup();
  assert.equal((await t.call('GET', '/health', null, 'nope')).status, 200);
  assert.equal((await t.call('GET', '/hits', null, 'nope')).status, 401);
  assert.equal((await t.call('GET', '/hits', null, '')).status, 401);
  for (let i = 0; i < 9; i++) await t.call('GET', '/hits', null, 'wrong' + i);
  assert.equal((await t.call('GET', '/hits', null, KEY)).status, 429, 'locked out after 10 wrong keys, even the right one');
  t.close();
});

test('register + giveaway hit -> push with the right alert, category and data; dead phones are forgotten', async () => {
  const t = await setup();
  assert.equal((await t.call('POST', '/register', { deviceToken: 'zz' })).status, 400);
  await t.call('POST', '/register', { deviceToken: 'ABCDEF0123456789ABCDEF0123456789' });
  await t.call('POST', '/register', { deviceToken: 'dead00dead00dead00dead00dead00dead00' });
  t.aps.seen.length = 0;
  const rec = await t.app.handleHit({ channel: 'kreekcraft', command: '!potato', text: 'Type !potato to enter', user: 'kreekcraft' });
  assert.equal(t.aps.seen.length, 2);
  const p = t.aps.seen[0].payload;
  assert.equal(p.aps.alert.title, 'Giveaway on Kreek');
  assert.equal(p.aps.alert.body, 'Type !potato to enter');
  assert.equal(p.aps.category, 'GIVEAWAY_WORD');
  assert.equal(p.aps['interruption-level'], undefined, 'time-sensitive is opt-in (needs an Apple capability)');
  assert.deepEqual([p.hit.id, p.hit.command, p.hit.creator], [rec.id, '!potato', 'Kreek']);
  assert.equal(t.app.devices.length, 1, 'the phone Apple says is gone was removed');
  t.aps.seen.length = 0;
  await t.app.handleHit({ channel: 'kreekcraft', command: null, text: 'giveaway now!', user: 'kreekcraft' });
  assert.equal(t.aps.seen[0].payload.aps.category, 'GIVEAWAY_TYPE');
  t.store.data.server.time_sensitive = true; t.aps.seen.length = 0;
  await t.app.handleHit({ channel: 'kreekcraft', command: '!b', text: 'giveaway', user: 'k' });
  assert.equal(t.aps.seen[0].payload.aps['interruption-level'], 'time-sensitive');
  t.close();
});

test('enter: one account, every live platform, right ids and tokens', async () => {
  const t = await setup();
  const rec = await t.app.handleHit({ channel: 'kreekcraft', command: '!potato', text: 'x', user: 'k' });
  const r = await t.call('POST', '/enter', { hitId: rec.id, word: '!potato', account: 'Main' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.fromEntries(Object.entries(r.body.results).map(([k, v]) => [k, v.status])), { twitch: 'sent', kick: 'sent', youtube: 'sent' });
  const by = Object.fromEntries(t.api.st.sent.map((s) => [s.platform, s]));
  assert.equal(by.twitch.broadcaster_id, 'B-kreekcraft'); assert.equal(by.twitch.sender_id, 'U-main'); assert.equal(by.twitch.message, '!potato');
  assert.equal(by.kick.broadcaster_user_id, 777); assert.equal(by.kick.content, '!potato');
  assert.equal(by.youtube.chat, 'chat1'); assert.equal(by.youtube.text, '!potato');
  assert.match(r.body.summary, /Entered as Main on Twitch, Kick, YouTube/);
  t.close();
});

test('enter: pressing twice never enters twice (idempotent)', async () => {
  const t = await setup();
  const body = { creator: 'Kreek', word: '!potato' };
  await t.call('POST', '/enter', body);
  const n = t.api.st.sent.length;
  const again = await t.call('POST', '/enter', body);
  assert.equal(t.api.st.sent.length, n);
  assert.deepEqual(Object.values(again.body.results).map((x) => x.status), ['already', 'already', 'already']);
  const [a, b] = await Promise.all([t.call('POST', '/enter', { creator: 'Solo', word: '!x' }), t.call('POST', '/enter', { creator: 'Solo', word: '!x' })]);
  assert.equal(t.api.st.sent.filter((s) => s.broadcaster_id === 'B-solo').length, 1, 'two taps at the same moment still enter once');
  t.close();
});

test('enter: a platform where the streamer is offline is skipped (Live only)', async () => {
  const t = await setup();
  t.api.st.live.kick = false;
  const r = await t.call('POST', '/enter', { creator: 'Kreek', word: '!potato' });
  assert.equal(r.body.results.kick.status, 'offline');
  assert.ok(!t.api.st.sent.some((s) => s.platform === 'kick'));
  assert.equal(r.body.results.twitch.status, 'sent');
  t.close();
});

test('enter: an account with no login on a platform fails clearly; retry only sends the failed ones', async () => {
  const t = await setup();
  const r = await t.call('POST', '/enter', { creator: 'Kreek', word: '!potato', account: 'Alt1' });
  assert.equal(r.body.results.twitch.status, 'sent');
  assert.equal(r.body.results.kick.status, 'failed'); assert.match(r.body.results.kick.detail, /Alt1 has no Kick login/);
  assert.equal(t.api.st.sent.find((s) => s.platform === 'twitch').sender_id, 'U-alt', 'sent as the alt, not as Main');
  const retry = await t.call('POST', '/enter', { creator: 'Kreek', word: '!potato', account: 'Main', platforms: ['kick', 'youtube'] });
  assert.deepEqual([retry.body.results.kick.status, retry.body.results.youtube.status], ['sent', 'sent']);
  assert.equal(t.api.st.sent.filter((s) => s.platform === 'twitch').length, 1, 'Twitch was not entered a second time');
  t.close();
});

test('enter: an expired token is refreshed once, the request retried, and config.json saved', async () => {
  const t = await setup();
  t.store.data.twitch.access_token = 'expired-token';
  const r = await t.call('POST', '/enter', { creator: 'Solo', word: '!potato' });
  assert.equal(r.body.results.twitch.status, 'sent');
  assert.equal(t.api.st.refreshed.length, 1);
  assert.deepEqual([t.api.st.refreshed[0].refresh_token, t.api.st.refreshed[0].client_id], ['r-main', 'twitch-app']);
  const disk = JSON.parse(fs.readFileSync(t.cfgPath, 'utf8'));
  assert.equal(disk.twitch.access_token, 'fresh-twitch-id'); assert.equal(disk.twitch.refresh_token, 'newrefresh-twitch-id');
  assert.equal(disk.kick.access_token, 'kick-main', 'other logins untouched');
  assert.equal(disk.server.api_key, KEY, 'server settings kept');
  t.close();
});

test('enter: Twitch silently dropping the message is reported, and can be tried again', async () => {
  const t = await setup();
  t.api.st.twitchDrop = true;
  const r = await t.call('POST', '/enter', { creator: 'Solo', word: '!potato' });
  assert.equal(r.body.results.twitch.status, 'failed'); assert.match(r.body.results.twitch.detail, /dropped by Twitch: Your message could not be sent/);
  t.api.st.twitchDrop = false;
  assert.equal((await t.call('POST', '/enter', { creator: 'Solo', word: '!potato' })).body.results.twitch.status, 'sent');
  t.close();
});

test('enter: bad input is refused and sends nothing; test hits never send', async () => {
  const t = await setup();
  for (const body of [{ creator: 'Kreek', word: '' }, { creator: 'Kreek', word: 'a\nb' }, { creator: 'Kreek', word: 'x'.repeat(101) },
    { creator: 'Kreek', word: '!x', account: 'Nobody' }, { creator: 'Nobody', word: '!x' }, { word: '!x' }]) {
    assert.equal((await t.call('POST', '/enter', body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  const test = await t.call('POST', '/test-push');
  const r = await t.call('POST', '/enter', { hitId: test.body.hit.id, word: '!test' });
  assert.equal(r.body.test, true);
  assert.equal(t.api.st.sent.length, 0);
  t.close();
});

test('accounts + hits endpoints', async () => {
  const t = await setup();
  await t.app.handleHit({ channel: 'solo', command: '!a', text: 'giveaway', user: 'solo' });
  const a = (await t.call('GET', '/accounts')).body;
  assert.deepEqual(a.accounts.map((x) => [x.name, x.platforms]), [['Main', ['twitch', 'kick', 'youtube']], ['Alt1', ['twitch']]]);
  assert.deepEqual(a.creators.map((c) => c.name), ['Kreek', 'Solo']);
  assert.equal((await t.call('GET', '/hits')).body.hits[0].creator, 'Solo');
  assert.deepEqual(t.app.watchChannels(), ['kreekcraft', 'solo']);
  t.close();
});

test('the server never reads the video and never posts chat on its own: a hit alone sends nothing', async () => {
  const t = await setup();
  await t.app.handleHit({ channel: 'kreekcraft', command: '!potato', text: 'Type !potato to enter', user: 'kreekcraft' });
  assert.equal(t.api.st.sent.length, 0);
  t.close();
});

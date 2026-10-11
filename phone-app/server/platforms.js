// Twitch / Kick / YouTube: live checks, sending, automatic token refresh.
// Ported from multichat.py. Uses the same data/config.json layout as the desktop app.
import fs from 'node:fs';

export const PLATFORMS = ['twitch', 'kick', 'youtube'];
export const LABEL = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube' };
export const DEFAULT_URLS = {
  twitchApi: 'https://api.twitch.tv/helix', twitchId: 'https://id.twitch.tv/oauth2/token',
  kickApi: 'https://api.kick.com/public/v1', kickId: 'https://id.kick.com/oauth/token',
  ytApi: 'https://www.googleapis.com/youtube/v3', ytId: 'https://oauth2.googleapis.com/token',
};

// config.json, kept in memory; saved (atomically) whenever a token is refreshed.
export class ConfigStore {
  constructor(path) { this.path = path; this.data = JSON.parse(fs.readFileSync(path, 'utf8')); }
  save() {
    const tmp = this.path + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.path);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Platforms {
  constructor(store, { fetchImpl = fetch, urls = DEFAULT_URLS } = {}) {
    this.store = store; this.fetch = fetchImpl; this.u = urls;
    this.ids = new Map();            // cached lookups: twitch/kick channel ids, YouTube chat ids
    this.refreshing = new WeakMap(); // cfg object -> refresh in progress
    this.senders = new WeakMap();    // cfg object -> Twitch user id of that login
  }

  accounts() {                       // [{name, platforms:[...]}], Main first
    const d = this.store.data;
    const list = [{ name: 'Main', platforms: PLATFORMS.filter((p) => d[p]?.access_token) }];
    for (const [name, secs] of Object.entries(d.accounts || {})) {
      const ps = PLATFORMS.filter((p) => secs?.[p]?.access_token);
      if (ps.length) list.push({ name, platforms: ps });
    }
    return list;
  }

  cfg(account, platform) {
    const d = this.store.data;
    const c = !account || account === 'Main' ? d[platform] : d.accounts?.[account]?.[platform];
    return c?.access_token ? c : undefined;
  }

  clientId(platform, cfg) {
    const d = this.store.data;
    return cfg.client_id || (platform === 'twitch' ? d.twitch?.client_id || d.twitch_app?.client_id : undefined);
  }

  async http(url, opts = {}) {
    return this.fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
  }

  // Swap the refresh token for a new access token and save it.
  async refresh(platform, cfg) {
    const url = { twitch: this.u.twitchId, kick: this.u.kickId, youtube: this.u.ytId }[platform];
    const cid = this.clientId(platform, cfg);
    if (!cfg.refresh_token || !cid) return false;
    if (this.refreshing.has(cfg)) return this.refreshing.get(cfg);
    const job = (async () => {
      const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refresh_token, client_id: cid });
      if (cfg.client_secret) body.set('client_secret', cfg.client_secret);
      const r = await this.http(url, { method: 'POST', body });
      if (!r.ok) throw new Error(`token refresh failed (${r.status})`);
      const tok = await r.json();
      cfg.access_token = tok.access_token;
      if (tok.refresh_token) cfg.refresh_token = tok.refresh_token;
      this.store.save();
      return true;
    })();
    this.refreshing.set(cfg, job);
    try { return await job; } finally { this.refreshing.delete(cfg); }
  }

  // Run a request; if the token was rejected (401), refresh once and run it again.
  async call(platform, cfg, build) {
    let r = await build(cfg.access_token);
    if (r.status === 401 && (await this.refresh(platform, cfg).catch(() => false))) r = await build(cfg.access_token);
    return r;
  }

  async json(platform, cfg, build) {
    const r = await this.call(platform, cfg, build);
    if (!r.ok) throw new Error(`${LABEL[platform]} ${r.status}: ${(await r.text()).slice(0, 150)}`);
    return r.json();
  }

  // ---------- lookups (cached) ----------
  async twitchHeaders(cfg, token) { return { Authorization: `Bearer ${token}`, 'Client-Id': this.clientId('twitch', cfg) }; }

  async twitchBroadcaster(login) {
    const key = `twitch:${login}`;
    if (this.ids.has(key)) return this.ids.get(key);
    const main = this.cfg('Main', 'twitch');
    if (!main) throw new Error('Twitch is not logged in on the server');
    const j = await this.json('twitch', main, async (t) => this.http(`${this.u.twitchApi}/users?login=${encodeURIComponent(login)}`, { headers: await this.twitchHeaders(main, t) }));
    const id = j.data?.[0]?.id;
    if (!id) throw new Error(`Twitch channel '${login}' not found`);
    this.ids.set(key, id);
    return id;
  }

  async twitchSender(cfg) {
    if (this.senders.has(cfg)) return this.senders.get(cfg);
    const j = await this.json('twitch', cfg, async (t) => this.http(`${this.u.twitchApi}/users`, { headers: await this.twitchHeaders(cfg, t) }));
    const id = j.data?.[0]?.id;
    if (!id) throw new Error('Twitch did not say who this login is');
    this.senders.set(cfg, id);
    return id;
  }

  async kickChannel(slug) {
    const main = this.cfg('Main', 'kick');
    if (!main) throw new Error('Kick is not logged in on the server');
    const j = await this.json('kick', main, (t) => this.http(`${this.u.kickApi}/channels?slug=${encodeURIComponent(slug)}`, { headers: { Authorization: `Bearer ${t}` } }));
    const ch = j.data?.[0];
    if (!ch) throw new Error(`Kick channel '${slug}' not found`);
    return ch;
  }

  async kickBroadcaster(slug) {
    const key = `kick:${slug}`;
    if (!this.ids.has(key)) this.ids.set(key, (await this.kickChannel(slug)).broadcaster_user_id);
    return this.ids.get(key);
  }

  // YouTube: the live chat id of the channel's current stream, or null when it is not live.
  async youtubeChatId(handle) {
    const key = `yt:${handle}`;
    const hit = this.ids.get(key);
    if (hit && Date.now() - hit.at < (hit.id ? 600000 : 120000)) return hit.id;
    const main = this.cfg('Main', 'youtube');
    if (!main) throw new Error('YouTube is not logged in on the server');
    const get = (path, q) => this.json('youtube', main, (t) => this.http(`${this.u.ytApi}/${path}?${new URLSearchParams(q)}`, { headers: { Authorization: `Bearer ${t}` } }));
    const ch = await get('channels', { part: 'id', forHandle: handle.replace(/^@/, '') });
    const channelId = ch.items?.[0]?.id;
    if (!channelId) throw new Error(`YouTube channel '@${handle}' not found`);
    const live = await get('search', { part: 'id', channelId, eventType: 'live', type: 'video' });   // 100 quota units
    const vid = live.items?.[0]?.id?.videoId;
    let id = null;
    if (vid) {
      const v = await get('videos', { part: 'liveStreamingDetails', id: vid });
      id = v.items?.[0]?.liveStreamingDetails?.activeLiveChatId || null;
    }
    this.ids.set(key, { id, at: Date.now() });
    return id;
  }

  // ---------- is the streamer live there? true / false / null (could not tell) ----------
  async isLive(platform, channel) {
    try {
      const main = this.cfg('Main', platform);
      if (!main) return null;
      if (platform === 'twitch') {
        const id = await this.twitchBroadcaster(channel);
        const j = await this.json('twitch', main, async (t) => this.http(`${this.u.twitchApi}/streams?user_id=${id}`, { headers: await this.twitchHeaders(main, t) }));
        return (j.data || []).length > 0;
      }
      if (platform === 'kick') {
        const ch = await this.kickChannel(channel);
        if (!('stream' in ch)) return null;
        return !!ch.stream?.is_live;
      }
      if (platform === 'youtube') return !!(await this.youtubeChatId(channel));
    } catch { /* fall through */ }
    return null;
  }

  // ---------- send one message as ONE account ----------
  async send(platform, account, channel, text) {
    const cfg = this.cfg(account, platform);
    if (!cfg) return { ok: false, detail: `${account} has no ${LABEL[platform]} login` };
    try {
      if (platform === 'twitch') {
        const [broadcaster, sender] = [await this.twitchBroadcaster(channel), await this.twitchSender(cfg)];
        const r = await this.call('twitch', cfg, async (t) => this.http(`${this.u.twitchApi}/chat/messages`, {
          method: 'POST', headers: { ...(await this.twitchHeaders(cfg, t)), 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcaster_id: broadcaster, sender_id: sender, message: text.slice(0, 500) }) }));
        if (!r.ok) return { ok: false, detail: `FAILED ${r.status}: ${(await r.text()).slice(0, 150)}` };
        const item = (await r.json().catch(() => ({}))).data?.[0];
        if (item?.is_sent === false) {
          const why = item.drop_reason || {};
          return { ok: false, detail: `dropped by Twitch: ${why.message || why.code || 'no reason given'}` };
        }
        return { ok: true };
      }
      if (platform === 'kick') {
        const id = await this.kickBroadcaster(channel);
        const r = await this.call('kick', cfg, (t) => this.http(`${this.u.kickApi}/chat`, {
          method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ broadcaster_user_id: id, content: text.slice(0, 500), type: 'user' }) }));
        if (!r.ok) return { ok: false, detail: `FAILED ${r.status}: ${(await r.text()).slice(0, 150)}` };
        const data = (await r.json().catch(() => ({}))).data;
        const item = Array.isArray(data) ? data[0] : data;
        if (item && typeof item === 'object' && item.is_sent === false) return { ok: false, detail: 'dropped by Kick (message was not delivered)' };
        return { ok: true };
      }
      if (platform === 'youtube') {
        const chat = await this.youtubeChatId(channel);
        if (!chat) return { ok: false, detail: 'not live on YouTube' };
        const r = await this.call('youtube', cfg, (t) => this.http(`${this.u.ytApi}/liveChat/messages?part=snippet`, {
          method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ snippet: { liveChatId: chat, type: 'textMessageEvent', textMessageDetails: { messageText: text.slice(0, 200) } } }) }));
        return r.ok ? { ok: true } : { ok: false, detail: `FAILED ${r.status}: ${(await r.text()).slice(0, 150)}` };
      }
    } catch (e) {
      return { ok: false, detail: String(e.message || e) };
    }
    return { ok: false, detail: 'unknown platform' };
  }
}

export { sleep };

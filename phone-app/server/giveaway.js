// Giveaway detection + a read-only Twitch chat watcher. Same rules as the desktop app (giveaway.py).
// It only reads chat text. It never sends anything to chat.
import tls from 'node:tls';
import net from 'node:net';
import { randomInt } from 'node:crypto';

export const KNOWN_BOTS = new Set(['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot',
  'wizebot', 'sery_bot', 'pretzelrocks']);
const CUES = ['giveaway', 'give away', 'raffle', 'to enter', 'enter with', 'type !', 'use !',
  '!enter', '!join', '!raffle', '!giveaway', '!entry'];
const DONE = ['winner', 'winners', 'congrats', 'congratulations', 'has ended', 'have ended',
  'is over', 'closed', 'no longer', 'ended', 'drawn', 'picked'];
export const NOT_ENTRY = new Set(['!discord', '!socials', '!lurk', '!uptime', '!commands', '!so', '!youtube',
  '!twitter', '!instagram', '!tiktok', '!sub', '!subscribe', '!follow', '!prime', '!hug', '!game', '!song',
  '!rules', '!giveaways', '!unlurk', '!sr', '!songrequest', '!play', '!rank', '!points', '!watchtime',
  '!followage', '!clip', '!vote', '!gg', '!lul', '!bet', '!gamble', '!duel', '!fish', '!help', '!time',
  '!specs', '!merch', '!shop', '!donate', '!tip', '!fact']);
export const CROWD_USERS = 3;
export const CROWD_SECONDS = 30;

const CMD_FIND = /(?<![\w!])(![A-Za-z0-9_]{2,25})/g;
const CMD_FULL = /^![A-Za-z0-9_]{2,25}$/;

// One raw IRC line -> {tags, user, channel, text}, or null if it is not a chat message.
export function parseLine(line) {
  const tags = {};
  if (line.startsWith('@')) {
    const sp = line.indexOf(' ');
    if (sp < 0) return null;
    for (const part of line.slice(1, sp).split(';')) {
      const eq = part.indexOf('=');
      tags[eq < 0 ? part : part.slice(0, eq)] = eq < 0 ? '' : part.slice(eq + 1);
    }
    line = line.slice(sp + 1);
  }
  if (!line.startsWith(':')) return null;
  const sp = line.indexOf(' ');
  if (sp < 0) return null;
  const prefix = line.slice(1, sp);
  const rest = line.slice(sp + 1);
  if (!rest.startsWith('PRIVMSG ')) return null;
  const body = rest.slice('PRIVMSG '.length);
  const sep = body.indexOf(' :');
  if (sep < 0) return null;
  return { tags, user: prefix.split('!')[0].toLowerCase(),
    channel: body.slice(0, sep).replace(/^#/, '').toLowerCase(), text: body.slice(sep + 2).trim() };
}

// Only the streamer, their moderators, or a known giveaway bot can announce one.
export function trusted(msg) {
  const badges = msg.tags.badges || '';
  return KNOWN_BOTS.has(msg.user) || msg.tags.mod === '1' ||
    badges.includes('broadcaster/') || badges.includes('moderator/');
}

// null, or {user, command, text}. command is null when the word is probably only shown on the stream.
export function detect(msg) {
  if (!msg || !trusted(msg)) return null;
  const low = msg.text.toLowerCase();
  if (!CUES.some((c) => low.includes(c))) return null;
  if (DONE.some((d) => low.includes(d))) return null;
  const cmds = (msg.text.match(CMD_FIND) || []).filter((c) => !NOT_ENTRY.has(c.toLowerCase()));
  if (cmds.length) return { user: msg.user, command: cmds[0], text: msg.text };
  if ((low.includes('giveaway') || low.includes('raffle')) &&
      ['now', 'live', 'starting', 'started', 'enter', 'open', 'win'].some((w) => low.includes(w))) {
    return { user: msg.user, command: null, text: msg.text };
  }
  return null;
}

// Several DIFFERENT viewers typing the same bare !word in a short time looks like a giveaway.
export class Crowd {
  constructor(users = CROWD_USERS, seconds = CROWD_SECONDS) { this.users = users; this.seconds = seconds; this.typed = new Map(); }
  feed(msg, now = Date.now() / 1000) {
    if (!msg) return null;
    const text = msg.text.trim();
    const cmd = text.toLowerCase();
    if (!CMD_FULL.test(text) || NOT_ENTRY.has(cmd) || KNOWN_BOTS.has(msg.user)) return null;
    const key = `${msg.channel}|${cmd}`;
    let seen = this.typed.get(key);
    if (!seen) { seen = new Map(); this.typed.set(key, seen); }
    seen.set(msg.user, now);
    for (const [u, t] of seen) if (now - t > this.seconds) seen.delete(u);
    if (seen.size >= this.users) {
      seen.clear();
      return { user: 'chat', command: text, text: `${this.users}+ viewers just typed ${text} in chat`, crowd: true };
    }
    return null;
  }
}

// Watches several Twitch channels on one anonymous (read-only) connection.
export class Watcher {
  constructor({ channels, onHit, onStatus = () => {}, host = 'irc.chat.twitch.tv', port = 6697,
    useTls = true, cooldown = 180 }) {
    this.channels = [...new Set(channels.map((c) => c.toLowerCase().replace(/^#/, '')))];
    Object.assign(this, { onHit, onStatus, host, port, useTls, cooldown });
    this.crowd = new Crowd();
    this.seen = new Map();
    this.stopped = false;
    this.sock = null;
    this.delay = 2000;
    this.timer = null;
  }
  start() { this.stopped = false; this.#connect(); }
  stop() { this.stopped = true; clearTimeout(this.timer); this.sock?.destroy(); }
  #fresh(hit) {
    const key = `${hit.channel}|${(hit.command || hit.text.slice(0, 40)).toLowerCase()}`;
    const now = Date.now();
    if (now - (this.seen.get(key) || 0) < this.cooldown * 1000) return false;
    this.seen.set(key, now);
    return true;
  }
  #connect() {
    if (this.stopped || !this.channels.length) return;
    const onConnect = () => {
      const nick = `justinfan${randomInt(10000, 99999)}`;    // Twitch's read-only anonymous login
      s.write(['CAP REQ :twitch.tv/tags', 'PASS SCHMOOPIIE', `NICK ${nick}`,
        ...this.#joins()].join('\r\n') + '\r\n');
      this.delay = 2000;
      this.onStatus(`watching ${this.channels.length} channel(s) for giveaways`);
    };
    const s = this.useTls ? tls.connect({ host: this.host, port: this.port, servername: this.host }, onConnect)
                          : net.connect({ host: this.host, port: this.port }, onConnect);
    this.sock = s;
    s.setTimeout(120000, () => s.destroy(new Error('idle')));
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (line.startsWith('PING')) { s.write('PONG :tmi.twitch.tv\r\n'); continue; }
        const msg = parseLine(line);
        const hit = detect(msg) || this.crowd.feed(msg);
        if (hit && msg) { hit.channel = msg.channel; if (this.#fresh(hit)) this.onHit(hit); }
      }
    });
    const again = (why) => {
      if (this.stopped) return;
      this.onStatus(`lost connection (${why}); retrying`);
      this.timer = setTimeout(() => this.#connect(), this.delay);
      this.delay = Math.min(this.delay * 2, 60000);
    };
    s.on('error', (e) => { this.#dead = true; again(e.message); });
    s.on('close', () => { if (!this.#dead) again('closed'); this.#dead = false; });
  }
  #dead = false;
  #joins() {                        // JOIN in groups so one line never gets too long
    const out = [];
    for (let i = 0; i < this.channels.length; i += 20) {
      out.push('JOIN ' + this.channels.slice(i, i + 20).map((c) => '#' + c).join(','));
    }
    return out;
  }
}

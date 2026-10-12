// Telegram alerts for MultiChat: sends a message with an [Enter !word] button when a giveaway shows up in chat.
// Nothing is sent to a stream chat until YOU tap the button (or reply with the word).
// Uses long polling, so it works on any host with no extra setup. Only the chat you link with
// "/start <server key>" is ever answered; everybody else is ignored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

export class Telegram {
  constructor({ token, apiKey, dataDir, enter, findHit, accounts, account = null, onTest = null,
                base = 'https://api.telegram.org', log = console.log }) {
    Object.assign(this, { token, apiKey, dataDir, enter, findHit, accounts, account, onTest, base, log });
    this.file = path.join(dataDir, 'telegram.json');
    this.state = this.#load();                 // { chatId }
    this.msgToHit = new Map();                 // telegram message id -> hit id (so you can reply with the word)
    this.stopped = false;
    this.offset = 0;
  }
  #load() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return {}; } }
  #save() { fs.mkdirSync(this.dataDir, { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 }); }
  get linked() { return !!this.state.chatId; }

  async api(method, body = {}, timeoutMs = 15000) {
    const r = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`);
    return j.result;
  }
  say(chat_id, text, extra = {}) { return this.api('sendMessage', { chat_id, text, ...extra }).catch((e) => this.log(e.message)); }
  #who() { return this.account || this.accounts()[0]?.name || 'Main'; }

  // ---- outgoing: a giveaway was found ----
  async notify(rec) {
    if (!this.linked) return { sent: 0 };
    const known = !!rec.command;
    const head = rec.test ? 'TEST giveaway' : rec.crowd ? `Maybe a giveaway on ${rec.creator}` : `Giveaway on ${rec.creator}`;
    const body = rec.test ? 'Tap Enter to try it. Nothing is sent to chat.'
      : known ? (rec.crowd ? `Chat is typing ${rec.command}` : `Type ${rec.command} to enter`)
              : 'The word is probably only on the stream. Look at it, then REPLY to this message with the word to enter.';
    const kb = known ? { inline_keyboard: [[{ text: `Enter ${rec.command}`, callback_data: `e:${rec.id}` },
                                            { text: 'Skip', callback_data: `d:${rec.id}` }]] } : undefined;
    try {
      const m = await this.api('sendMessage', { chat_id: this.state.chatId, text: `${head}\n${body}\nAs: ${this.#who()}`, reply_markup: kb });
      this.msgToHit.set(m.message_id, rec.id);
      if (this.msgToHit.size > 200) this.msgToHit.delete(this.msgToHit.keys().next().value);
      return { sent: 1 };
    } catch (e) { this.log(e.message); return { sent: 0 }; }
  }

  // ---- incoming ----
  async handle(u) {
    if (u.callback_query) return this.#button(u.callback_query);
    const m = u.message;
    if (!m || typeof m.text !== 'string') return;
    const chat = m.chat?.id, text = m.text.trim();
    if (text.startsWith('/start')) {
      const given = text.slice(6).trim();
      if (this.linked) return chat === this.state.chatId ? this.say(chat, 'Already linked. Giveaway alerts will show up here. /test sends a test.') : undefined;
      if (given && safeEqual(given, this.apiKey)) {
        this.state.chatId = chat; this.#save();
        return this.say(chat, 'Linked. Giveaway alerts will show up here with an Enter button.\nDelete your /start message so the key is not left in this chat.\n/test sends a test alert.');
      }
      return this.say(chat, 'To link this chat, send:  /start YOUR-SERVER-KEY');
    }
    if (!this.linked || chat !== this.state.chatId) return;           // strangers get no answer at all
    if (text === '/test') return this.onTest ? this.onTest() : undefined;
    const hitId = m.reply_to_message && this.msgToHit.get(m.reply_to_message.message_id);
    if (hitId && text && !text.startsWith('/')) {
      const [, out] = await this.enter({ hitId, word: text, account: this.#who() });
      return this.say(chat, out.summary || out.error || 'Done.', { reply_to_message_id: m.message_id });
    }
    return this.say(chat, 'I send giveaway alerts here. Tap Enter on an alert, or reply to one with the word. /test sends a test.');
  }

  async #button(q) {
    const chat = q.message?.chat?.id;
    if (!this.linked || chat !== this.state.chatId) return this.api('answerCallbackQuery', { callback_query_id: q.id }).catch(() => {});
    const [kind, id] = String(q.data || '').split(':');
    const clear = () => this.api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
    if (kind === 'd') { await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'Skipped' }).catch(() => {}); return clear(); }
    if (kind !== 'e') return;
    const rec = this.findHit(id);
    if (!rec || !rec.command) { await this.api('answerCallbackQuery', { callback_query_id: q.id, text: 'That alert is too old.' }).catch(() => {}); return clear(); }
    const [, out] = await this.enter({ hitId: id, word: rec.command, account: this.#who() });
    const summary = out.summary || out.error || 'Done.';
    await this.api('answerCallbackQuery', { callback_query_id: q.id, text: summary.slice(0, 190) }).catch(() => {});
    await clear();
    return this.say(chat, summary, { reply_to_message_id: q.message.message_id });
  }

  // ---- polling loop ----
  start() {
    this.stopped = false;
    (async () => {
      let delay = 2000;
      while (!this.stopped) {
        try {
          const ups = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
          delay = 2000;
          for (const u of ups) {
            this.offset = u.update_id + 1;
            try { await this.handle(u); } catch (e) { this.log('telegram handler: ' + e.message); }
          }
        } catch (e) {
          if (this.stopped) break;
          this.log(`telegram: ${e.message}; retrying`);
          await new Promise((r) => setTimeout(r, delay)); delay = Math.min(delay * 2, 60000);
        }
      }
    })();
  }
  stop() { this.stopped = true; }
}

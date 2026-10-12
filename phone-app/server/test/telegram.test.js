import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Telegram } from '../telegram.js';

const KEY = 'server-key-1234567890-abcdef';
const closers = [];
after(() => closers.forEach((c) => c()));

// a fake Telegram Bot API that records what the bot sends
function fakeTelegram() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const b = body ? JSON.parse(body) : {};
      calls.push({ method, ...b });
      const result = method === 'sendMessage' ? { message_id: 100 + calls.length } : true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    closers.push(() => server.close());
    r({ server, calls, base: `http://127.0.0.1:${server.address().port}` });
  }));
}

async function setup() {
  const tg = await fakeTelegram();
  const entered = [];
  const hits = [{ id: 'h1', command: '!potato', creator: 'Kreek', channel: 'kreekcraft' }, { id: 'h2', command: null, creator: 'Solo', channel: 'solo' }];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mctg-'));
  const bot = new Telegram({ token: 'T0K', apiKey: KEY, dataDir: dir, base: tg.base, log: () => {},
    accounts: () => [{ name: 'Main' }, { name: 'Alt1' }],
    findHit: (id) => hits.find((h) => h.id === id),
    enter: async (b) => { entered.push(b); return [200, { summary: `Entered as ${b.account}.` }]; } });
  return { bot, tg, entered, dir, sent: () => tg.calls.filter((c) => c.method === 'sendMessage') };
}
const msg = (chat, text, extra = {}) => ({ update_id: 1, message: { message_id: 7, chat: { id: chat }, text, ...extra } });

test('linking: only /start with the right key links; wrong key and strangers get nothing useful', async () => {
  const t = await setup();
  await t.bot.handle(msg(5, '/start wrong-key'));
  assert.equal(t.bot.linked, false);
  assert.match(t.sent()[0].text, /To link this chat/);
  await t.bot.handle(msg(5, '/start ' + KEY));
  assert.equal(t.bot.linked, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(t.dir, 'telegram.json'), 'utf8')).chatId, 5);
  const n = t.sent().length;
  await t.bot.handle(msg(99, '/start ' + KEY));              // a different chat tries to take over
  await t.bot.handle(msg(99, '/test'));
  assert.equal(t.sent().length, n, 'a stranger gets no reply');
  assert.equal(t.bot.state.chatId, 5, 'link did not change');
});

test('a hit with a word sends an Enter button; unlinked bot sends nothing', async () => {
  const t = await setup();
  assert.deepEqual(await t.bot.notify({ id: 'h1', command: '!potato', creator: 'Kreek' }), { sent: 0 });
  await t.bot.handle(msg(5, '/start ' + KEY));
  t.tg.calls.length = 0;
  await t.bot.notify({ id: 'h1', command: '!potato', creator: 'Kreek', text: 'x' });
  const m = t.sent()[0];
  assert.match(m.text, /Giveaway on Kreek/);
  assert.match(m.text, /Type !potato to enter/);
  assert.equal(m.reply_markup.inline_keyboard[0][0].callback_data, 'e:h1');
});

test('tapping Enter calls enter with the hit word and the first account; tapping Skip does not', async () => {
  const t = await setup();
  await t.bot.handle(msg(5, '/start ' + KEY));
  await t.bot.handle({ update_id: 2, callback_query: { id: 'q1', data: 'e:h1', message: { message_id: 50, chat: { id: 5 } } } });
  assert.deepEqual(t.entered, [{ hitId: 'h1', word: '!potato', account: 'Main' }]);
  assert.ok(t.tg.calls.some((c) => c.method === 'answerCallbackQuery' && /Entered as Main/.test(c.text)));
  await t.bot.handle({ update_id: 3, callback_query: { id: 'q2', data: 'd:h1', message: { message_id: 51, chat: { id: 5 } } } });
  assert.equal(t.entered.length, 1, 'Skip never enters');
});

test('a button tapped from another chat does nothing; an old alert is refused', async () => {
  const t = await setup();
  await t.bot.handle(msg(5, '/start ' + KEY));
  await t.bot.handle({ update_id: 2, callback_query: { id: 'q1', data: 'e:h1', message: { message_id: 50, chat: { id: 77 } } } });
  assert.equal(t.entered.length, 0);
  await t.bot.handle({ update_id: 3, callback_query: { id: 'q2', data: 'e:gone', message: { message_id: 51, chat: { id: 5 } } } });
  assert.equal(t.entered.length, 0);
  assert.ok(t.tg.calls.some((c) => c.method === 'answerCallbackQuery' && /too old/.test(c.text)));
});

test('word only on stream: reply to the alert with the word to enter', async () => {
  const t = await setup();
  await t.bot.handle(msg(5, '/start ' + KEY));
  t.tg.calls.length = 0;
  await t.bot.notify({ id: 'h2', command: null, creator: 'Solo', text: 'giveaway now' });
  const alertId = 100 + t.tg.calls.length;                    // fake assigns 100 + number of calls so far
  const sent = t.sent()[0];
  assert.equal(sent.reply_markup, undefined, 'no button without a word');
  await t.bot.handle(msg(5, 'banana', { reply_to_message: { message_id: alertId } }));
  assert.deepEqual(t.entered, [{ hitId: 'h2', word: 'banana', account: 'Main' }]);
  await t.bot.handle(msg(5, 'random chatter'));               // not a reply -> nothing entered
  assert.equal(t.entered.length, 1);
});

test('configured account is used', async () => {
  const t = await setup();
  t.bot.account = 'Alt1';
  await t.bot.handle(msg(5, '/start ' + KEY));
  await t.bot.handle({ update_id: 2, callback_query: { id: 'q1', data: 'e:h1', message: { message_id: 50, chat: { id: 5 } } } });
  assert.equal(t.entered[0].account, 'Alt1');
});

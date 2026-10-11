import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseLine, detect, Crowd, Watcher } from '../giveaway.js';

const line = (user, text, badges = '', mod = '0', chan = 'kreekcraft') =>
  `@badges=${badges};mod=${mod};display-name=${user} :${user}!${user}@${user}.tmi.twitch.tv PRIVMSG #${chan} :${text}`;
const viewer = (u, t, chan) => parseLine(line(u, t, '', '0', chan));
const cmd = (raw) => { const h = detect(parseLine(raw)); return h ? h.command : 'NONE'; };

test('announcements from the streamer, mods and bots are detected', () => {
  assert.equal(cmd(line('kreekcraft', 'Giveaway is live! Type !potato to enter', 'broadcaster/1')), '!potato');
  assert.equal(cmd(line('modguy', 'type !join to enter the giveaway', 'moderator/1', '1')), '!join');
  assert.equal(cmd(line('nightbot', 'Giveaway open: use !enter now')), '!enter');
});

test('viewers, winner messages, normal chat and non-chat lines are ignored', () => {
  assert.equal(cmd(line('viewer1', 'type !potato to enter the giveaway')), 'NONE');
  assert.equal(cmd(line('kreekcraft', 'Congrats to the giveaway winner!', 'broadcaster/1')), 'NONE');
  assert.equal(cmd(line('kreekcraft', 'welcome everyone', 'broadcaster/1')), 'NONE');
  assert.equal(cmd(line('kreekcraft', 'giveaway in our !discord too', 'broadcaster/1')), 'NONE');
  assert.equal(cmd(':tmi.twitch.tv 001 justinfan1 :Welcome'), 'NONE');
});

test('a word only shown on the stream still alerts, with no command', () => {
  assert.equal(cmd(line('kreekcraft', 'GIVEAWAY starting now, watch the screen!', 'broadcaster/1')), null);
});

test('crowd: needs 3 different viewers within 30s', () => {
  const c = new Crowd();
  assert.equal(c.feed(viewer('a', '!20'), 100), null);
  assert.equal(c.feed(viewer('a', '!20'), 101), null);       // same person twice counts once
  assert.equal(c.feed(viewer('b', '!20'), 102), null);
  const hit = c.feed(viewer('c', '!20'), 105);
  assert.equal(hit.command, '!20'); assert.equal(hit.crowd, true);
});

test('crowd: too slow, everyday commands, sentences and bots never alert', () => {
  let c = new Crowd(); c.feed(viewer('a', '!20'), 0); c.feed(viewer('b', '!20'), 0);
  assert.equal(c.feed(viewer('c', '!20'), 45), null);
  c = new Crowd(); for (const u of 'abcd') assert.equal(c.feed(viewer(u, '!lurk'), 1), null);
  c = new Crowd(); for (const u of 'abcd') assert.equal(c.feed(viewer(u, '!20 lol'), 1), null);
  c = new Crowd(); for (const u of ['nightbot', 'streamelements', 'fossabot']) assert.equal(c.feed(viewer(u, '!20'), 1), null);
});

test('crowd: counted per channel', () => {
  const c = new Crowd();
  c.feed(viewer('a', '!20', 'one'), 1); c.feed(viewer('b', '!20', 'two'), 1);
  assert.equal(c.feed(viewer('c', '!20', 'one'), 2), null);
});

test('watcher: joins every channel read-only, reports once, answers PING, never sends chat', async () => {
  const hits = [], received = [];
  const srv = net.createServer((s) => {
    s.on('data', (d) => received.push(d.toString()));
    setTimeout(() => {
      const send = (t) => s.write(t + '\r\n');
      send(line('kreekcraft', 'Type !potato to enter', 'broadcaster/1'));
      send(line('kreekcraft', 'Type !potato to enter', 'broadcaster/1'));     // repeat: must not alert twice
      for (const u of ['v1', 'v2', 'v3', 'v4']) send(line(u, '!20', '', '0', 'otherchan'));
      send('PING :tmi.twitch.tv');
    }, 200);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const w = new Watcher({ channels: ['KreekCraft', '#otherchan'], onHit: (h) => hits.push(h),
    host: '127.0.0.1', port: srv.address().port, useTls: false });
  w.start();
  await new Promise((r) => setTimeout(r, 900));
  w.stop(); srv.close();
  const all = received.join('');
  assert.match(all, /JOIN #kreekcraft,#otherchan/);
  assert.match(all, /NICK justinfan\d+/);
  assert.match(all, /PONG :tmi.twitch.tv/);
  assert.doesNotMatch(all, /PRIVMSG/);
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => [h.channel, h.command, !!h.crowd]), [['kreekcraft', '!potato', false], ['otherchan', '!20', true]]);
});

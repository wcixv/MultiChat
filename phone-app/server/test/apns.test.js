import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { Apns } from '../apns.js';

test('apns: signed ES256 token, correct headers/path/payload, dead-token statuses', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const seen = [];
  const srv = http2.createServer((req, res) => {
    let body = ''; req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ h: req.headers, body });
      const dead = req.headers[':path'].endsWith('dead');
      res.writeHead(dead ? 410 : 200, { 'content-type': 'application/json' });
      res.end(dead ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const apns = new Apns({ teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'win.multichat.giveaway',
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }), url: `http://127.0.0.1:${srv.address().port}` });
  const ok = await apns.push('abcd1234', { aps: { alert: 'hi' } }, { collapseId: 'x1' });
  const gone = await apns.push('dead', { aps: { alert: 'hi' } });
  apns.close(); srv.close();
  assert.equal(ok.ok, true); assert.equal(gone.status, 410); assert.equal(gone.reason, 'Unregistered');
  const [first] = seen;
  assert.equal(first.h[':path'], '/3/device/abcd1234');
  assert.equal(first.h['apns-topic'], 'win.multichat.giveaway');
  assert.equal(first.h['apns-push-type'], 'alert');
  assert.equal(first.h['apns-collapse-id'], 'x1');
  assert.deepEqual(JSON.parse(first.body), { aps: { alert: 'hi' } });
  const jwt = first.h.authorization.replace('bearer ', '');
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'KEY1234567' });
  assert.equal(JSON.parse(Buffer.from(c, 'base64url')).iss, 'TEAM123456');
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')), true);
  assert.equal(seen[1].h.authorization, first.h.authorization, 'token is reused, not re-signed per push');
});

// Apple Push Notifications (token-based auth: a .p8 key from your Apple Developer account).
// No dependencies: ES256 JWT with node:crypto, HTTP/2 with node:http2.
import http2 from 'node:http2';
import crypto from 'node:crypto';

const b64u = (b) => Buffer.from(b).toString('base64url');

export class Apns {
  constructor({ teamId, keyId, bundleId, keyPem, sandbox = false, url }) {
    Object.assign(this, { teamId, keyId, bundleId, keyPem });
    this.url = url || (sandbox ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    this.session = null;
    this.token = null;
    this.tokenAt = 0;
  }

  jwt(now = Date.now()) {                       // Apple wants a fresh token every 20-60 minutes
    if (this.token && now - this.tokenAt < 50 * 60 * 1000) return this.token;
    const head = b64u(JSON.stringify({ alg: 'ES256', kid: this.keyId }));
    const claims = b64u(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) }));
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`),
      { key: this.keyPem, dsaEncoding: 'ieee-p1363' });
    this.token = `${head}.${claims}.${b64u(sig)}`;
    this.tokenAt = now;
    return this.token;
  }

  #conn() {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const s = http2.connect(this.url);
    s.on('error', () => { this.session = null; });
    s.on('close', () => { if (this.session === s) this.session = null; });
    s.unref?.();
    this.session = s;
    return s;
  }

  // -> {ok, status, reason}. 410 / BadDeviceToken means the phone is gone: the caller should forget it.
  push(deviceToken, payload, { pushType = 'alert', priority = 10, collapseId } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const headers = {
          ':method': 'POST', ':path': `/3/device/${deviceToken}`,
          authorization: `bearer ${this.jwt()}`, 'apns-topic': this.bundleId,
          'apns-push-type': pushType, 'apns-priority': String(priority), 'content-type': 'application/json',
        };
        if (collapseId) headers['apns-collapse-id'] = collapseId;
        const req = this.#conn().request(headers);
        let status = 0, body = '';
        req.setEncoding('utf8');
        req.on('response', (h) => { status = h[':status']; });
        req.on('data', (d) => { body += d; });
        req.on('end', () => {
          let reason = '';
          try { reason = JSON.parse(body || '{}').reason || ''; } catch { /* ignore */ }
          finish({ ok: status === 200, status, reason });
        });
        req.on('error', (e) => finish({ ok: false, status: 0, reason: e.message }));
        req.setTimeout(10000, () => { req.close(); finish({ ok: false, status: 0, reason: 'timeout' }); });
        req.end(JSON.stringify(payload));
      } catch (e) {
        finish({ ok: false, status: 0, reason: e.message });
      }
    });
  }

  close() { try { this.session?.close(); } catch { /* ignore */ } }
}

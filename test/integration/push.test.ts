import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { useFakeApis } from '../helpers/fake';
import { Client, deliver, email, setupInstance } from '../helpers/client';
import { fromBase64Url, toBase64Url } from '../../src/worker/lib/crypto';
import { encryptPayload, generateVapidKeys, vapidHeader } from '../../src/worker/lib/webpush';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;
const enc = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

// A browser-side device: its key pair and auth secret, and RFC 8291 decryption as a browser does it.
async function device() {
  const keys = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array((await crypto.subtle.exportKey('raw', keys.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: toBase64Url(publicRaw),
    auth: toBase64Url(auth),
    async decrypt(body: Uint8Array): Promise<string> {
      const salt = body.slice(0, 16);
      expect(new DataView(body.buffer, body.byteOffset).getUint32(16)).toBe(4096);
      const idlen = body[20];
      const serverPublic = body.slice(21, 21 + idlen);
      const serverKey = await crypto.subtle.importKey('raw', serverPublic, ECDH, false, []);
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, keys.privateKey, 256),
      );
      const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...publicRaw, ...serverPublic]);
      const ikm = await hkdf(auth, shared, info, 32);
      const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
      const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(21 + idlen)));
      expect(plain[plain.length - 1]).toBe(2);
      return new TextDecoder().decode(plain.slice(0, -1));
    },
  };
}

describe('web push crypto', () => {
  it('encrypts a payload a browser can decrypt', async () => {
    const d = await device();
    const body = await encryptPayload({ endpoint: 'https://push.test/x', p256dh: d.p256dh, auth: d.auth }, enc.encode('{"hello":"world"}'));
    expect(await d.decrypt(body)).toBe('{"hello":"world"}');
  });

  it('signs a VAPID token the push service can verify', async () => {
    const keys = await generateVapidKeys();
    const header = await vapidHeader('https://push.test/abc', keys, 'https://mail.example.com', 1_700_000_000_000);
    const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
    expect(k).toBe(keys.publicKey);
    const [h, p, s] = token.split('.');
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(p)))).toEqual({ aud: 'https://push.test', exp: 1_700_000_000 + 12 * 3600, sub: 'https://mail.example.com' });
    const pub = await crypto.subtle.importKey('raw', fromBase64Url(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, fromBase64Url(s), enc.encode(`${h}.${p}`))).toBe(true);
  });
});

describe('push notifications', () => {
  let admin: Client;
  let pushes: { url: string; headers: Headers; body: Uint8Array }[];
  let pushStatus: number;
  let restore: () => void;

  beforeEach(async () => {
    useFakeApis();
    pushes = [];
    pushStatus = 201;
    const prev = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      if (new URL(req.url).host === 'push.test') {
        pushes.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
        return new Response(null, { status: pushStatus });
      }
      return prev(input, init);
    }) as typeof fetch;
    restore = () => (globalThis.fetch = prev);
    admin = new Client();
    await setupInstance(admin);
  });
  afterEach(() => restore());

  it('pushes new inbox mail to subscribed devices and forgets gone ones', async () => {
    const { publicKey } = await admin.get('/api/account/push/key');
    expect(fromBase64Url(publicKey)).toHaveLength(65);
    // The key is generated once and reused.
    expect((await admin.get('/api/account/push/key')).publicKey).toBe(publicKey);

    const d = await device();
    await admin.post('/api/account/push/subscriptions', { endpoint: 'https://push.test/device-1', keys: { p256dh: d.p256dh, auth: d.auth } });
    expect((await admin.get('/api/account/push/subscriptions')).devices).toHaveLength(1);

    await deliver(email({ subject: 'Lunch on Friday?', from: 'Ann Lee <ann@sender.test>', body: 'Are you free at noon?' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(pushes[0].headers.get('Authorization')).toMatch(new RegExp(`^vapid t=.+, k=${publicKey}$`));
    const payload = JSON.parse(await d.decrypt(pushes[0].body));
    expect(payload).toMatchObject({ kind: 'mail', title: 'Ann Lee', tag: expect.stringMatching(/^thread-\d+$/), url: expect.stringMatching(/^\/mail\/\d+\/inbox\/\d+$/) });
    expect(payload.body).toContain('Lunch on Friday?');

    // The test button reaches only this device.
    await admin.post('/api/account/push/test', { endpoint: 'https://push.test/device-1' });
    expect(pushes).toHaveLength(2);

    // The push service says the device unsubscribed: the row is removed.
    pushStatus = 410;
    await deliver(email({ subject: 'Second' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect((await admin.get('/api/account/push/subscriptions')).devices).toHaveLength(0);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it('stops after unsubscribing and rejects plain-HTTP endpoints', async () => {
    const d = await device();
    await admin.post('/api/account/push/subscriptions', { endpoint: 'https://push.test/device-2', keys: { p256dh: d.p256dh, auth: d.auth } });
    await admin.post('/api/account/push/unsubscribe', { endpoint: 'https://push.test/device-2' });
    await deliver(email({ subject: 'Nobody is listening' }), { from: 'ann@sender.test', to: 'admin@example.com' });
    expect(pushes).toHaveLength(0);
    expect(await admin.status('POST', '/api/account/push/subscriptions', { endpoint: 'http://push.test/plain', keys: { p256dh: d.p256dh, auth: d.auth } })).toBe(400);
  });
});

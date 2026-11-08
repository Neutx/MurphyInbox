// Web Push with WebCrypto only: payload encryption (RFC 8291, aes128gcm) and VAPID sign-in to the
// push service (RFC 8292). One push costs a few native crypto calls and one subrequest.
import { fromBase64Url, randomBytes, toBase64Url } from './crypto';

export interface VapidKeys {
  publicKey: string; // uncompressed P-256 point, base64url (what browsers call applicationServerKey)
  privateJwk: JsonWebKey;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

const encoder = new TextEncoder();
const P256 = { name: 'ECDH', namedCurve: 'P-256' } as const;
const RECORD_SIZE = 4096;

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const buf = (b: Uint8Array): Uint8Array<ArrayBuffer> => (b.buffer instanceof ArrayBuffer ? (b as Uint8Array<ArrayBuffer>) : new Uint8Array(b));

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info) }, key, bytes * 8));
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return { publicKey: toBase64Url(raw), privateJwk };
}

// The Authorization header that proves to the push service which server is sending.
export async function vapidHeader(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const part = (o: unknown) => toBase64Url(encoder.encode(JSON.stringify(o)));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part(claims)}`;
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateJwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(unsigned)));
  return `vapid t=${unsigned}.${toBase64Url(sig)}, k=${keys.publicKey}`;
}

// Encrypts one payload for one device. `salt` and `serverKeys` are injectable for tests only.
export async function encryptPayload(target: PushTarget, payload: Uint8Array, salt: Uint8Array = randomBytes(16), serverKeys?: CryptoKeyPair): Promise<Uint8Array> {
  if (payload.length > RECORD_SIZE - 17) throw new Error('Push payload too large.');
  const uaPublic = fromBase64Url(target.p256dh);
  const authSecret = fromBase64Url(target.auth);
  const server = serverKeys ?? ((await crypto.subtle.generateKey(P256, true, ['deriveBits'])) as CryptoKeyPair);
  const serverPublic = new Uint8Array((await crypto.subtle.exportKey('raw', server.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey('raw', buf(uaPublic), P256, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
      // The spec's `public` member; workers-types spells it `$public` because `public` is reserved.
      { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      server.privateKey,
      256,
    ));

  const ikm = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), uaPublic, serverPublic), 32);
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', buf(cek), 'AES-GCM', false, ['encrypt']);
  // A single record: the payload, then the 0x02 "last record" delimiter, no padding.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, aes, concat(payload, new Uint8Array([2]))));

  const header = new Uint8Array(21 + serverPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = serverPublic.length;
  header.set(serverPublic, 21);
  return concat(header, cipher);
}

export interface PushResult {
  status: number;
  gone: boolean; // the device unsubscribed or the subscription expired: delete it
}

export async function sendPush(target: PushTarget, payload: unknown, keys: VapidKeys, subject: string): Promise<PushResult> {
  const body = await encryptPayload(target, encoder.encode(JSON.stringify(payload)));
  const res = await fetch(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(target.endpoint, keys, subject),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400',
      Urgency: 'high',
    },
    body: buf(body),
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

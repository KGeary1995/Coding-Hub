import { createECDH, createHmac, createCipheriv, generateKeyPairSync, createPrivateKey, randomBytes, sign, type ECDH, type KeyObject } from 'node:crypto';

/**
 * Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and VAPID (RFC 8292), using Node's crypto only.
 * The phone's browser gives an endpoint at its push service plus keys; the message is encrypted to those keys, so the
 * push service carries it without being able to read it.
 */

/**
 * Push services of the browsers a phone can use. The endpoint comes from a paired phone, so only these hosts are
 * accepted: the desktop never sends requests anywhere a phone names.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
export function pushEndpoint(value: string) {
  let url: URL; try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.port && !url.username && !url.password && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

export interface PushSubscription { endpoint: string; p256dh: string; auth: string }
export interface VapidKeys { publicKey: string; privateKey: string }

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** A new VAPID key pair: the public key in the raw form browsers take as `applicationServerKey`, the private key as PKCS#8. */
export function vapidKeys(): VapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: b64(raw), privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url') };
}

/** The VAPID `Authorization` header for one push service (its origin is the token's audience), valid for twelve hours. */
export function vapidHeader(endpoint: string, keys: VapidKeys, now = Date.now()) {
  const key: KeyObject = createPrivateKey({ key: Buffer.from(keys.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  const part = (value: unknown) => b64(Buffer.from(JSON.stringify(value)));
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: 'https://github.com/KGeary1995/Coding-Hub' })}`;
  const signature = sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64(signature)}, k=${keys.publicKey}`;
}

/** Encrypts one message to a subscription (a single aes128gcm record). */
export function encrypt(subscription: PushSubscription, payload: Buffer, salt = randomBytes(16), local?: ECDH) {
  const sender = local ?? createECDH('prime256v1'); if (!local) sender.generateKeys();
  const uaPublic = Buffer.from(subscription.p256dh, 'base64url'); const authSecret = Buffer.from(subscription.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('The phone sent push keys of the wrong size.');
  const asPublic = sender.getPublicKey(); const shared = sender.computeSecret(uaPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // The 0x02 delimiter marks the last (and only) record.
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header, 0); header.writeUInt32BE(4096, 16); header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

export type PushResult = 'sent' | 'gone' | 'failed';
export type PushSender = (subscription: PushSubscription, message: object, options: { topic: string }) => Promise<PushResult>;

/** Sends one encrypted message. `gone` means the phone dropped the subscription (404/410) and it should be forgotten. */
export function pushSender(keys: () => VapidKeys, request: typeof fetch = fetch): PushSender {
  return async (subscription, message, { topic }) => {
    if (!pushEndpoint(subscription.endpoint)) return 'gone';
    try {
      const response = await request(subscription.endpoint, { method: 'POST', body: encrypt(subscription, Buffer.from(JSON.stringify(message))), signal: AbortSignal.timeout(15000),
        headers: { Authorization: vapidHeader(subscription.endpoint, keys()), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Topic: topic } });
      return response.status === 404 || response.status === 410 ? 'gone' : response.ok ? 'sent' : 'failed';
    } catch { return 'failed'; }
  };
}

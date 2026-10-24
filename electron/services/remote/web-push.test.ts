import { describe, expect, it } from 'vitest';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { encrypt, pushEndpoint, pushSender, vapidHeader, vapidKeys } from './web-push';

describe('web push', () => {
  it('encrypts exactly as RFC 8291 appendix A', () => {
    const sender = createECDH('prime256v1'); sender.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const body = encrypt({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      Buffer.from('When I grow up, I want to be a watermelon'), Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), sender);
    expect(body.toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });

  it('signs a VAPID token for the push service with the stored key', () => {
    const keys = vapidKeys(); const raw = Buffer.from(keys.publicKey, 'base64url'); expect(raw.length).toBe(65);
    const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc', keys, Date.parse('2026-10-24T12:00:00Z'));
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!; expect(key).toBe(keys.publicKey);
    const [head, claims, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({ aud: 'https://fcm.googleapis.com', exp: Date.parse('2026-10-25T00:00:00Z') / 1000 });
    const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  it('only sends to the browsers’ push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/QG9', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-by3p.notify.windows.com/w/?token=x']) expect(pushEndpoint(ok), ok).toBe(true);
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://evil.example/x', 'https://127.0.0.1/x', 'https://fcm.googleapis.com.evil.example/x', 'https://user@fcm.googleapis.com/x', 'not a url']) expect(pushEndpoint(bad), bad).toBe(false);
  });

  it('posts an encrypted message and reports a dropped subscription as gone', async () => {
    const ua = createECDH('prime256v1'); ua.generateKeys(); const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: ua.getPublicKey().toString('base64url'), auth: Buffer.alloc(16, 7).toString('base64url') };
    const calls: { url: string; init: RequestInit }[] = []; let status = 201; const keys = vapidKeys();
    const send = pushSender(() => keys, (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); }) as typeof fetch);
    expect(await send(subscription, { title: 'CH2 needs you' }, { topic: 'ch2' })).toBe('sent');
    expect(calls[0].init.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', TTL: '3600', Topic: 'ch2' });
    expect(Buffer.from(calls[0].init.body as Buffer).toString()).not.toContain('CH2 needs you');
    status = 410; expect(await send(subscription, {}, { topic: 'x' })).toBe('gone');
    status = 500; expect(await send(subscription, {}, { topic: 'x' })).toBe('failed');
    expect(await send({ ...subscription, endpoint: 'https://evil.example/x' }, {}, { topic: 'x' })).toBe('gone'); expect(calls).toHaveLength(3);
  });
});

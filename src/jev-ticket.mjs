import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const JEV_TICKET_MODEL = 'openrouter-jev-campaign/jev-1.13';
export const JEV_TICKET_PATH = '/v1/jev-decisions';
export const JEV_TICKET_ISSUER_PATH = '/v1/jev-ticket';
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_CALLS = 19;
const MAX_ACTIVE = 4096;

export function issueJevTicket(sessionId, callerKey, now = Date.now(), nonce = randomBytes(16)) {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(sessionId) ||
      typeof callerKey !== 'string' || callerKey.length < 32 ||
      !Number.isSafeInteger(now) || !Buffer.isBuffer(nonce) || nonce.length !== 16) {
    throw new Error('Invalid Jev ticket request');
  }
  const body = Buffer.from(JSON.stringify({ v: 1, scope: 'jev-decisions-v1',
    sessionId, nonce: nonce.toString('base64url'), issuedAt: now,
    expiresAt: now + MAX_AGE_MS, maxCalls: MAX_CALLS })).toString('base64url');
  const signature = createHmac('sha256', callerKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function consumeJevTicket(token, callerKey, used, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 ||
      typeof callerKey !== 'string' || callerKey.length < 32 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return false;
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', callerKey).update(body).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
  catch { return false; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      Object.keys(payload).sort().join(',') !==
        'expiresAt,issuedAt,maxCalls,nonce,scope,sessionId,v' ||
      payload.v !== 1 || payload.scope !== 'jev-decisions-v1' ||
      !/^[A-Za-z0-9-]{1,128}$/.test(payload.sessionId) ||
      !/^[A-Za-z0-9_-]{22,44}$/.test(payload.nonce) ||
      !Number.isSafeInteger(payload.issuedAt) ||
      !Number.isSafeInteger(payload.expiresAt) ||
      payload.issuedAt > now + 30_000 || payload.expiresAt <= now ||
      payload.expiresAt <= payload.issuedAt ||
      payload.expiresAt - payload.issuedAt > MAX_AGE_MS ||
      !Number.isInteger(payload.maxCalls) ||
      payload.maxCalls < 1 || payload.maxCalls > MAX_CALLS) return false;
  for (const [nonce, entry] of used) {
    if (entry.expiresAt <= now) used.delete(nonce);
  }
  const entry = used.get(payload.nonce);
  if (entry && (entry.signature !== signature || entry.count >= payload.maxCalls)) return false;
  if (!entry && used.size >= MAX_ACTIVE) return false;
  used.set(payload.nonce, {
    signature, count: (entry?.count ?? 0) + 1, expiresAt: payload.expiresAt,
  });
  return true;
}

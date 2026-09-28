import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { consumeJevTicket } from '../src/jev-ticket.mjs';

const callerKey = 'a'.repeat(48);
const now = 1_800_000_000_000;

function ticket(overrides = {}) {
  const payload = {
    v: 1, scope: 'jev-decisions-v1', sessionId: 'session-a',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA', issuedAt: now,
    expiresAt: now + 60_000, maxCalls: 2, ...overrides,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', callerKey).update(body).digest('base64url');
  return `${body}.${signature}`;
}

test('accepts a signed Jev-only ticket up to its call limit', () => {
  const used = new Map();
  const value = ticket();
  assert.equal(consumeJevTicket(value, callerKey, used, now), true);
  assert.equal(consumeJevTicket(value, callerKey, used, now), true);
  assert.equal(consumeJevTicket(value, callerKey, used, now), false);
});

test('rejects tampering, expiry, future issue time and broader scope', () => {
  const invalid = [
    ticket().replace(/.$/, 'x'),
    ticket({ expiresAt: now - 1 }),
    ticket({ issuedAt: now + 31_000 }),
    ticket({ scope: 'all-router-routes' }),
    ticket({ maxCalls: 20 }),
    ticket({ expiresAt: now + 3_600_001 }),
    ticket({ extra: true }),
    'not-a-ticket',
  ];
  for (const value of invalid) {
    assert.equal(consumeJevTicket(value, callerKey, new Map(), now), false);
  }
});

test('fails closed when too many ticket identities are active', () => {
  const used = new Map();
  for (let index = 0; index < 4096; index++) {
    used.set(String(index), { count: 1, expiresAt: now + 60_000 });
  }
  assert.equal(consumeJevTicket(ticket(), callerKey, used, now), false);
});

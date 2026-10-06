// Tests for the backers Worker, run with plain Node (22+): node test/backers.test.mjs
// A tiny stand-in for Cloudflare D1, backed by Node's built-in SQLite.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, { choicesFrom, handleEvent, stats, thanks, verifyStripe, wall } from '../src/index.js';
import { badgeFor, formatNumber, foundingBand } from '../src/badges.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let args = [];
      const stmt = db.prepare(sql);
      return {
        bind(...a) { args = a; return this; },
        async first() { return stmt.get(...args) ?? null; },
        async all() { return { results: stmt.all(...args) }; },
        async run() { const r = stmt.run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
      };
    },
  };
}

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('PASS ', name); };

const checkout = (over = {}) => ({
  type: 'checkout.session.completed',
  created: 1791200000,
  data: {
    object: {
      id: 'cs_test_a1', mode: 'payment', payment_status: 'paid', amount_total: 2000, payment_intent: 'pi_1',
      customer_details: { email: 'Ada@Example.org' },
      custom_fields: [
        { key: 'name', type: 'text', label: { type: 'custom', custom: 'Name for the Founders Wall (optional)' }, text: { value: 'Ada L.' } },
        { key: 'wall', type: 'dropdown', label: { type: 'custom', custom: 'List me on the Founders Wall?' }, dropdown: { value: 'yes' } },
        { key: 'badge', type: 'dropdown', label: { type: 'custom', custom: 'Show my badge on my CivicSky profile?' }, dropdown: { value: 'no' } },
      ],
      ...over,
    },
  },
});

await test('Badge levels follow total giving; any first gift is Signal', () => {
  assert.equal(badgeFor(500), 'Signal');
  assert.equal(badgeFor(2000), 'Signal');
  assert.equal(badgeFor(2500), 'Catalyst');
  assert.equal(badgeFor(12_500), 'Vanguard');
  assert.equal(badgeFor(300_000), 'Cornerstone');
});

await test('Founding numbers and bands read as designed', () => {
  assert.equal(formatNumber(841), '#00841');
  assert.equal(foundingBand(841), 'Founding 1,000');
  assert.equal(foundingBand(4_999), 'Founding 5,000');
  assert.equal(foundingBand(42_500), 'Founding 50,000');
});

await test('Checkout choices are read by their labels; unanswered means private', () => {
  const c = choicesFrom(checkout().data.object);
  assert.deepEqual(c, { wallName: 'Ada L.', showOnWall: true, showBadge: false });
  assert.deepEqual(choicesFrom({ custom_fields: [] }), { wallName: null, showOnWall: false, showBadge: false });
});

await test('A first gift creates backer #00001; the same webhook twice counts once', async () => {
  const db = fakeD1();
  await handleEvent(db, checkout());
  await handleEvent(db, checkout());
  const s = await stats(db, { GOAL_CENTS: '85000000' });
  assert.deepEqual(s, { backers: 1, raisedCents: 2000, goalCents: 85_000_000 });
  assert.equal((await thanks(db, 'cs_test_a1')).number, '#00001');
});

await test('Unpaid checkouts wait; async success records them', async () => {
  const db = fakeD1();
  assert.equal(await handleEvent(db, checkout({ payment_status: 'unpaid' })), 'waiting for payment');
  assert.equal((await stats(db, {})).backers, 0);
  await handleEvent(db, { ...checkout(), type: 'checkout.session.async_payment_succeeded' });
  assert.equal((await stats(db, {})).backers, 1);
});

await test('Monthly backers keep their number and climb badges with renewals', async () => {
  const db = fakeD1();
  await handleEvent(db, checkout());
  await handleEvent(db, checkout({ id: 'cs_test_m1', mode: 'subscription', amount_total: 500, invoice: 'in_first', payment_intent: null, customer_details: { email: 'grace@example.org' }, custom_fields: [] }));
  for (let i = 0; i < 4; i++) {
    await handleEvent(db, { type: 'invoice.paid', created: 1791200000 + i, data: { object: { id: `in_r${i}`, billing_reason: 'subscription_cycle', amount_paid: 500, customer_email: 'grace@example.org' } } });
  }
  // The first monthly invoice is ignored here: its checkout already counted it.
  await handleEvent(db, { type: 'invoice.paid', created: 1, data: { object: { id: 'in_first', billing_reason: 'subscription_create', amount_paid: 500, customer_email: 'grace@example.org' } } });
  const t = await thanks(db, 'cs_test_m1');
  assert.equal(t.number, '#00002');
  assert.equal(t.badge, 'Catalyst'); // $5 + 4 x $5 = $25
  assert.equal((await stats(db, {})).raisedCents, 2000 + 2500);
});

await test('The Founders Wall lists only backers who chose it, with no amounts', async () => {
  const db = fakeD1();
  await handleEvent(db, checkout());
  await handleEvent(db, checkout({ id: 'cs_test_b', payment_intent: 'pi_2', customer_details: { email: 'private@example.org' }, custom_fields: [] }));
  const w = await wall(db);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0], { name: 'Ada L.', badge: 'Signal', number: '#00001', founding: 'Founding 1,000', since: '2026' });
  assert.ok(!JSON.stringify(w).includes('cents') && !JSON.stringify(w).includes('@'));
});

await test('The same email is one backer: one number, gifts add up', async () => {
  const db = fakeD1();
  await handleEvent(db, checkout());
  await handleEvent(db, checkout({ id: 'cs_test_a2', payment_intent: 'pi_9', amount_total: 3000, customer_details: { email: 'ada@example.org ' } }));
  const t = await thanks(db, 'cs_test_a2');
  assert.equal(t.number, '#00001');
  assert.equal(t.badge, 'Builder');
});

await test('Stripe signatures: valid passes; tampered, missing, or stale fail', async () => {
  const secret = 'whsec_test';
  const body = '{"a":1}';
  const t = 1791200000;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  assert.equal(await verifyStripe(body, `t=${t},v1=${sig}`, secret, t + 10), true);
  assert.equal(await verifyStripe('{"a":2}', `t=${t},v1=${sig}`, secret, t + 10), false);
  assert.equal(await verifyStripe(body, null, secret, t), false);
  assert.equal(await verifyStripe(body, `t=${t},v1=${sig}`, secret, t + 1000), false);
});

await test('The Worker answers the page and rejects unsigned webhooks', async () => {
  const env = { DB: fakeD1(), GOAL_CENTS: '85000000', ALLOWED_ORIGINS: 'https://civ.works', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  const r = await worker.fetch(new Request('https://w.example/stats', { headers: { Origin: 'https://civ.works' } }), env);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://civ.works');
  assert.equal((await r.json()).goalCents, 85_000_000);
  const bad = await worker.fetch(new Request('https://w.example/stripe', { method: 'POST', body: '{}' }), env);
  assert.equal(bad.status, 400);
  const pending = await worker.fetch(new Request('https://w.example/thanks?session=cs_nope'), env);
  assert.equal(pending.status, 404);
});

console.log(`\n${passed} tests passed.`);

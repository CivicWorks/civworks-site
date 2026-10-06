// Tests for the backers Worker, run with plain Node (22+): node test/backers.test.mjs
// A tiny stand-in for Cloudflare D1, backed by Node's built-in SQLite.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import worker, { choicesFrom, handleEvent, stats, thanks, verifyStripe, wall } from '../src/index.js';
import { badgeFor, formatNumber, foundingBand } from '../src/badges.js';
import { giftsFrom, importSql, parseCsv } from '../import-past.mjs';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  return {
    exec(sqlText) { db.exec(sqlText); },
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

// The backer form with every question left blank (what a private backer sends).
const PRIVATE = checkout().data.object.custom_fields.map((f) => ({ ...f, text: f.text ? { value: null } : undefined, dropdown: f.dropdown ? { value: null } : undefined }));

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
  const s = await stats(db, { GOAL_CENTS: '12000000' });
  assert.deepEqual(s, { backers: 1, raisedCents: 2000, goalCents: 12_000_000 });
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
  await handleEvent(db, checkout({ id: 'cs_test_m1', mode: 'subscription', amount_total: 500, invoice: 'in_first', payment_intent: null, customer_details: { email: 'grace@example.org' }, custom_fields: PRIVATE }));
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
  await handleEvent(db, checkout({ id: 'cs_test_b', payment_intent: 'pi_2', customer_details: { email: 'private@example.org' }, custom_fields: PRIVATE }));
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
  const env = { DB: fakeD1(), GOAL_CENTS: '12000000', ALLOWED_ORIGINS: 'https://civ.works', STRIPE_WEBHOOK_SECRET: 'whsec_x' };
  const r = await worker.fetch(new Request('https://w.example/stats', { headers: { Origin: 'https://civ.works' } }), env);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), 'https://civ.works');
  assert.equal((await r.json()).goalCents, 12_000_000);
  const bad = await worker.fetch(new Request('https://w.example/stripe', { method: 'POST', body: '{}' }), env);
  assert.equal(bad.status, 400);
  const pending = await worker.fetch(new Request('https://w.example/thanks?session=cs_nope'), env);
  assert.equal(pending.status, 404);
});

const stripeExport = [
  'id,Created date (UTC),Amount,Amount Refunded,Currency,Status,Customer Email,Customer Description',
  'ch_3,2025-11-02 18:00:00,"1,000.00",0.00,usd,Paid,later@example.org,"Second, Donor"',
  'ch_1,2025-03-14 16:20:00,500.00,0.00,usd,Paid,first@example.org,First Donor',
  'ch_2,2025-06-01 12:00:00,750.00,0.00,usd,Failed,nope@example.org,',
  'ch_4,2025-07-04 09:00:00,600.00,600.00,usd,Paid,refunded@example.org,',
  'ch_5,2026-01-10 10:00:00,250.00,0.00,usd,Paid,first@example.org,First Donor',
].join('\n');

await test('CSV parsing handles quotes and commas inside fields', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi"""\n'), [['a', 'b'], ['x, y', 'say "hi"']]);
});

await test('A Stripe export becomes past gifts: paid only, refunds removed, oldest first', () => {
  const g = giftsFrom(stripeExport);
  assert.deepEqual(g.map((x) => [x.email, x.amountCents]), [['first@example.org', 50_000], ['later@example.org', 100_000], ['first@example.org', 25_000]]);
});

await test('Past donors get the earliest numbers, Charter-level badges, and stay private', async () => {
  const db = fakeD1();
  db.exec(importSql(giftsFrom(stripeExport)));
  db.exec(importSql(giftsFrom(stripeExport))); // run twice: nothing doubles
  const s = await stats(db, {});
  assert.deepEqual([s.backers, s.raisedCents], [2, 175_000]);
  assert.equal((await wall(db)).length, 0);
  // A new backer after the import gets the next number.
  await handleEvent(db, checkout());
  assert.equal((await thanks(db, 'cs_test_a1')).number, '#00003');
  const first = await db.prepare('SELECT id, total_cents, wall_name FROM backers WHERE email = ?').bind('first@example.org').first();
  assert.equal(first.id, 1);
  assert.equal(badgeFor(first.total_cents), 'Charter'); // $750
  assert.equal(first.wall_name, 'First Donor');
  const later = await db.prepare('SELECT id, total_cents FROM backers WHERE email = ?').bind('later@example.org').first();
  assert.deepEqual([later.id, badgeFor(later.total_cents)], [2, 'Charter']);
});

await test('A simple hand-made list works too', () => {
  const g = giftsFrom('email,name,amount,date\nann@example.org,Ann,$500,2024-12-01\n');
  assert.deepEqual([g.length, g[0].amountCents, g[0].name], [1, 50_000, 'Ann']);
});

const reserveSql = readFileSync(new URL('../reserve.sql', import.meta.url), 'utf8');

await test('Reserving #00001 to #00025: new backers start at #00026 and empty slots count for nothing', async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  db.exec(reserveSql); // safe to run twice
  assert.deepEqual(await stats(db, {}), { backers: 0, raisedCents: 0, goalCents: 12_000_000 });
  await handleEvent(db, checkout());
  assert.equal((await thanks(db, 'cs_test_a1')).number, '#00026');
  assert.equal((await wall(db)).length, 1); // only Ada, who chose the wall
});

await test('Filling reserved slots: named or anonymous, counted once, still private', async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  await handleEvent(db, checkout());
  const list = 'number,email,name,amount,date\n3,early@example.org,Early Donor,$500,2025-04-01\n7,,,"1,000",2025-05-01\n3,early@example.org,Early Donor,250,2025-09-01\n';
  db.exec(importSql(giftsFrom(list)));
  db.exec(importSql(giftsFrom(list))); // twice: nothing doubles
  const s = await stats(db, {});
  assert.deepEqual([s.backers, s.raisedCents], [3, 2000 + 75_000 + 100_000]);
  const three = await db.prepare('SELECT email, wall_name, total_cents, show_on_wall FROM backers WHERE id = 3').first();
  assert.deepEqual([three.email, three.wall_name, badgeFor(three.total_cents), three.show_on_wall], ['early@example.org', 'Early Donor', 'Charter', 0]);
  const seven = await db.prepare('SELECT email, total_cents FROM backers WHERE id = 7').first();
  assert.deepEqual([seven.email, badgeFor(seven.total_cents)], ['reserved-07', 'Charter']);
  assert.equal((await wall(db)).length, 1);
  // A new backer still gets the next open number.
  await handleEvent(db, checkout({ id: 'cs_test_n', payment_intent: 'pi_n', customer_details: { email: 'new@example.org' } }));
  assert.equal((await thanks(db, 'cs_test_n')).number, '#00027');
});

await test('A reserved slot is never given an email that already has a number', async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  await handleEvent(db, checkout()); // ada@example.org is #00026
  db.exec(importSql(giftsFrom('number,email,amount,date\n5,ada@example.org,500,2025-01-01\n')));
  const five = await db.prepare('SELECT email, total_cents FROM backers WHERE id = 5').first();
  assert.deepEqual([five.email, five.total_cents], ['reserved-05', 0]);
  assert.equal((await stats(db, {})).raisedCents, 2000);
});

await test('Numbers outside the reserved range are refused', () => {
  assert.throws(() => giftsFrom('number,email,amount,date\n26,x@example.org,20,2025-01-01\n'), /1 to 25/);
});

await test('Refunds: a refunded gift stops counting; repeats and partial refunds add up right', async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  await handleEvent(db, checkout()); // $20, pi_1
  await handleEvent(db, checkout({ id: 'cs_test_m', mode: 'subscription', amount_total: 500, invoice: 'in_1', payment_intent: null, customer_details: { email: 'm@example.org' }, custom_fields: PRIVATE }));
  const refund = (o) => ({ type: 'charge.refunded', created: 1, data: { object: o } });
  await handleEvent(db, refund({ amount: 2000, amount_refunded: 500, payment_intent: 'pi_1' }));
  assert.equal((await stats(db, {})).raisedCents, 1500 + 500);
  await handleEvent(db, refund({ amount: 2000, amount_refunded: 500, payment_intent: 'pi_1' })); // repeat: no change
  assert.equal((await stats(db, {})).raisedCents, 1500 + 500);
  await handleEvent(db, refund({ amount: 2000, amount_refunded: 2000, payment_intent: 'pi_1' }));
  await handleEvent(db, refund({ amount: 500, amount_refunded: 500, payment_intent: 'pi_m', invoice: 'in_1' }));
  assert.deepEqual(await stats(db, {}), { backers: 0, raisedCents: 0, goalCents: 12_000_000 });
  await handleEvent(db, refund({ amount: 900, amount_refunded: 900, payment_intent: 'pi_unknown' })); // not ours: ignored
});

await test("Civic Works' general Donate link never counts as a CivicSky backer", async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  const general = { id: 'cs_general', payment_intent: 'pi_general', amount_total: 500, custom_fields: [] };
  assert.equal(await handleEvent(db, checkout(general)), 'ignored: not a CivicSky backer link');
  assert.equal(await handleEvent(db, checkout({ id: 'cs_general2', payment_intent: 'pi_g2' , custom_fields: undefined })), 'ignored: not a CivicSky backer link');
  assert.deepEqual([(await stats(db, {})).backers, (await stats(db, {})).raisedCents], [0, 0]);
  // A backer-link gift with every question left unanswered still counts.
  const unanswered = checkout().data.object.custom_fields.map((f) => ({ ...f, text: f.text ? { value: null } : undefined, dropdown: f.dropdown ? { value: null } : undefined }));
  await handleEvent(db, checkout({ custom_fields: unanswered }));
  assert.deepEqual([(await stats(db, {})).backers, (await stats(db, {})).raisedCents], [1, 2000]);
});

await test('Monthly renewals count only for backers who signed up monthly', async () => {
  const db = fakeD1();
  db.exec(reserveSql);
  await handleEvent(db, checkout()); // Ada gave once, not monthly
  const renewal = (id, email) => ({ type: 'invoice.paid', created: 1, data: { object: { id, billing_reason: 'subscription_cycle', amount_paid: 500, customer_email: email } } });
  assert.equal(await handleEvent(db, renewal('in_x', 'stranger@example.org')), 'ignored: not a CivicSky monthly backer');
  assert.equal(await handleEvent(db, renewal('in_y', 'ada@example.org')), 'ignored: not a CivicSky monthly backer');
  assert.equal((await stats(db, {})).raisedCents, 2000);
});

console.log(`\n${passed} tests passed.`);

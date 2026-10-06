// civicsky-backers: records CivicSky gifts from Stripe and serves what
// civ.works/pledge shows.
//
//   POST /stripe   Stripe webhook (signed). Records one-time gifts, first
//                  monthly gifts, and each monthly renewal. A backer's first
//                  gift assigns their founding number.
//   GET  /stats    { backers, raisedCents, goalCents }
//   GET  /wall     Backers who chose to be listed: name, badge, number, year.
//   GET  /thanks?session=cs_...   The thank-you screen's lookup after checkout:
//                  founding number and badge for that checkout only.
//
// Gifts go to Civic Works (501(c)(3)). Nothing here is an investment.

import { badgeFor, formatNumber, foundingBand } from './badges.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function cors(request, env) {
  const origin = request.headers.get('Origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
}

// --- Stripe signature (no Stripe library needed) ----------------------------

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the Stripe-Signature header matches the body and is under 5 minutes old. */
export async function verifyStripe(body, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')).filter((kv) => kv.length === 2));
  const t = Number(parts.t);
  const v1s = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !v1s.length || Math.abs(nowSeconds - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${body}`);
  return v1s.some((v) => safeEqual(v, expected));
}

// --- Reading the checkout's custom fields ------------------------------------

function field(session, test, type) {
  return (session.custom_fields ?? []).find((f) => f.type === type && test.test(f.label?.custom ?? f.key ?? ''));
}

/** The three choices on the Stripe checkout page, matched by their labels. */
export function choicesFrom(session) {
  const yes = (f) => !!f && /^(yes|show|list)/i.test(String(f.dropdown?.value ?? ''));
  const name = field(session, /name/i, 'text')?.text?.value?.trim() || null;
  return {
    wallName: name ? name.slice(0, 60) : null,
    showOnWall: yes(field(session, /wall/i, 'dropdown')),
    showBadge: yes(field(session, /badge|profile/i, 'dropdown')),
  };
}

// --- Recording gifts ----------------------------------------------------------

async function findOrCreateBacker(db, email, at, choices) {
  const existing = await db.prepare('SELECT * FROM backers WHERE email = ?').bind(email).first();
  if (existing) {
    if (choices) {
      // A later checkout can only turn recognition on or update the name; turning it off happens on request.
      await db
        .prepare('UPDATE backers SET wall_name = COALESCE(?, wall_name), show_on_wall = MAX(show_on_wall, ?), show_badge = MAX(show_badge, ?) WHERE id = ?')
        .bind(choices.wallName, choices.showOnWall ? 1 : 0, choices.showBadge ? 1 : 0, existing.id)
        .run();
    }
    return existing.id;
  }
  const c = choices ?? { wallName: null, showOnWall: false, showBadge: false };
  const r = await db
    .prepare('INSERT INTO backers (email, wall_name, show_on_wall, show_badge, first_gift_at) VALUES (?, ?, ?, ?, ?)')
    .bind(email, c.wallName, c.showOnWall ? 1 : 0, c.showBadge ? 1 : 0, at)
    .run();
  return r.meta.last_row_id;
}

/** Record one paid gift once (by its Stripe id). Returns the backer's id. */
export async function recordGift(db, { stripeId, email, amountCents, kind, session, at, choices }) {
  if (!email || !stripeId || !(amountCents > 0)) return null;
  const seen = await db.prepare('SELECT backer_id FROM gifts WHERE stripe_id = ?').bind(stripeId).first();
  if (seen) return seen.backer_id;
  const backerId = await findOrCreateBacker(db, email.toLowerCase().trim(), at, choices);
  await db
    .prepare('INSERT INTO gifts (stripe_id, backer_id, amount_cents, kind, checkout_session, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(stripeId, backerId, amountCents, kind, session ?? null, at)
    .run();
  await db
    .prepare('UPDATE backers SET total_cents = total_cents + ?, monthly = MAX(monthly, ?) WHERE id = ?')
    .bind(amountCents, kind === 'monthly' ? 1 : 0, backerId)
    .run();
  return backerId;
}

/** Turn one Stripe event into a recorded gift, or ignore it. */
export async function handleEvent(db, event) {
  const o = event.data?.object ?? {};
  const at = new Date((event.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (o.payment_status !== 'paid') return 'waiting for payment';
    const monthly = o.mode === 'subscription';
    await recordGift(db, {
      stripeId: (monthly ? o.invoice : o.payment_intent) ?? o.id,
      email: o.customer_details?.email ?? o.customer_email,
      amountCents: o.amount_total,
      kind: monthly ? 'monthly' : 'once',
      session: o.id,
      at,
      choices: choicesFrom(o),
    });
    return 'recorded';
  }
  // Monthly renewals. The first monthly payment is recorded from its checkout above.
  if (event.type === 'invoice.paid' && o.billing_reason === 'subscription_cycle') {
    await recordGift(db, { stripeId: o.id, email: o.customer_email, amountCents: o.amount_paid, kind: 'monthly', at });
    return 'recorded';
  }
  return 'ignored';
}

// --- Public reads ----------------------------------------------------------------

export async function stats(db, env) {
  const r = await db.prepare('SELECT COUNT(*) AS backers, COALESCE(SUM(total_cents), 0) AS raised FROM backers').first();
  return { backers: r.backers, raisedCents: r.raised, goalCents: Number(env.GOAL_CENTS ?? 85_000_000) };
}

export async function wall(db, limit = 100) {
  const { results } = await db
    .prepare('SELECT id, wall_name, total_cents, first_gift_at FROM backers WHERE show_on_wall = 1 AND wall_name IS NOT NULL ORDER BY id DESC LIMIT ?')
    .bind(Math.min(Math.max(1, limit), 500))
    .all();
  return results.map((b) => ({
    name: b.wall_name,
    badge: badgeFor(b.total_cents),
    number: formatNumber(b.id),
    founding: foundingBand(b.id),
    since: b.first_gift_at.slice(0, 4),
  }));
}

export async function thanks(db, session) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(session ?? '')) return null;
  const row = await db
    .prepare('SELECT b.id, b.total_cents, b.first_gift_at FROM gifts g JOIN backers b ON b.id = g.backer_id WHERE g.checkout_session = ?')
    .bind(session)
    .first();
  if (!row) return null;
  return { number: formatNumber(row.id), badge: badgeFor(row.total_cents), founding: foundingBand(row.id), since: row.first_gift_at.slice(0, 4) };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = cors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { headers: { ...headers, 'Access-Control-Allow-Methods': 'GET' } });

    if (request.method === 'POST' && url.pathname === '/stripe') {
      const body = await request.text();
      if (!(await verifyStripe(body, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
        return json({ error: 'bad signature' }, 400);
      }
      const result = await handleEvent(env.DB, JSON.parse(body));
      return json({ received: true, result });
    }

    if (request.method === 'GET') {
      const cache = { 'Cache-Control': 'public, max-age=30', ...headers };
      if (url.pathname === '/stats') return json(await stats(env.DB, env), 200, cache);
      if (url.pathname === '/wall') return json(await wall(env.DB, Number(url.searchParams.get('limit') ?? 100)), 200, cache);
      if (url.pathname === '/thanks') {
        const t = await thanks(env.DB, url.searchParams.get('session'));
        return t ? json(t, 200, headers) : json({ pending: true }, 404, headers);
      }
    }
    return json({ error: 'not found' }, 404, headers);
  },
};

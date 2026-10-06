// Bring in donors who gave before the backer page existed, so they get the
// earliest founding numbers (in the order they first gave) and badges that
// count what they already gave. Run it BEFORE the page goes live.
//
//   node import-past.mjs past-donors.csv > import.sql
//   npx wrangler d1 execute civicsky-backers --remote --file import.sql
//
// The CSV can be a Stripe payments export (Payments > Export) or a simple
// list you make yourself, with these columns (any order, header row first):
//   number, email, name, amount, date
// number (optional, 1 to 25) fills one of the founding numbers held back for
// earlier donors (reserve.sql). Without it, a donor gets the next free number.
// email is optional when a number is given (an anonymous donor). name is only
// shown if the donor asks to be on the Founders Wall. Everyone starts private.
//
// Safe to run twice: the same gift is never counted twice.

import { readFileSync } from 'node:fs';

/** Minimal CSV parser: handles quoted fields, commas and quotes inside them. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

/** Founding numbers held back for earlier donors (see reserve.sql). */
export const RESERVED = 25;
const reservedEmail = (n) => `reserved-${String(n).padStart(2, '0')}`;

const cents = (s) => Math.round(Number(String(s ?? '').replace(/[$,\s]/g, '')) * 100) || 0;
const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

/** Gifts from either a Stripe export or a simple email,name,amount,date list. */
export function giftsFrom(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = (...names) => header.findIndex((h) => names.includes(h.trim().toLowerCase()));
  const iEmail = col('email', 'customer email', 'customer_email');
  const iName = col('name', 'customer name', 'customer description', 'card name');
  const iAmount = col('amount', 'converted amount');
  const iRefunded = col('amount refunded', 'converted amount refunded');
  const iDate = col('date', 'created date (utc)', 'created (utc)', 'created');
  const iStatus = col('status');
  const iId = col('id');
  const iNumber = col('number', 'founding number');
  if (iAmount < 0 || iDate < 0 || (iEmail < 0 && iNumber < 0)) {
    throw new Error('The CSV needs columns for amount and date, plus email or number (a Stripe payments export has them).');
  }
  const gifts = [];
  rows.forEach((r, n) => {
    const status = iStatus >= 0 ? r[iStatus].trim().toLowerCase() : 'paid';
    if (!['paid', 'succeeded', 'complete', 'completed'].includes(status)) return;
    const number = iNumber >= 0 && r[iNumber]?.trim() ? Number(r[iNumber].replace(/[#\s]/g, '')) : null;
    if (number !== null && !(Number.isInteger(number) && number >= 1 && number <= RESERVED)) {
      throw new Error(`Row ${n + 2}: number must be 1 to ${RESERVED} (the reserved founding numbers).`);
    }
    const email = (iEmail >= 0 ? r[iEmail]?.trim().toLowerCase() : '') || (number ? reservedEmail(number) : '');
    const amount = cents(r[iAmount]) - (iRefunded >= 0 ? cents(r[iRefunded]) : 0);
    const at = new Date(r[iDate]);
    if (!email || amount <= 0 || Number.isNaN(at.getTime())) return;
    gifts.push({
      id: `past:${iId >= 0 && r[iId] ? r[iId].trim() : `${email}:${at.toISOString()}:${amount}:${n}`}`,
      number,
      email,
      name: iName >= 0 ? r[iName]?.trim() || null : null,
      amountCents: amount,
      at: at.toISOString(),
    });
  });
  return gifts.sort((a, b) => a.at.localeCompare(b.at));
}

/** SQL that adds past donors in the order they first gave, then their gifts. */
export function importSql(gifts) {
  const lines = ['-- Past donors, oldest first, so they get the earliest founding numbers.'];
  const seen = new Set();
  // Reserved numbers first: fill the slot (keeps the placeholder email for anonymous donors).
  for (const g of gifts) {
    if (!g.number || seen.has(g.email)) continue;
    seen.add(g.email);
    const name = gifts.find((x) => x.email === g.email && x.name)?.name ?? null;
    lines.push(
      `UPDATE backers SET email = ${sql(g.email)}, wall_name = COALESCE(${sql(name ? name.slice(0, 60) : null)}, wall_name), first_gift_at = ${sql(g.at)} WHERE id = ${g.number} AND (email = ${sql(g.email)} OR email LIKE 'reserved-%') AND NOT EXISTS (SELECT 1 FROM backers WHERE email = ${sql(g.email)} AND id <> ${g.number});`,
    );
  }
  for (const g of gifts) {
    if (seen.has(g.email)) continue;
    seen.add(g.email);
    const first = gifts.find((x) => x.email === g.email && x.name)?.name ?? null;
    lines.push(
      // "Only if not already there" (not INSERT OR IGNORE, which would still use up a founding number).
      `INSERT INTO backers (email, wall_name, show_on_wall, show_badge, first_gift_at) SELECT ${sql(g.email)}, ${sql(first ? first.slice(0, 60) : null)}, 0, 0, ${sql(g.at)} WHERE NOT EXISTS (SELECT 1 FROM backers WHERE email = ${sql(g.email)});`,
    );
  }
  lines.push('-- Each gift once.');
  for (const g of gifts) {
    lines.push(
      `INSERT OR IGNORE INTO gifts (stripe_id, backer_id, amount_cents, kind, at) SELECT ${sql(g.id)}, id, ${g.amountCents}, 'past', ${sql(g.at)} FROM backers WHERE email = ${sql(g.email)}${g.number ? ` AND id = ${g.number}` : ''};`,
    );
  }
  lines.push('-- Totals from every recorded gift.');
  lines.push('UPDATE backers SET total_cents = (SELECT COALESCE(SUM(amount_cents), 0) FROM gifts WHERE gifts.backer_id = backers.id);');
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node import-past.mjs past-donors.csv > import.sql');
    process.exit(1);
  }
  const gifts = giftsFrom(readFileSync(file, 'utf8'));
  process.stdout.write(importSql(gifts));
  const donors = new Set(gifts.map((g) => g.email)).size;
  const total = gifts.reduce((s, g) => s + g.amountCents, 0);
  console.error(`${donors} past donors, ${gifts.length} gifts, $${(total / 100).toLocaleString('en-US')} in all. Now run: npx wrangler d1 execute civicsky-backers --remote --file import.sql`);
}

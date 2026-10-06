-- CivicSky backers (civ.works/pledge). Cloudflare D1.
-- A backer's id IS their founding number: assigned on the first gift, never reused.

CREATE TABLE IF NOT EXISTS backers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  wall_name TEXT,
  show_on_wall INTEGER NOT NULL DEFAULT 0,
  show_badge INTEGER NOT NULL DEFAULT 0,
  first_gift_at TEXT NOT NULL,
  total_cents INTEGER NOT NULL DEFAULT 0,
  monthly INTEGER NOT NULL DEFAULT 0
);

-- One row per Stripe payment, so a repeated webhook never counts a gift twice.
CREATE TABLE IF NOT EXISTS gifts (
  stripe_id TEXT PRIMARY KEY,
  backer_id INTEGER NOT NULL REFERENCES backers(id),
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL,
  checkout_session TEXT,
  at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS gifts_session ON gifts(checkout_session);

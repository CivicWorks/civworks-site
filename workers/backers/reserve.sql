-- Hold founding numbers #00001 to #00025 for earlier donors, so new backers
-- start at #00026. Run once, BEFORE any gift arrives:
--   npx wrangler d1 execute civicsky-backers --remote --file reserve.sql
-- Safe to run again. Reserved slots have no gifts, so they don't show in the
-- counter or on the Founders Wall until you fill them in (import-past.mjs).

INSERT OR IGNORE INTO backers (id, email, first_gift_at) VALUES
  (1, 'reserved-01', '2026-01-01T00:00:00.000Z'),
  (2, 'reserved-02', '2026-01-01T00:00:00.000Z'),
  (3, 'reserved-03', '2026-01-01T00:00:00.000Z'),
  (4, 'reserved-04', '2026-01-01T00:00:00.000Z'),
  (5, 'reserved-05', '2026-01-01T00:00:00.000Z'),
  (6, 'reserved-06', '2026-01-01T00:00:00.000Z'),
  (7, 'reserved-07', '2026-01-01T00:00:00.000Z'),
  (8, 'reserved-08', '2026-01-01T00:00:00.000Z'),
  (9, 'reserved-09', '2026-01-01T00:00:00.000Z'),
  (10, 'reserved-10', '2026-01-01T00:00:00.000Z'),
  (11, 'reserved-11', '2026-01-01T00:00:00.000Z'),
  (12, 'reserved-12', '2026-01-01T00:00:00.000Z'),
  (13, 'reserved-13', '2026-01-01T00:00:00.000Z'),
  (14, 'reserved-14', '2026-01-01T00:00:00.000Z'),
  (15, 'reserved-15', '2026-01-01T00:00:00.000Z'),
  (16, 'reserved-16', '2026-01-01T00:00:00.000Z'),
  (17, 'reserved-17', '2026-01-01T00:00:00.000Z'),
  (18, 'reserved-18', '2026-01-01T00:00:00.000Z'),
  (19, 'reserved-19', '2026-01-01T00:00:00.000Z'),
  (20, 'reserved-20', '2026-01-01T00:00:00.000Z'),
  (21, 'reserved-21', '2026-01-01T00:00:00.000Z'),
  (22, 'reserved-22', '2026-01-01T00:00:00.000Z'),
  (23, 'reserved-23', '2026-01-01T00:00:00.000Z'),
  (24, 'reserved-24', '2026-01-01T00:00:00.000Z'),
  (25, 'reserved-25', '2026-01-01T00:00:00.000Z');

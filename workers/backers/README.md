# civicsky-backers

Records CivicSky gifts from Stripe and serves the counter, Founders Wall, and
thank-you lookup for civ.works/pledge/pledge. Cloudflare Worker + D1 (free tier).

- `src/index.js` the Worker; `src/badges.js` badge thresholds (the only place to change them)
- `schema.sql` the database; `wrangler.toml` settings
- Tests: `node --no-warnings test/backers.test.mjs` (Node 22+, no install needed)
- Reserved numbers: `reserve.sql` holds #00001 to #00025 for earlier donors (run once, before any gift); new backers start at #00026.
- Filling them in: `node import-past.mjs past-donors.csv > import.sql` with a `number` column (1 to 25), then run it with wrangler. Email and name are optional. Donor files are git-ignored.
- Setup: see SETUP.md

# civicsky-backers

Records CivicSky gifts from Stripe and serves the counter, Founders Wall, and
thank-you lookup for civ.works/pledge/pledge. Cloudflare Worker + D1 (free tier).

- `src/index.js` the Worker; `src/badges.js` badge thresholds (the only place to change them)
- `schema.sql` the database; `wrangler.toml` settings
- Tests: `node --no-warnings test/backers.test.mjs` (Node 22+, no install needed)
- Setup: see SETUP.md

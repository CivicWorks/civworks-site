// CivicSky backer badges. The badge comes from a backer's total giving; the
// founding number comes from when they first gave. Dollar amounts are never
// shown publicly. Change the thresholds here only.

/** Badge thresholds in cents of total giving, lowest first. Any first gift earns Signal. */
export const BADGES = [
  { name: 'Signal', minCents: 0 },
  { name: 'Catalyst', minCents: 2_500 },
  { name: 'Builder', minCents: 5_000 },
  { name: 'Vanguard', minCents: 12_500 },
  { name: 'Foundry', minCents: 25_000 },
  { name: 'Charter', minCents: 50_000 },
  { name: 'Cornerstone', minCents: 250_000 },
];

/** "Founding 1,000", "Founding 5,000", ... : how early a backer arrived. */
export const FOUNDING_BANDS = [1_000, 5_000, 10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000];

export function badgeFor(totalCents) {
  let badge = BADGES[0].name;
  for (const b of BADGES) if (totalCents >= b.minCents) badge = b.name;
  return badge;
}

export function foundingBand(number) {
  const band = FOUNDING_BANDS.find((b) => number <= b);
  return band ? `Founding ${band.toLocaleString('en-US')}` : null;
}

/** "#00841": five digits until the numbers outgrow them. */
export function formatNumber(number) {
  return `#${String(number).padStart(5, '0')}`;
}

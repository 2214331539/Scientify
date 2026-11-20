// Early pricing: points are charged at the upstream cost plus 10%. One point is ¥0.01
// at the selling price, so a cost of ¥2 per million tokens sells for 220 points.

export const POINTS_PER_YUAN = 100;
export const MARKUP = 1.1;
/** Margin the prices are expected to keep; below it the admin overview warns. */
export const MIN_MARGIN = Math.floor((1 - 1 / MARKUP) * 100);

/** Points per million tokens for a cost in yuan per million tokens, rounded up. */
export function autoPrice(cost) {
  const value = Number(cost);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // toFixed drops float noise (2 × 100 × 1.1 is 220.00000000000003) before rounding up.
  return Math.ceil(Number((value * POINTS_PER_YUAN * MARKUP).toFixed(6)));
}

/** Fills the prices from the costs: all of them when asked, otherwise the ones left at 0. */
export function withAutoPrices(model, all = false) {
  const next = { ...model };
  for (const [price, cost] of [
    ['priceInput', 'costInput'],
    ['priceCached', 'costCached'],
    ['priceOutput', 'costOutput'],
  ])
    if (all || !next[price]) next[price] = autoPrice(next[cost]);
  return next;
}

/**
 * Money transforms. Everything downstream is an integer in the currency's minor
 * unit — see canonical-order.model.ts for why floats are not an option here.
 */

/** BRL and MXN both have two decimal places. Revisit for JPY (0) or KWD (3). */
const MINOR_UNITS_PER_MAJOR = 100;

/**
 * "29.90" -> 2990.
 *
 * The rounding is load-bearing, not defensive: 5.49 * 100 is 549.0000000000001 in
 * IEEE-754. Truncating would give 549 here but 889 for 8.90 (890.0000000000001 ->
 * 890 is fine, but 0.29 * 100 = 28.999999999999996 truncates to 28). Rounding is
 * the only correct step across the whole range.
 */
export function toMinorUnits(major: number): number {
  return Math.round(major * MINOR_UNITS_PER_MAJOR);
}

/**
 * BairroBox and GlobalGoods both price a LINE, not a unit — the canonical model
 * wants a unit price, so it has to be derived.
 *
 * Returns undefined when the quantity is zero. That is the divide-by-zero the feeds
 * plant on purpose (BairroBox's "Cafe 500g|x0|0", GlobalGoods' Limon with amount 0),
 * and the caller turns it into a dropped line with a reason rather than persisting
 * an Infinity or a NaN.
 */
export function unitPriceFromLineTotal(
  lineTotalMinor: number,
  quantity: number,
): number | undefined {
  if (quantity <= 0) {
    return undefined;
  }

  return Math.round(lineTotalMinor / quantity);
}

/** The order total, summed in minor units so it cannot drift. */
export function sumLineTotals(
  items: { quantity: number; unitPrice: { amount: number } }[],
): number {
  return items.reduce(
    (total, item) => total + Math.round(item.unitPrice.amount * item.quantity),
    0,
  );
}

/**
 * What happens to a record that is not perfect.
 *
 * The distinction that matters: an infrastructure error (their API is down) is an
 * exception and propagates. A bad RECORD is data — it is captured with a reason and
 * the rest of the batch keeps going. One poisoned order must never take down a poll
 * cycle, and it must never disappear silently either.
 */

/** The record cannot become a canonical order. It is not persisted. */
export interface MappingFailure {
  customerId: string;
  /** Absent when the payload is so broken we could not even find their id. */
  externalOrderId?: string;
  field: string;
  reason: string;
  at: string;
}

/**
 * The record IS persisted, but something about it is off and someone should know.
 * Dropping the order would lose real business; hiding the problem would be worse.
 */
export interface DataWarning {
  customerId: string;
  externalOrderId: string;
  field: string;
  reason: string;
  at: string;
}

export const WARNING_REASONS = {
  emptyStoreCode:
    'store code is empty — order is incomplete but still fulfillable',
  zeroPrice:
    'line total is 0 — kept at zero price, the goods were still ordered and must still be picked',
  droppedZeroQuantityLine:
    'line dropped: quantity is 0, which is unorderable and would divide by zero when deriving a unit price',
} as const;

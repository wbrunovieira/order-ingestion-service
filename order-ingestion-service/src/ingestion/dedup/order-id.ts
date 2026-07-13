import { createHash } from 'node:crypto';

/**
 * The identity of an order, derived from the only two things that are stable about
 * it: which customer it came from, and what THEY call it.
 *
 * Deriving the id (rather than generating one) is what makes ingestion idempotent.
 * The pollers have no cursor and re-read the same orders every cycle — and the mock
 * feeds even repeat an order twice inside a single response — so the same order has
 * to land on the same row every time, whether it arrives twice in one batch or
 * again fifteen minutes later.
 *
 * Hashing rather than concatenating keeps the id opaque and fixed-length, so it can
 * be used as a key or in a URL without leaking the customer's own identifiers.
 *
 * The ':' separator is unambiguous because customer ids come from the registry and
 * are slugs — no customer id can contain one.
 */
export function stableOrderId(
  customerId: string,
  externalOrderId: string,
): string {
  return createHash('sha256')
    .update(`${customerId}:${externalOrderId}`)
    .digest('hex')
    .slice(0, 32);
}

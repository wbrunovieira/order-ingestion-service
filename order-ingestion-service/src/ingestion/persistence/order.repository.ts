import type { CanonicalOrder } from '../../orders/canonical-order.model';

export interface StoredOrder extends CanonicalOrder {
  /** When we first saw this order. Never changes on re-ingestion. */
  ingestedAt: string;
  /** When we last wrote it. Moves every time a poll brings a newer version. */
  updatedAt: string;
}

export interface UpsertResult {
  order: StoredOrder;
  /** False when the order already existed — a re-read, not a new order. */
  created: boolean;
}

/**
 * The persistence boundary, as an abstract class so it doubles as a Nest DI token.
 *
 * The implementation is in-memory: the brief says not to spend the budget on infra,
 * and a Map satisfies every requirement here. Swapping it for SQLite or Postgres is
 * a `useClass` in one module — nothing upstream of this interface knows or cares.
 */
export abstract class OrderRepository {
  /**
   * Write an order by its stable id, creating it or overwriting it.
   *
   * This is an UPSERT and deliberately not "insert, ignoring duplicates". A polled
   * order that we have seen before may come back with a NEW STATUS (received ->
   * picking): treating it as a duplicate and dropping it would silently discard the
   * update. So the same order always occupies exactly one row, and the latest read
   * wins.
   */
  abstract upsert(order: CanonicalOrder): Promise<UpsertResult>;

  abstract findById(orderId: string): Promise<StoredOrder | undefined>;

  abstract findAll(): Promise<StoredOrder[]>;

  abstract count(): Promise<number>;
}

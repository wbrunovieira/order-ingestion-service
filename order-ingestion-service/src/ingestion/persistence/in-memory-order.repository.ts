import { Injectable } from '@nestjs/common';
import type { CanonicalOrder } from '../../orders/canonical-order.model';
import {
  OrderRepository,
  type StoredOrder,
  type UpsertResult,
} from './order.repository';

/**
 * A Map keyed by the stable orderId. That key IS the idempotency: writing the same
 * order twice can only ever produce one entry, whether the repeat arrives inside a
 * single batch or on the next poll fifteen minutes later.
 */
/*
 * The methods return promises without being `async`: the interface is async because
 * a real database is, but a Map is not, and pretending otherwise only adds a
 * microtask. The signature is what a future SQLite or Postgres implementation has to
 * honour — the caller cannot tell the difference.
 */
@Injectable()
export class InMemoryOrderRepository extends OrderRepository {
  private readonly orders = new Map<string, StoredOrder>();

  upsert(order: CanonicalOrder): Promise<UpsertResult> {
    const now = new Date().toISOString();
    const existing = this.orders.get(order.orderId);

    // Last read wins. The customers send no version or updatedAt of their own, so
    // there is nothing to compare against and the freshest read is the best
    // information we have. DESIGN.md covers what changes when a source DOES expose
    // a version: the write becomes conditional, to survive out-of-order delivery.
    const stored: StoredOrder = {
      ...order,
      ingestedAt: existing?.ingestedAt ?? now,
      updatedAt: now,
    };

    this.orders.set(order.orderId, stored);

    return Promise.resolve({ order: stored, created: existing === undefined });
  }

  findById(orderId: string): Promise<StoredOrder | undefined> {
    return Promise.resolve(this.orders.get(orderId));
  }

  findAll(): Promise<StoredOrder[]> {
    return Promise.resolve([...this.orders.values()]);
  }

  count(): Promise<number> {
    return Promise.resolve(this.orders.size);
  }
}

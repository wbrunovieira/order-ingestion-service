import { Injectable } from '@nestjs/common';
import type { OrderStatus } from '../orders/order-status';
import {
  CUSTOMERS,
  type CustomerConfig,
  type PullCustomerConfig,
} from './customer.config';

/**
 * The single place anything asks "who is this customer and how do they behave?".
 *
 * The pollers ask it which customers are pull-mode and on what interval; the
 * webhook asks it whether a :customer path segment is one we know. Neither has to
 * know a customer id, so neither changes when one is added.
 */
@Injectable()
export class CustomerRegistryService {
  private readonly customers: ReadonlyMap<string, CustomerConfig> = new Map(
    Object.entries(CUSTOMERS),
  );

  /** Undefined rather than a throw: an unknown :customer is a 404, not a crash. */
  find(id: string): CustomerConfig | undefined {
    return this.customers.get(id);
  }

  all(): CustomerConfig[] {
    return [...this.customers.values()];
  }

  /** The customers a scheduler has to poll, each with its own interval and limit. */
  pullCustomers(): PullCustomerConfig[] {
    return this.all().filter(
      (customer): customer is PullCustomerConfig => customer.mode === 'pull',
    );
  }
}

/**
 * Their status word or code onto ours, via config alone.
 *
 * Returns undefined for anything unmapped — the caller turns that into a failure
 * with a reason. It must never fall back to a default: silently calling an unknown
 * state `received` would misreport a real order, and the customer changing their
 * status vocabulary is exactly the kind of contract drift we want to see.
 */
export function resolveStatus(
  config: CustomerConfig,
  rawStatus: unknown,
): OrderStatus | undefined {
  // Only a scalar can name a status. Anything else (an object, an array) would
  // stringify to "[object Object]" and could collide with a real key.
  if (typeof rawStatus !== 'string' && typeof rawStatus !== 'number') {
    return undefined;
  }

  // One map serves both vocabularies: GlobalGoods' integer codes and BairroBox's
  // words become the same kind of key.
  const key = String(rawStatus).trim();
  return Object.hasOwn(config.statusMap, key)
    ? config.statusMap[key]
    : undefined;
}

import type { OrderStatus } from './order-status';

/**
 * An amount of money, held as an INTEGER in the currency's minor unit (cents).
 * `{ amount: 549, currency: 'BRL' }` is R$ 5,49.
 *
 * This is not pedantry — it is the fixture data. Summed as floats, FreshMart's
 * sample order totals 6 x 5.49 + 2 x 8.90 = 50.739999999999995, and BairroBox's
 * unit price works out to 32.94 / 6 = 5.489999999999999. In minor units both are
 * exact. Floats accrue error the moment they are summed, and this is a
 * payments-adjacent domain, so amounts stay integers end to end. Formatting for
 * humans is a presentation concern, not a storage one.
 */
export interface Money {
  amount: number;
  currency: string;
}

export interface StoreRef {
  storeId: string;
  name: string;
}

export interface OrderItem {
  sku: string;
  name: string;
  /** Units, or a weight when the customer sells by kg (GlobalGoods sends 1.5). */
  quantity: number;
  unitPrice: Money;
}

export interface DeliveryAddress {
  line1: string;
  city: string;
  /** ISO-3166-1 alpha-2. GlobalGoods sends "Mexico"; it is normalized to "MX". */
  country: string;
}

/**
 * The one order shape the rest of the platform sees. Everything downstream of the
 * pipeline depends on this and on nothing customer-specific.
 */
export interface CanonicalOrder {
  /** System-generated and stable: hash(customerId + ':' + externalOrderId). */
  orderId: string;
  /** The customer's own id, as they sent it. */
  externalOrderId: string;
  /** Which integration this arrived from ('freshmart' | 'bairrobox' | ...). */
  customerId: string;
  status: OrderStatus;
  /** ISO-8601, always UTC. Sources that send local time declare their timezone. */
  createdAt: string;
  store: StoreRef;
  items: OrderItem[];
  total: Money;
  deliveryAddress: DeliveryAddress;
}

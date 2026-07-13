import type { OrderStatus } from '../orders/order-status';

/**
 * A customer is a CONFIG ENTRY, not a code path.
 *
 * Everything that differs between integrations lives here: how their orders reach
 * us (push or pull), how often, under what rate limit, what timezone their
 * timestamps are in, what they call their statuses, and what they leave out. The
 * pipeline reads this — it never branches on a customer id.
 *
 * Onboarding a new customer means adding an entry below. Only a genuinely new data
 * FORMAT needs code, and then only one mapper (see README, "How to onboard a new
 * customer").
 */

export type IngestionMode = 'push' | 'pull';

/** Identifies the mapper that turns this customer's raw payload into a candidate order. */
export type MapperId = 'freshmart' | 'bairrobox' | 'globalgoods';

export interface RateLimit {
  requestsPerMinute: number;
}

export interface PullSource {
  url: string;
  /** GlobalGoods pages its results; BairroBox returns one flat array. */
  paginated: boolean;
  pollIntervalMs: number;
  rateLimit?: RateLimit;
}

interface BaseCustomerConfig {
  id: string;
  name: string;
  mapper: MapperId;

  /**
   * The IANA timezone the customer's local timestamps are in.
   *
   * BairroBox sends "20/06/2026 10:40" and GlobalGoods "06-20-2026 08:50 AM" —
   * neither carries an offset, so converting to UTC is impossible without an
   * assumption. The assumption is declared here rather than buried in a mapper,
   * because getting it wrong is a silent 3-6 hour error on every order.
   */
  timezone: string;

  /** Used when the feed omits the currency entirely (BairroBox does). */
  defaultCurrency: string;

  /** Used when the feed omits the country entirely (BairroBox does). */
  defaultCountry: string;

  /**
   * Their status vocabulary onto ours. Keys are strings so integer codes
   * (GlobalGoods) and words (BairroBox) share one mechanism.
   *
   * A value NOT in this map is a mapping failure with a reason — never a silent
   * default, which would quietly assign the wrong state to a real order.
   */
  statusMap: Readonly<Record<string, OrderStatus>>;
}

export interface PushCustomerConfig extends BaseCustomerConfig {
  mode: 'push';
}

export interface PullCustomerConfig extends BaseCustomerConfig {
  mode: 'pull';
  source: PullSource;
}

/** Discriminated so a pull customer cannot be declared without a source. */
export type CustomerConfig = PushCustomerConfig | PullCustomerConfig;

const MOCK_API_BASE_URL =
  process.env.CUSTOMER_APIS_BASE_URL ?? 'http://localhost:4000';

export const CUSTOMERS = {
  /**
   * FreshMart — enterprise, pushes clean JSON at us in real time. Already sends
   * UTC and ISO-4217/ISO-3166 codes, so the defaults below are never exercised;
   * they are declared anyway so every customer is described the same way.
   */
  freshmart: {
    id: 'freshmart',
    name: 'FreshMart',
    mode: 'push',
    mapper: 'freshmart',
    timezone: 'UTC',
    defaultCurrency: 'BRL',
    defaultCountry: 'BR',
    statusMap: {
      NEW: 'received',
    },
  },

  /**
   * BairroBox — SMB, no webhook capability, so we poll their flat export every
   * ~15 minutes. They send no currency and no country at all.
   *
   * "Em entrega" (out for delivery) has no exact canonical match: it is past
   * `ready` but not `delivered`. It maps to the closest NON-TERMINAL state rather
   * than to `delivered`, which would falsely close an order that is still in
   * someone's hands. Flagged in the README as a contract gap to raise with them.
   */
  bairrobox: {
    id: 'bairrobox',
    name: 'BairroBox',
    mode: 'pull',
    mapper: 'bairrobox',
    timezone: 'America/Sao_Paulo',
    defaultCurrency: 'BRL',
    defaultCountry: 'BR',
    source: {
      url: `${MOCK_API_BASE_URL}/customer-b/orders`,
      paginated: false,
      pollIntervalMs: 15 * 60 * 1000,
    },
    statusMap: {
      Novo: 'received',
      'Em separacao': 'picking',
      Separado: 'ready',
      'Em entrega': 'ready',
      Entregue: 'delivered',
      Cancelado: 'cancelled',
    },
  },

  /**
   * GlobalGoods — international, paginated, rate-limited at 60 req/min.
   *
   * Their status codes run 1..5 and 4 never appears in their data. It is mapped to
   * `delivered` by inference from the sequence; any code outside this map is a
   * failure with a reason, not a guess.
   */
  globalgoods: {
    id: 'globalgoods',
    name: 'GlobalGoods',
    mode: 'pull',
    mapper: 'globalgoods',
    timezone: 'America/Mexico_City',
    defaultCurrency: 'MXN',
    defaultCountry: 'MX',
    source: {
      url: `${MOCK_API_BASE_URL}/customer-c/orders`,
      paginated: true,
      pollIntervalMs: 5 * 60 * 1000,
      rateLimit: { requestsPerMinute: 60 },
    },
    statusMap: {
      '1': 'received',
      '2': 'picking',
      '3': 'ready',
      '4': 'delivered',
      '5': 'cancelled',
    },
  },
} as const satisfies Record<string, CustomerConfig>;

export type CustomerId = keyof typeof CUSTOMERS;

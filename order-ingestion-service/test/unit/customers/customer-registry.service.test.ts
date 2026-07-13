import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMERS } from '../../../src/customers/customer.config';
import {
  CustomerRegistryService,
  resolveStatus,
} from '../../../src/customers/customer-registry.service';

/**
 * The status maps are read against the customers' REAL feeds, not against a
 * hand-written list. If a customer starts sending a status they never sent before,
 * these fail — which is the cheapest contract-drift detector we have, and exactly
 * the failure we would rather see in CI than in production.
 */
const FIXTURES = resolve(__dirname, '../../../../mock-customer-apis/fixtures');

function readFixture<T>(file: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, file), 'utf8')) as T;
}

describe('CustomerRegistryService', () => {
  const registry = new CustomerRegistryService();

  it('resolves a known customer and returns undefined for an unknown one', () => {
    expect(registry.find('bairrobox')?.name).toBe('BairroBox');
    expect(registry.find('not-a-customer')).toBeUndefined();
  });

  it('lists exactly the customers a scheduler has to poll', () => {
    const polled = registry.pullCustomers().map((customer) => customer.id);

    expect(polled).toEqual(['bairrobox', 'globalgoods']);
    expect(polled).not.toContain('freshmart'); // push — it calls us
  });

  it('carries the cadence and limits of each pull customer as config, not code', () => {
    const [bairrobox, globalgoods] = registry.pullCustomers();

    expect(bairrobox.source.pollIntervalMs).toBe(15 * 60 * 1000);
    expect(bairrobox.source.pagination).toBeUndefined(); // one flat array

    expect(globalgoods.source.pollIntervalMs).toBe(5 * 60 * 1000);
    expect(globalgoods.source.rateLimit?.requestsPerMinute).toBe(60);
    // Described, not coded: the reader walks any paginated source from this alone.
    expect(globalgoods.source.pagination).toMatchObject({
      pageParam: 'page',
      startPage: 1,
      recordsField: 'orders',
      hasMoreField: 'hasMore',
    });
  });

  it('declares a source timezone for every customer sending local time', () => {
    expect(CUSTOMERS.bairrobox.timezone).toBe('America/Sao_Paulo');
    expect(CUSTOMERS.globalgoods.timezone).toBe('America/Mexico_City');
    expect(CUSTOMERS.freshmart.timezone).toBe('UTC'); // already sends an offset
  });
});

describe('resolveStatus', () => {
  it('maps every status FreshMart actually sends', () => {
    const order = readFixture<{ state: string }>('customer-a.sample.json');

    expect(resolveStatus(CUSTOMERS.freshmart, order.state)).toBe('received');
  });

  it('maps every status BairroBox actually sends', () => {
    const orders = readFixture<{ situacao: string }[]>(
      'customer-b.fixtures.json',
    );
    const distinct = [...new Set(orders.map((order) => order.situacao))];

    expect(distinct.length).toBeGreaterThan(0);
    for (const situacao of distinct) {
      expect(
        resolveStatus(CUSTOMERS.bairrobox, situacao),
        `BairroBox sends "${situacao}" but nothing maps it`,
      ).toBeDefined();
    }
  });

  it('maps every status GlobalGoods actually sends, integer codes included', () => {
    const orders = readFixture<{ order_status: number }[]>(
      'customer-c.fixtures.json',
    );
    const distinct = [...new Set(orders.map((order) => order.order_status))];

    expect(distinct.length).toBeGreaterThan(0);
    for (const code of distinct) {
      expect(
        resolveStatus(CUSTOMERS.globalgoods, code),
        `GlobalGoods sends ${code} but nothing maps it`,
      ).toBeDefined();
    }
  });

  it('maps "Em entrega" to a non-terminal state, never to delivered', () => {
    // Out-for-delivery has no canonical equivalent. Closing the order would be a
    // lie; the order is still in someone's hands.
    const status = resolveStatus(CUSTOMERS.bairrobox, 'Em entrega');

    expect(status).toBe('ready');
    expect(status).not.toBe('delivered');
  });

  it('returns undefined for an unmapped status instead of defaulting silently', () => {
    expect(resolveStatus(CUSTOMERS.bairrobox, 'Extraviado')).toBeUndefined();
    expect(resolveStatus(CUSTOMERS.globalgoods, 99)).toBeUndefined();
    expect(resolveStatus(CUSTOMERS.freshmart, undefined)).toBeUndefined();
  });

  it('refuses a non-scalar status rather than stringifying it into a key', () => {
    expect(
      resolveStatus(CUSTOMERS.bairrobox, { situacao: 'Novo' }),
    ).toBeUndefined();
    expect(resolveStatus(CUSTOMERS.bairrobox, ['Novo'])).toBeUndefined();
  });
});

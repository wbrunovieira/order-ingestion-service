import { describe, expect, it } from 'vitest';
import { validateCanonicalOrder } from '../../../src/orders/canonical-order.validator';

/**
 * These assert the canonical contract itself: what the platform will and will not
 * accept, independent of any customer. Each rejection here is a decision from the
 * README made executable — the traps in the real feeds are covered per-customer in
 * the mapper suites.
 */

function validOrder(): Record<string, unknown> {
  return {
    orderId: 'a3f1c0',
    externalOrderId: 'FM-100245',
    customerId: 'freshmart',
    status: 'received',
    createdAt: '2026-06-20T14:32:00.000Z',
    store: { storeId: 'SP-014', name: 'FreshMart Pinheiros' },
    items: [
      {
        sku: '7891000',
        name: 'Leite Integral 1L',
        quantity: 6,
        unitPrice: { amount: 549, currency: 'BRL' },
      },
    ],
    total: { amount: 3294, currency: 'BRL' },
    deliveryAddress: {
      line1: 'Rua dos Pinheiros 123',
      city: 'Sao Paulo',
      country: 'BR',
    },
  };
}

/** Reject, and say which field and why — a failure with no reason is a silent one. */
function expectRejected(candidate: unknown, field: string) {
  const outcome = validateCanonicalOrder(candidate);

  expect(outcome.valid).toBe(false);
  if (outcome.valid) return;

  const failure = outcome.errors.find((error) => error.field === field);
  expect(failure, `expected a failure on "${field}"`).toBeDefined();
  expect(failure?.message).toBeTruthy();
}

describe('validateCanonicalOrder', () => {
  it('accepts a well-formed canonical order', () => {
    const outcome = validateCanonicalOrder(validOrder());

    expect(outcome.valid).toBe(true);
    if (!outcome.valid) return;
    expect(outcome.order.orderId).toBe('a3f1c0');
    expect(outcome.order.total.amount).toBe(3294);
  });

  describe('money is integer minor units', () => {
    it('rejects a float amount, so a mapper that forgets to convert fails loudly', () => {
      const order = validOrder();
      order.total = { amount: 50.74, currency: 'BRL' };

      expectRejected(order, 'total.amount');
    });

    it('rejects an unknown currency code', () => {
      const order = validOrder();
      order.total = { amount: 5074, currency: 'REAIS' };

      expectRejected(order, 'total.currency');
    });

    it('accepts a zero price: a free line is a pricing anomaly, not an invalid order', () => {
      const order = validOrder();
      order.items = [
        {
          sku: 'BB-FEIJAO',
          name: 'Feijao 1kg',
          quantity: 3,
          unitPrice: { amount: 0, currency: 'BRL' },
        },
      ];

      expect(validateCanonicalOrder(order).valid).toBe(true);
    });
  });

  describe('items', () => {
    it('rejects quantity 0 — an unorderable line, and the divide-by-zero source', () => {
      const order = validOrder();
      order.items = [
        {
          sku: 'BB-CAFE',
          name: 'Cafe 500g',
          quantity: 0,
          unitPrice: { amount: 0, currency: 'BRL' },
        },
      ];

      expectRejected(order, 'items.0.quantity');
    });

    it('accepts a fractional quantity — GlobalGoods sells by the kg', () => {
      const order = validOrder();
      order.items = [
        {
          sku: 'A12',
          name: 'Avocado (by kg)',
          quantity: 1.5,
          unitPrice: { amount: 9000, currency: 'MXN' },
        },
      ];
      order.total = { amount: 13500, currency: 'MXN' };

      expect(validateCanonicalOrder(order).valid).toBe(true);
    });

    it('rejects an order with no items', () => {
      const order = validOrder();
      order.items = [];

      expectRejected(order, 'items');
    });
  });

  describe('delivery address', () => {
    it('rejects an empty address — an order we cannot deliver is not actionable', () => {
      const order = validOrder();
      order.deliveryAddress = { line1: '', city: '', country: 'BR' };

      expectRejected(order, 'deliveryAddress.line1');
    });

    it('rejects a full country name, forcing the mapper to normalize it to ISO', () => {
      const order = validOrder();
      order.deliveryAddress = {
        line1: 'Paseo de la Reforma 222',
        city: 'Mexico City',
        country: 'Mexico',
      };

      expectRejected(order, 'deliveryAddress.country');
    });
  });

  describe('store', () => {
    it('accepts an empty store code — incomplete, but not unfulfillable', () => {
      const order = validOrder();
      order.store = { storeId: '', name: 'BairroBox Centro' };

      expect(validateCanonicalOrder(order).valid).toBe(true);
    });
  });

  describe('status and time', () => {
    it('rejects a status outside the canonical enum', () => {
      const order = validOrder();
      order.status = 'Em entrega';

      expectRejected(order, 'status');
    });

    it('rejects a local timestamp that was never converted to UTC', () => {
      const order = validOrder();
      order.createdAt = '20/06/2026 10:40';

      expectRejected(order, 'createdAt');
    });
  });

  it('reports every reason at once, not just the first', () => {
    const outcome = validateCanonicalOrder({});

    expect(outcome.valid).toBe(false);
    if (outcome.valid) return;
    expect(outcome.errors.length).toBeGreaterThan(1);
    expect(outcome.errors.every((error) => error.field && error.message)).toBe(
      true,
    );
  });
});

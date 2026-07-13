import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMERS } from '../../../src/customers/customer.config';
import { BairroboxMapper } from '../../../src/ingestion/normalization/mappers/bairrobox.mapper';

const FIXTURES = resolve(__dirname, '../../../../mock-customer-apis/fixtures');

interface RawBairroboxOrder {
  id: string;
  shop: string;
  date: string;
  situacao: string;
  items: string;
  endereco: string;
  store_code: string;
}

/** Their real feed, so the traps under test are the ones they actually send. */
const FEED: RawBairroboxOrder[] = JSON.parse(
  readFileSync(resolve(FIXTURES, 'customer-b.fixtures.json'), 'utf8'),
) as RawBairroboxOrder[];

function orderById(id: string): RawBairroboxOrder {
  const order = FEED.find((candidate) => candidate.id === id);
  if (order === undefined) throw new Error(`fixture ${id} is gone`);

  return order;
}

describe('BairroboxMapper', () => {
  const mapper = new BairroboxMapper();
  const config = CUSTOMERS.bairrobox;

  it('maps a clean order end to end', () => {
    // "5580": Arroz 5kg|x1|29.90, Rua Augusta 500, Novo, 20/06/2026 10:40
    const result = mapper.map(orderById('5580'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order).toMatchObject({
      externalOrderId: '5580',
      customerId: 'bairrobox',
      status: 'received', // Novo
      createdAt: '2026-06-20T13:40:00.000Z', // 10:40 in Sao Paulo
      store: { storeId: 'BB-01', name: 'BairroBox Centro' },
      total: { amount: 2990, currency: 'BRL' }, // no currency in their feed
      deliveryAddress: {
        line1: 'Rua Augusta 500',
        city: 'Sao Paulo',
        country: 'BR', // no country in their feed either
      },
    });

    expect(result.order.items).toEqual([
      {
        sku: 'bairrobox:arroz-5kg', // synthesized: they send no product code
        name: 'Arroz 5kg',
        quantity: 1,
        unitPrice: { amount: 2990, currency: 'BRL' },
      },
    ]);
  });

  it('derives a unit price from the LINE total, not the other way round', () => {
    // "5581": Feijao 1kg|x2|15.80 -> 1580 / 2 = 790 per unit; Oleo|x1|8.50 -> 850.
    const result = mapper.map(orderById('5581'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order.items.map((item) => item.unitPrice.amount)).toEqual([
      790, 850,
    ]);
    expect(result.order.total.amount).toBe(2430); // 1580 + 850, their line totals
  });

  it('maps every Portuguese status onto the canonical vocabulary', () => {
    const statuses = FEED.map((order) => {
      const result = mapper.map(order, config);
      return result.ok ? result.order.status : undefined;
    });

    // No record fails because of its status — every situacao in their feed is mapped.
    expect(statuses.filter((status) => status === undefined)).toHaveLength(1); // 5584: empty address, not status
    expect(new Set(statuses)).toContain('picking'); // Em separacao
    expect(new Set(statuses)).toContain('delivered'); // Entregue
    expect(new Set(statuses)).toContain('cancelled'); // Cancelado
  });

  describe('the traps in their data', () => {
    it('drops a zero-quantity line without dividing by zero, and keeps the order', () => {
      // "5583": Cafe 500g|x0|0 (unorderable) + Acucar 1kg|x1|6.20 (fine)
      const result = mapper.map(orderById('5583'), config);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.order.items).toHaveLength(1);
      expect(result.order.items[0].name).toBe('Acucar 1kg');
      expect(result.order.total.amount).toBe(620);

      // Never Infinity, never NaN — and never silent.
      expect(result.order.items[0].unitPrice.amount).toBe(620);
      expect(result.warnings[0].reason).toMatch(/quantity is 0/);
      expect(result.warnings[0].externalOrderId).toBe('5583');
    });

    it('keeps a zero-PRICED line, because the goods were still ordered', () => {
      // "5582": Arroz 5kg|x2|59.80 + Feijao 1kg|x3|0. The beans are free, not absent —
      // a picker still has to put three bags in the bag.
      const result = mapper.map(orderById('5582'), config);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.order.items).toHaveLength(2);
      expect(result.order.items[1]).toMatchObject({
        name: 'Feijao 1kg',
        quantity: 3,
        unitPrice: { amount: 0, currency: 'BRL' },
      });
      expect(result.order.total.amount).toBe(5980); // 5980 + 0
      expect(
        result.warnings.some((w) => /line total is 0/i.test(w.reason)),
      ).toBe(true);
    });

    it('rejects the order with an empty address, because it cannot be delivered', () => {
      // "5584": endereco: ""
      const result = mapper.map(orderById('5584'), config);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      const [failure] = result.failures;
      expect(failure.externalOrderId).toBe('5584');
      expect(failure.field).toBe('endereco');
      expect(failure.reason).toMatch(/undeliverable/);
    });

    it('flags an empty store code but still ingests the order', () => {
      // "5581" and "5582" carry store_code: "" — incomplete, not unfulfillable.
      const result = mapper.map(orderById('5581'), config);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.order.store.storeId).toBe('');
      expect(
        result.warnings.some((w) => /store code is empty/.test(w.reason)),
      ).toBe(true);
    });
  });

  describe('malformed input', () => {
    it('captures an unmapped status rather than defaulting', () => {
      const result = mapper.map(
        { ...orderById('5580'), situacao: 'Extraviado' },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('situacao');
    });

    it('captures an unparseable date rather than inventing one', () => {
      const result = mapper.map(
        { ...orderById('5580'), date: '2026-06-20 10:40' },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('date');
    });

    it('captures a malformed item string with a reason', () => {
      const result = mapper.map(
        { ...orderById('5580'), items: 'this is not an item' },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('items.0');
      expect(result.failures[0].reason).toMatch(
        /expected "name\|xQuantity\|lineTotal"/,
      );
    });
  });
});

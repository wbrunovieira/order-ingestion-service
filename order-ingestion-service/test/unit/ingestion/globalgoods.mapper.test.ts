import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUSTOMERS } from '../../../src/customers/customer.config';
import { GlobalgoodsMapper } from '../../../src/ingestion/normalization/mappers/globalgoods.mapper';

const FIXTURES = resolve(__dirname, '../../../../mock-customer-apis/fixtures');

interface RawGlobalgoodsOrder {
  reference: string;
  location: { code: string; label: string };
  timestamp: string;
  order_status: number;
  money: { currency: string; unit: string };
  products: {
    code: string;
    title: string;
    amount: number;
    uom: string;
    line_total: number;
  }[];
  destination: { address: string; city: string; country: string };
}

const FEED: RawGlobalgoodsOrder[] = JSON.parse(
  readFileSync(resolve(FIXTURES, 'customer-c.fixtures.json'), 'utf8'),
) as RawGlobalgoodsOrder[];

function orderByRef(reference: string): RawGlobalgoodsOrder {
  const order = FEED.find((candidate) => candidate.reference === reference);
  if (order === undefined) throw new Error(`fixture ${reference} is gone`);

  return order;
}

describe('GlobalgoodsMapper', () => {
  const mapper = new GlobalgoodsMapper();
  const config = CUSTOMERS.globalgoods;

  it('maps a clean order end to end', () => {
    // GG_77530: 1 x Tortilla, line_total 3200 CENTS, 06-20-2026 08:50 AM, status 1
    const result = mapper.map(orderByRef('GG_77530'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order).toMatchObject({
      externalOrderId: 'GG_77530',
      customerId: 'globalgoods',
      status: 'received', // 1
      createdAt: '2026-06-20T14:50:00.000Z', // 08:50 in Mexico City
      store: { storeId: 'MX-CDMX-01', name: 'GlobalGoods Reforma' },
      total: { amount: 3200, currency: 'MXN' },
      deliveryAddress: {
        line1: 'Paseo de la Reforma 222',
        city: 'Mexico City',
        country: 'MX', // they send the full name "Mexico"
      },
    });
  });

  it('keeps cents as cents instead of multiplying them again', () => {
    // The one feed where converting would BE the bug: 3200 is already 32.00 MXN.
    const result = mapper.map(orderByRef('GG_77530'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.order.items[0].unitPrice.amount).toBe(3200);
    expect(result.order.total.amount).toBe(3200); // not 320000
  });

  it('treats a weight as a weight: 1.5 kg of avocado, priced per kilo', () => {
    // GG_77531: Avocado 1.5 kg, line_total 13500 -> 9000 cents (90.00 MXN) per kg,
    // plus 2 x Tortillas at 4400 -> 2200 each.
    const result = mapper.map(orderByRef('GG_77531'), config);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [avocado, tortillas] = result.order.items;
    expect(avocado).toMatchObject({
      sku: 'A12',
      quantity: 1.5, // NOT rounded to 2 — that would invent a kilo of avocado
      unitPrice: { amount: 9000, currency: 'MXN' },
    });
    expect(tortillas.unitPrice.amount).toBe(2200);

    // The total is THEIR line totals summed, not our derived unit prices multiplied
    // back out — which for a fractional kg would round differently.
    expect(result.order.total.amount).toBe(17900); // 13500 + 4400
  });

  it('maps every integer status code they send', () => {
    const statuses = FEED.map((order) => {
      const result = mapper.map(order, config);
      return result.ok ? result.order.status : undefined;
    });

    expect(statuses).not.toContain(undefined);
    expect(new Set(statuses)).toContain('received'); // 1
    expect(new Set(statuses)).toContain('picking'); // 2
    expect(new Set(statuses)).toContain('ready'); // 3
    expect(new Set(statuses)).toContain('cancelled'); // 5
  });

  describe('the traps in their data', () => {
    it('drops the zero-amount kg line without dividing by zero, and keeps the order', () => {
      // GG_77533: Limon (by kg) amount 0, line_total 0 + Tortillas 1 x 2200
      const result = mapper.map(orderByRef('GG_77533'), config);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.order.items).toHaveLength(1);
      expect(result.order.items[0].sku).toBe('B07');
      expect(result.order.total.amount).toBe(2200);
      expect(Number.isFinite(result.order.items[0].unitPrice.amount)).toBe(
        true,
      );

      expect(result.warnings[0].reason).toMatch(/quantity is 0/);
      expect(result.warnings[0].externalOrderId).toBe('GG_77533');
    });

    it('rejects an unrecognised country rather than guessing', () => {
      const result = mapper.map(
        {
          ...orderByRef('GG_77530'),
          destination: {
            address: 'Somewhere 1',
            city: 'Elsewhere',
            country: 'Narnia',
          },
        },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('destination.country');
    });

    it('captures an unmapped status code rather than defaulting', () => {
      const result = mapper.map(
        { ...orderByRef('GG_77530'), order_status: 99 },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('order_status');
    });

    it('captures an unparseable US timestamp', () => {
      const result = mapper.map(
        { ...orderByRef('GG_77530'), timestamp: '20/06/2026 08:50' },
        config,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failures[0].field).toBe('timestamp');
    });
  });

  it('converts to minor units if they ever stop sending cents', () => {
    // Defensive, and cheap: money.unit is theirs to change. If it stops saying
    // "cents", we convert instead of silently inflating every price 100x.
    const result = mapper.map(
      {
        ...orderByRef('GG_77530'),
        money: { currency: 'MXN', unit: 'major' },
        products: [
          {
            code: 'C03',
            title: 'Tortilla de Maiz 1kg',
            amount: 1,
            uom: 'unit',
            line_total: 32,
          },
        ],
      },
      config,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.order.total.amount).toBe(3200);
  });
});

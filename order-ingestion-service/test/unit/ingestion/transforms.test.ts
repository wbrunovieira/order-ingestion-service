import { describe, expect, it } from 'vitest';
import {
  countryToIso,
  splitAddressLine,
} from '../../../src/ingestion/normalization/transforms/address';
import {
  parseBrDateTime,
  parseIsoDateTime,
  parseUsDateTime12h,
} from '../../../src/ingestion/normalization/transforms/date';
import { parseDelimitedItems } from '../../../src/ingestion/normalization/transforms/delimited-items';
import {
  sumLineTotals,
  toMinorUnits,
  unitPriceFromLineTotal,
} from '../../../src/ingestion/normalization/transforms/money';
import { synthesizeSku } from '../../../src/ingestion/normalization/transforms/sku';

/**
 * The transforms hold the hardest logic in the system, so they are tested on their
 * own — no Nest, no HTTP, no pipeline. A new customer reuses these; a bug in one of
 * them would be a bug in every customer that references it.
 */

const SAO_PAULO = 'America/Sao_Paulo';
const MEXICO_CITY = 'America/Mexico_City';

describe('date transforms', () => {
  describe('parseBrDateTime — BairroBox, DD/MM/YYYY HH:mm, no offset', () => {
    it('reads day first and converts from Sao Paulo to UTC', () => {
      // 10:40 in Sao Paulo (UTC-3) is 13:40 UTC. Note the +3: the direction of the
      // offset is the thing most easily inverted.
      expect(parseBrDateTime('20/06/2026 10:40', SAO_PAULO)).toBe(
        '2026-06-20T13:40:00.000Z',
      );
    });

    it('does not read DD/MM as MM/DD', () => {
      // 06/07 is the 6th of JULY, not the 7th of June. Getting this backwards moves
      // an order to another month without anything looking wrong.
      expect(parseBrDateTime('06/07/2026 09:00', SAO_PAULO)).toBe(
        '2026-07-06T12:00:00.000Z',
      );
    });

    it('rejects a malformed date instead of inventing one', () => {
      expect(parseBrDateTime('2026-06-20 10:40', SAO_PAULO)).toBeUndefined();
      expect(parseBrDateTime('', SAO_PAULO)).toBeUndefined();
      expect(parseBrDateTime('tomorrow', SAO_PAULO)).toBeUndefined();
    });
  });

  describe('parseUsDateTime12h — GlobalGoods, MM-DD-YYYY hh:mm AM/PM, no offset', () => {
    it('reads month first and converts from Mexico City to UTC', () => {
      // 08:50 AM in Mexico City (UTC-6) is 14:50 UTC.
      expect(parseUsDateTime12h('06-20-2026 08:50 AM', MEXICO_CITY)).toBe(
        '2026-06-20T14:50:00.000Z',
      );
    });

    it('handles the 12-hour wrap in both directions', () => {
      // 12 AM is midnight, 12 PM is noon — the one case "+12 if PM" gets wrong twice.
      expect(parseUsDateTime12h('06-20-2026 12:00 AM', MEXICO_CITY)).toBe(
        '2026-06-20T06:00:00.000Z',
      );
      expect(parseUsDateTime12h('06-20-2026 12:00 PM', MEXICO_CITY)).toBe(
        '2026-06-20T18:00:00.000Z',
      );
      expect(parseUsDateTime12h('06-20-2026 01:00 PM', MEXICO_CITY)).toBe(
        '2026-06-20T19:00:00.000Z',
      );
    });

    it('rejects an impossible hour', () => {
      expect(
        parseUsDateTime12h('06-20-2026 13:00 PM', MEXICO_CITY),
      ).toBeUndefined();
      expect(
        parseUsDateTime12h('06-20-2026 00:30 AM', MEXICO_CITY),
      ).toBeUndefined();
    });
  });

  it('parseIsoDateTime keeps FreshMart in UTC and rejects nonsense', () => {
    expect(parseIsoDateTime('2026-06-20T14:32:00Z')).toBe(
      '2026-06-20T14:32:00.000Z',
    );
    expect(parseIsoDateTime('not a date')).toBeUndefined();
  });
});

describe('parseDelimitedItems — BairroBox packs a whole order into one string', () => {
  it('splits multiple items and strips the x from the quantity', () => {
    const lines = parseDelimitedItems(
      'Feijao 1kg|x2|15.80;Oleo de Soja 900ml|x1|8.50',
    );

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      ok: true,
      name: 'Feijao 1kg',
      quantity: 2,
      lineTotalMajor: 15.8,
    });
    expect(lines[1]).toMatchObject({ ok: true, name: 'Oleo de Soja 900ml' });
  });

  it('parses the real traps rather than choking on them', () => {
    // The price is a LINE total, and both of these are real rows in their feed.
    const [zeroPrice] = parseDelimitedItems('Feijao 1kg|x3|0');
    expect(zeroPrice).toMatchObject({
      ok: true,
      quantity: 3,
      lineTotalMajor: 0,
    });

    const [zeroQty] = parseDelimitedItems('Cafe 500g|x0|0');
    expect(zeroQty).toMatchObject({ ok: true, quantity: 0, lineTotalMajor: 0 });
  });

  it('reports a malformed segment with a reason, and keeps the good ones', () => {
    const lines = parseDelimitedItems('Arroz 5kg|x1|29.90;garbage;Cafe|xNaN|1');

    expect(lines[0].ok).toBe(true);
    expect(lines[1]).toMatchObject({ ok: false });
    expect(lines[2]).toMatchObject({ ok: false });
    if (!lines[1].ok) expect(lines[1].reason).toMatch(/field/);
    if (!lines[2].ok) expect(lines[2].reason).toMatch(/quantity/);
  });
});

describe('money transforms', () => {
  it('converts to minor units without float drift', () => {
    // 5.49 * 100 is 549.0000000000001 in IEEE-754; 0.29 * 100 is 28.999999999999996.
    expect(toMinorUnits(5.49)).toBe(549);
    expect(toMinorUnits(8.9)).toBe(890);
    expect(toMinorUnits(0.29)).toBe(29);
    expect(toMinorUnits(29.9)).toBe(2990);
  });

  it('derives a unit price from a line total', () => {
    expect(unitPriceFromLineTotal(3294, 6)).toBe(549); // 32.94 / 6 = 5.49 exactly
    expect(unitPriceFromLineTotal(13500, 1.5)).toBe(9000); // by the kg
  });

  it('refuses to divide by a zero quantity', () => {
    // "Cafe 500g|x0|0" and GlobalGoods' Limon with amount 0. Never Infinity, never NaN.
    expect(unitPriceFromLineTotal(0, 0)).toBeUndefined();
    expect(unitPriceFromLineTotal(1000, 0)).toBeUndefined();
    expect(unitPriceFromLineTotal(1000, -1)).toBeUndefined();
  });

  it('sums unit-priced lines in minor units', () => {
    // In floats, 6 x 5.49 + 2 x 8.90 = 50.739999999999995.
    const total = sumLineTotals([
      { quantity: 6, unitPrice: { amount: 549 } },
      { quantity: 2, unitPrice: { amount: 890 } },
    ]);

    expect(total).toBe(5074);
  });
});

describe('address transforms', () => {
  it('splits a one-line address on the last comma', () => {
    expect(splitAddressLine('Rua Augusta 500, Sao Paulo')).toEqual({
      line1: 'Rua Augusta 500',
      city: 'Sao Paulo',
    });
  });

  it('keeps everything before the last comma as the street', () => {
    expect(splitAddressLine('Av. Paulista 900, Apto 42, Sao Paulo')).toEqual({
      line1: 'Av. Paulista 900, Apto 42',
      city: 'Sao Paulo',
    });
  });

  it('returns undefined for an address it cannot split, including the empty one', () => {
    // BairroBox really does send `endereco: ""`. That is not a parse problem — it is
    // an undeliverable order, and the mapper rejects it with that reason.
    expect(splitAddressLine('')).toBeUndefined();
    expect(splitAddressLine('Rua sem cidade')).toBeUndefined();
  });

  it('maps a full country name to ISO-3166 alpha-2', () => {
    expect(countryToIso('Mexico')).toBe('MX');
    expect(countryToIso('México')).toBe('MX');
    expect(countryToIso('Brasil')).toBe('BR');
  });

  it('passes an existing alpha-2 code through unchanged', () => {
    expect(countryToIso('BR')).toBe('BR');
    expect(countryToIso('mx')).toBe('MX');
  });

  it('returns undefined for a country we do not ship to, rather than guessing', () => {
    expect(countryToIso('Narnia')).toBeUndefined();
  });
});

describe('synthesizeSku — BairroBox sends no product code at all', () => {
  it('derives a stable, namespaced sku from the product name', () => {
    expect(synthesizeSku('bairrobox', 'Arroz 5kg')).toBe('bairrobox:arroz-5kg');
    expect(synthesizeSku('bairrobox', 'Feijão 1kg')).toBe(
      'bairrobox:feijao-1kg',
    );
  });

  it('is stable across polls, so the same product is not re-invented every cycle', () => {
    expect(synthesizeSku('bairrobox', 'Oleo de Soja 900ml')).toBe(
      synthesizeSku('bairrobox', 'Oleo de Soja 900ml'),
    );
  });
});

/**
 * BairroBox packs an entire order's items into ONE string:
 *
 *   "Arroz 5kg|x2|59.80;Feijao 1kg|x3|0"
 *
 * Items are separated by ';', and each is `name|xQuantity|lineTotal` — the quantity
 * carries an 'x' prefix, and the price is the LINE TOTAL, not a unit price.
 *
 * This is the transform that makes "config, not code" honest: no declarative field
 * mapping can express this, so the logic has to exist. It exists once, named, tested,
 * and referenced from config — which is the difference between a reusable transform
 * and a special case buried in a pipeline.
 */

export type DelimitedLine =
  | {
      ok: true;
      raw: string;
      name: string;
      quantity: number;
      lineTotalMajor: number;
    }
  | { ok: false; raw: string; reason: string };

export function parseDelimitedItems(value: string): DelimitedLine[] {
  return value
    .split(';')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map(parseLine);
}

function parseLine(raw: string): DelimitedLine {
  const fields = raw.split('|').map((field) => field.trim());

  if (fields.length !== 3) {
    return {
      ok: false,
      raw,
      reason: `expected "name|xQuantity|lineTotal", got ${fields.length} field(s)`,
    };
  }

  const [name, rawQuantity, rawLineTotal] = fields;

  if (name.length === 0) {
    return { ok: false, raw, reason: 'item has no name' };
  }

  // The 'x' is theirs, and it is optional-tolerant on purpose: "x3" and "3" both
  // mean three. Anything else is not a quantity.
  const quantity = Number(rawQuantity.replace(/^x/i, ''));
  if (!Number.isFinite(quantity)) {
    return {
      ok: false,
      raw,
      reason: `quantity "${rawQuantity}" is not a number`,
    };
  }

  const lineTotalMajor = Number(rawLineTotal);
  if (!Number.isFinite(lineTotalMajor)) {
    return {
      ok: false,
      raw,
      reason: `line total "${rawLineTotal}" is not a number`,
    };
  }

  return { ok: true, raw, name, quantity, lineTotalMajor };
}

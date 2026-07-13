/**
 * Address transforms.
 *
 * BairroBox sends the whole address as one string ("Rua Augusta 500, Sao Paulo"),
 * and GlobalGoods sends the country as a full name ("Mexico") where the canonical
 * model wants ISO-3166 alpha-2.
 */

export interface SplitAddress {
  line1: string;
  city: string;
}

/**
 * "Rua Augusta 500, Sao Paulo" -> line1 "Rua Augusta 500", city "Sao Paulo".
 *
 * The LAST comma-separated part is the city and everything before it is the street,
 * which is the convention their data follows. Returns undefined when the string
 * cannot yield both — including their empty `endereco: ""`, which is not a parse
 * problem but an undeliverable order, and the caller rejects it with that reason.
 */
export function splitAddressLine(value: string): SplitAddress | undefined {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length < 2) {
    return undefined;
  }

  const city = parts[parts.length - 1];
  const line1 = parts.slice(0, -1).join(', ');

  return { line1, city };
}

/**
 * The countries our customers actually ship to. Deliberately a small, explicit table
 * rather than a full ISO library: an unknown country becomes a failure with a reason
 * (a new market is something we want to notice), not a wrong guess.
 */
const COUNTRY_NAMES_TO_ISO: Readonly<Record<string, string>> = {
  brazil: 'BR',
  brasil: 'BR',
  mexico: 'MX', // "México" arrives here with its accent already stripped
};

/**
 * "Mexico" -> "MX". An input that is already an alpha-2 code passes through, so a
 * customer who cleans up their feed does not break.
 */
export function countryToIso(value: string): string | undefined {
  const trimmed = value.trim();

  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    return trimmed.toUpperCase();
  }

  const normalized = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics
    .toLowerCase();

  return COUNTRY_NAMES_TO_ISO[normalized];
}

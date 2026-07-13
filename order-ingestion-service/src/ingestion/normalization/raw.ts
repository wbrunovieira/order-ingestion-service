/**
 * Guards for reading raw customer payloads.
 *
 * Nothing from a customer is trusted to have the shape it had yesterday. Raw JSON
 * stops being `unknown` only by passing through here, so it can never flow into the
 * canonical model untyped.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. An empty string is missing data, not a value. */
export function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A string that may legitimately be empty (BairroBox's store_code). */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() : undefined;
}

/** Rejects NaN and Infinity, which is the whole point of having this. */
export function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  // Feeds sometimes quote their numbers ("29.90"); accept that, reject "abc".
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

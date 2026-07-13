/**
 * Date transforms. Three feeds, three formats, and two of them carry no timezone at
 * all — so converting them to UTC is a DECISION, taken from the customer's declared
 * IANA zone in config (see customer.config.ts).
 *
 * Getting the direction of the offset wrong is a silent 3-6 hour error on every
 * order, and reading DD/MM as MM/DD silently moves an order to another month. Both
 * are pinned by tests against concrete values.
 */

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/**
 * Interpret a wall-clock reading AS IF it were on the clock in `timeZone`, and
 * return the instant it names, in UTC.
 *
 * The offset is asked of the runtime for that specific date rather than hard-coded,
 * so this stays correct if a zone's rules change or if a customer in a DST-observing
 * zone is added later. (Brazil and Mexico both abolished DST — 2019 and 2022 — so in
 * 2026 the offsets are a flat -03 and -06, but nothing here depends on that.)
 */
function localToUtcIso(
  local: LocalDateTime,
  timeZone: string,
): string | undefined {
  const naiveUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );

  if (Number.isNaN(naiveUtc)) {
    return undefined;
  }

  // Read the wall clock that `timeZone` would show at that instant, and take the
  // difference: that is the zone's offset on that date, DST included.
  const shown = wallClockIn(new Date(naiveUtc), timeZone);
  if (shown === undefined) {
    return undefined;
  }

  const offsetMs = shown - naiveUtc;
  const instant = new Date(naiveUtc - offsetMs);

  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

/** What `timeZone`'s clock reads at `instant`, expressed as a UTC-epoch for maths. */
function wallClockIn(instant: Date, timeZone: string): number | undefined {
  let parts: Intl.DateTimeFormatPart[];

  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
  } catch {
    // An unknown IANA zone is a config error, not customer data. Surfaced as an
    // unparseable timestamp by the caller, which is loud enough to find at boot.
    return undefined;
  }

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);

  return Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );
}

/**
 * BairroBox: "20/06/2026 10:40" — DAY first, 24h, local to their zone.
 *
 * In America/Sao_Paulo that is 2026-06-20T13:40:00.000Z.
 */
export function parseBrDateTime(
  value: string,
  timeZone: string,
): string | undefined {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})$/.exec(
    value.trim(),
  );
  if (match === null) {
    return undefined;
  }

  const [, day, month, year, hour, minute] = match;

  return localToUtcIso(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    timeZone,
  );
}

/**
 * GlobalGoods: "06-20-2026 08:50 AM" — MONTH first, 12-hour, local to their zone.
 *
 * In America/Mexico_City that is 2026-06-20T14:50:00.000Z.
 *
 * The 12-hour wrap is the trap: 12 AM is midnight (00) and 12 PM is noon (12), which
 * is the one case a naive `hour + 12` gets backwards in both directions.
 */
export function parseUsDateTime12h(
  value: string,
  timeZone: string,
): string | undefined {
  const match = /^(\d{2})-(\d{2})-(\d{4})\s+(\d{2}):(\d{2})\s*(AM|PM)$/i.exec(
    value.trim(),
  );
  if (match === null) {
    return undefined;
  }

  const [, month, day, year, rawHour, minute, meridiem] = match;
  const hour12 = Number(rawHour);

  if (hour12 < 1 || hour12 > 12) {
    return undefined;
  }

  const isPm = meridiem.toUpperCase() === 'PM';
  const hour = isPm ? (hour12 % 12) + 12 : hour12 % 12;

  return localToUtcIso(
    {
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour,
      minute: Number(minute),
    },
    timeZone,
  );
}

/** FreshMart already sends an offset; we only confirm it names a real instant. */
export function parseIsoDateTime(value: string): string | undefined {
  const parsed = new Date(value.trim());

  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

import type { DataWarning, MappingFailure } from './ingestion-failure';

/**
 * What one batch did — from a webhook delivery or one poll cycle.
 *
 * `duplicated` is not a problem being reported; it is the design working. The pollers
 * re-read the same orders every cycle, so a healthy customer shows a LOT of
 * duplicates, and each one is an upsert onto the row it already owns.
 */
export interface IngestionOutcome {
  customerId: string;
  /** Records the source handed us. */
  received: number;
  /** Records that became canonical orders. */
  normalized: number;
  /** ...of which we had never seen before. */
  created: number;
  /** ...of which we already had, and updated in place. */
  duplicated: number;
  failed: number;
  failures: MappingFailure[];
  warnings: DataWarning[];
}

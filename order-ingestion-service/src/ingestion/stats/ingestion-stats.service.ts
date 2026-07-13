import { Injectable } from '@nestjs/common';
import type {
  DataWarning,
  MappingFailure,
} from '../pipeline/ingestion-failure';
import type { IngestionOutcome } from '../pipeline/ingestion-outcome';

/** Enough recent detail to diagnose, not so much that it becomes a log store. */
const MAX_RECENT = 50;

export interface CustomerCounters {
  customerId: string;
  received: number;
  normalized: number;
  created: number;
  duplicated: number;
  failed: number;
  warnings: number;
  batches: number;
  lastIngestedAt?: string;
}

export interface StatsSnapshot {
  customers: CustomerCounters[];
  recentFailures: MappingFailure[];
  recentWarnings: DataWarning[];
}

/**
 * The counters and the reasons, per customer.
 *
 * This is deliberately small — an in-process tally, not an observability stack. But
 * it is the SHAPE of the thing that matters in production: a per-customer failure
 * RATE, and a volume that can be compared against yesterday's, are how you notice a
 * customer has silently changed their contract before they call to complain.
 * DESIGN.md covers what this becomes with real metrics behind it.
 */
@Injectable()
export class IngestionStatsService {
  private readonly counters = new Map<string, CustomerCounters>();
  private readonly failures: MappingFailure[] = [];
  private readonly warnings: DataWarning[] = [];

  record(outcome: IngestionOutcome): void {
    const counters = this.countersFor(outcome.customerId);

    counters.received += outcome.received;
    counters.normalized += outcome.normalized;
    counters.created += outcome.created;
    counters.duplicated += outcome.duplicated;
    counters.failed += outcome.failed;
    counters.warnings += outcome.warnings.length;
    counters.batches += 1;
    counters.lastIngestedAt = new Date().toISOString();

    this.remember(this.failures, outcome.failures);
    this.remember(this.warnings, outcome.warnings);
  }

  snapshot(): StatsSnapshot {
    return {
      customers: [...this.counters.values()],
      // Newest first: what just broke is what someone is looking for.
      recentFailures: [...this.failures].reverse(),
      recentWarnings: [...this.warnings].reverse(),
    };
  }

  private countersFor(customerId: string): CustomerCounters {
    let counters = this.counters.get(customerId);

    if (counters === undefined) {
      counters = {
        customerId,
        received: 0,
        normalized: 0,
        created: 0,
        duplicated: 0,
        failed: 0,
        warnings: 0,
        batches: 0,
      };
      this.counters.set(customerId, counters);
    }

    return counters;
  }

  private remember<T>(buffer: T[], entries: T[]): void {
    buffer.push(...entries);

    if (buffer.length > MAX_RECENT) {
      buffer.splice(0, buffer.length - MAX_RECENT);
    }
  }
}

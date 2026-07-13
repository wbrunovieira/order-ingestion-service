import type { CustomerConfig } from '../../customers/customer.config';
import type { CanonicalOrder } from '../../orders/canonical-order.model';
import type {
  DataWarning,
  MappingFailure,
} from '../pipeline/ingestion-failure';

/**
 * A mapper turns ONE customer's raw record into a canonical order candidate.
 *
 * It is the only place that knows a customer's data quirks, and it is deliberately
 * a pure class: no Nest module, no I/O, no HTTP. That keeps the trickiest logic in
 * the system trivially testable against the real fixtures.
 *
 * A mapper never throws on bad data. It returns failures, so the batch survives.
 */
export type MapOutcome =
  | { ok: true; order: CanonicalOrder; warnings: DataWarning[] }
  | { ok: false; failures: MappingFailure[] };

export interface OrderMapper {
  map(raw: unknown, config: CustomerConfig): MapOutcome;
}

/**
 * Collects what went wrong (and what was merely odd) while mapping one record.
 *
 * The two are not the same and the difference is a business decision, not a
 * technical one: a failure means the order is not actionable and is not persisted;
 * a warning means it is imperfect but real, so we keep it AND make the imperfection
 * visible. See the README table.
 */
export class MappingReport {
  readonly failures: MappingFailure[] = [];
  readonly warnings: DataWarning[] = [];

  constructor(
    private readonly customerId: string,
    private externalOrderId?: string,
  ) {}

  /** Known as soon as the id is read, and needed to label everything after it. */
  identify(externalOrderId: string): void {
    this.externalOrderId = externalOrderId;
  }

  fail(field: string, reason: string): void {
    this.failures.push({
      customerId: this.customerId,
      externalOrderId: this.externalOrderId,
      field,
      reason,
      at: new Date().toISOString(),
    });
  }

  warn(field: string, reason: string): void {
    this.warnings.push({
      customerId: this.customerId,
      externalOrderId: this.externalOrderId ?? '(unknown)',
      field,
      reason,
      at: new Date().toISOString(),
    });
  }

  get failed(): boolean {
    return this.failures.length > 0;
  }
}

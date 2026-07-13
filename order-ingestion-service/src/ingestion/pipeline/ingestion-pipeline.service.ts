import { Injectable, Logger } from '@nestjs/common';
import type { CustomerConfig } from '../../customers/customer.config';
import { validateCanonicalOrder } from '../../orders/canonical-order.validator';
import { MapperRegistryService } from '../normalization/mapper-registry.service';
import type { MapOutcome } from '../normalization/order-mapper';
import { OrderRepository } from '../persistence/order.repository';
import type { DataWarning, MappingFailure } from './ingestion-failure';

export interface IngestionOutcome {
  customerId: string;
  /** Records handed to us by the source. */
  received: number;
  /** Records that became canonical orders. */
  normalized: number;
  /** ...of which were orders we had never seen. */
  created: number;
  /** ...of which we already had, and just updated. Re-reads, not double writes. */
  duplicated: number;
  failed: number;
  failures: MappingFailure[];
  warnings: DataWarning[];
}

/**
 * The one pipeline both ingestion modes feed into: normalize -> validate -> dedup ->
 * persist. The webhook and the pollers are just different ways of arriving here.
 *
 * It knows nothing about any specific customer. It reads their config, asks the
 * registry for their mapper, and treats every source the same after that — which is
 * what makes a new customer a config entry instead of a new branch in here.
 */
@Injectable()
export class IngestionPipelineService {
  private readonly logger = new Logger(IngestionPipelineService.name);

  constructor(
    private readonly mappers: MapperRegistryService,
    private readonly orders: OrderRepository,
  ) {}

  async ingest(
    config: CustomerConfig,
    rawRecords: unknown[],
  ): Promise<IngestionOutcome> {
    const mapper = this.mappers.get(config.mapper);
    const outcome: IngestionOutcome = {
      customerId: config.id,
      received: rawRecords.length,
      normalized: 0,
      created: 0,
      duplicated: 0,
      failed: 0,
      failures: [],
      warnings: [],
    };

    for (const raw of rawRecords) {
      // Per record, never per batch: one poisoned order cannot take down the cycle.
      const failures = await this.ingestOne(config, mapper, raw, outcome);
      if (failures.length > 0) {
        outcome.failed += 1;
        outcome.failures.push(...failures);
      }
    }

    this.logger.log(
      `${config.id}: received=${outcome.received} normalized=${outcome.normalized} ` +
        `created=${outcome.created} duplicated=${outcome.duplicated} failed=${outcome.failed}`,
    );

    for (const failure of outcome.failures) {
      this.logger.warn(
        `${failure.customerId} order=${failure.externalOrderId ?? '(unidentified)'} ` +
          `field=${failure.field}: ${failure.reason}`,
      );
    }

    return outcome;
  }

  private async ingestOne(
    config: CustomerConfig,
    mapper: ReturnType<MapperRegistryService['get']>,
    raw: unknown,
    outcome: IngestionOutcome,
  ): Promise<MappingFailure[]> {
    let mapped: MapOutcome;

    try {
      mapped = mapper.map(raw, config);
    } catch (error) {
      // A mapper is not supposed to throw — bad data is meant to come back as
      // failures. If one does, that is our bug, not theirs: capture it against the
      // record so the batch survives, and log it loudly so it is not silent.
      const reason =
        error instanceof Error ? error.message : 'unknown mapper error';
      this.logger.error(`${config.id}: mapper threw — ${reason}`);

      return [
        {
          customerId: config.id,
          field: '(mapper)',
          reason: `mapper threw: ${reason}`,
          at: new Date().toISOString(),
        },
      ];
    }

    if (!mapped.ok) {
      return mapped.failures;
    }

    // Defence in depth: the mapper is typed, but only the DTO decides what the
    // platform will accept.
    const validation = validateCanonicalOrder(mapped.order);
    if (!validation.valid) {
      return validation.errors.map((error) => ({
        customerId: config.id,
        externalOrderId: mapped.ok ? mapped.order.externalOrderId : undefined,
        field: error.field,
        reason: error.message,
        at: new Date().toISOString(),
      }));
    }

    // Dedup and persistence are the same operation. The stable orderId means an
    // order repeated inside one batch and an order re-read on the next poll are
    // indistinguishable — both land on the row they already own.
    const { created } = await this.orders.upsert(validation.order);

    outcome.normalized += 1;
    outcome[created ? 'created' : 'duplicated'] += 1;
    outcome.warnings.push(...mapped.warnings);

    return [];
  }
}

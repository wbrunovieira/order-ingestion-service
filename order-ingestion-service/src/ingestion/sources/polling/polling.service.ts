import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CustomerRegistryService } from '../../../customers/customer-registry.service';
import type { PullCustomerConfig } from '../../../customers/customer.config';
import {
  IngestionPipelineService,
  type IngestionOutcome,
} from '../../pipeline/ingestion-pipeline.service';
import { SourceReaderService } from './source-reader.service';

/**
 * Pull ingestion — Customers B and C. We call them.
 *
 * Thin on purpose, exactly like the webhook: it decides WHEN to poll, and nothing
 * else. Reading (pagination, rate limits, backoff) is the reader's job and mapping is
 * the pipeline's, so both ingestion modes end up in the same place.
 *
 * Every pull customer in the registry gets a poller at its own interval, taken from
 * config. Adding a fourth polled customer schedules itself.
 */
@Injectable()
export class PollingService implements OnModuleInit {
  private readonly logger = new Logger(PollingService.name);
  /** A customer already mid-cycle is not polled again — slow sources must not stack. */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly customers: CustomerRegistryService,
    private readonly reader: SourceReaderService,
    private readonly pipeline: IngestionPipelineService,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    for (const customer of this.customers.pullCustomers()) {
      const intervalMs = customer.source.pollIntervalMs;

      const interval = setInterval(() => {
        void this.poll(customer);
      }, intervalMs);
      this.scheduler.addInterval(`poll:${customer.id}`, interval);

      this.logger.log(
        `Polling ${customer.name} every ${intervalMs / 1000}s at ${customer.source.url}`,
      );

      // Poll once at boot rather than making the first cycle wait a full interval —
      // otherwise a 15-minute customer contributes nothing for 15 minutes.
      void this.poll(customer);
    }
  }

  /**
   * One cycle for one customer.
   *
   * A source being down throws out of the reader, and it is caught HERE and nowhere
   * deeper: one broken customer must not stop the others from being polled, and the
   * next cycle re-reads an overlapping window anyway, so a lost cycle costs nothing.
   * That isolation is the small version of the per-customer isolation in DESIGN.md.
   */
  async poll(
    customer: PullCustomerConfig,
  ): Promise<IngestionOutcome | undefined> {
    if (this.inFlight.has(customer.id)) {
      this.logger.warn(
        `${customer.id}: previous poll still running — skipping this cycle`,
      );
      return undefined;
    }

    this.inFlight.add(customer.id);

    try {
      const records = await this.reader.read(customer);
      return await this.pipeline.ingest(customer, records);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`${customer.id}: poll cycle failed — ${reason}`);
      return undefined;
    } finally {
      this.inFlight.delete(customer.id);
    }
  }
}

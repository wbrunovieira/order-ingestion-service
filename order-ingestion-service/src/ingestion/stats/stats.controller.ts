import { Controller, Get } from '@nestjs/common';
import { OrderRepository } from '../persistence/order.repository';
import { success } from '../../utils/http-response';
import { IngestionStatsService } from './ingestion-stats.service';

/**
 * What ingestion is doing, per customer, and why anything failed.
 *
 * Every failure carries the customer, the order, the FIELD and the reason — so a
 * mapping problem is something you read, not something you go hunting for in logs.
 */
@Controller('stats')
export class StatsController {
  constructor(
    private readonly stats: IngestionStatsService,
    private readonly orders: OrderRepository,
  ) {}

  @Get()
  async get() {
    const snapshot = this.stats.snapshot();

    return success('Ingestion stats', {
      ordersStored: await this.orders.count(),
      ...snapshot,
    });
  }
}

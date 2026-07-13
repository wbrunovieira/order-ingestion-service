import { Module } from '@nestjs/common';
import { InMemoryOrderRepository } from './in-memory-order.repository';
import { OrderRepository } from './order.repository';

/**
 * The one place the storage choice is made. Swapping in SQLite or Postgres means
 * changing `useClass` here and nothing else.
 */
@Module({
  providers: [{ provide: OrderRepository, useClass: InMemoryOrderRepository }],
  exports: [OrderRepository],
})
export class PersistenceModule {}

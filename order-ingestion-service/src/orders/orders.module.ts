import { Module } from '@nestjs/common';
import { PersistenceModule } from '../ingestion/persistence/persistence.module';
import { OrdersController } from './orders.controller';

@Module({
  imports: [PersistenceModule],
  controllers: [OrdersController],
})
export class OrdersModule {}

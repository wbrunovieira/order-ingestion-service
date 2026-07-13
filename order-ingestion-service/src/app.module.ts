import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppController } from './controllers/app.controller';
import { HealthController } from './controllers/health.controller';
import { IngestionModule } from './ingestion/ingestion.module';
import { OrdersModule } from './orders/orders.module';
import { AppService } from './services/app.service';

@Module({
  imports: [TerminusModule, IngestionModule, OrdersModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}

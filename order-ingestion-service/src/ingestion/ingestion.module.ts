import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { MapperRegistryService } from './normalization/mapper-registry.service';
import { FreshmartMapper } from './normalization/mappers/freshmart.mapper';
import { PersistenceModule } from './persistence/persistence.module';
import { IngestionPipelineService } from './pipeline/ingestion-pipeline.service';
import { WebhookController } from './sources/webhook/webhook.controller';

/**
 * Ingestion: the sources (push today, pull next), the shared pipeline they all feed,
 * and the mappers the pipeline resolves from config.
 */
@Module({
  imports: [CustomersModule, PersistenceModule],
  controllers: [WebhookController],
  providers: [FreshmartMapper, MapperRegistryService, IngestionPipelineService],
  exports: [IngestionPipelineService],
})
export class IngestionModule {}

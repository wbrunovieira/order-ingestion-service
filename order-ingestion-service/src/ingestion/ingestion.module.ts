import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CustomersModule } from '../customers/customers.module';
import { MapperRegistryService } from './normalization/mapper-registry.service';
import { BairroboxMapper } from './normalization/mappers/bairrobox.mapper';
import { FreshmartMapper } from './normalization/mappers/freshmart.mapper';
import { GlobalgoodsMapper } from './normalization/mappers/globalgoods.mapper';
import { PersistenceModule } from './persistence/persistence.module';
import { IngestionPipelineService } from './pipeline/ingestion-pipeline.service';
import { PollingService } from './sources/polling/polling.service';
import {
  FetchSourceHttpClient,
  SourceHttpClient,
} from './sources/polling/source-http.client';
import { SourceReaderService } from './sources/polling/source-reader.service';
import { WebhookController } from './sources/webhook/webhook.controller';
import { IngestionStatsService } from './stats/ingestion-stats.service';
import { StatsController } from './stats/stats.controller';

/**
 * Ingestion: the sources (push and pull), the shared pipeline they both feed, and the
 * mappers the pipeline resolves from config.
 *
 * Note what is NOT here: any customer. They are declared in the registry, and adding
 * one changes nothing in this file unless their data needs a brand-new mapper.
 */
@Module({
  imports: [ScheduleModule.forRoot(), CustomersModule, PersistenceModule],
  controllers: [WebhookController, StatsController],
  providers: [
    FreshmartMapper,
    BairroboxMapper,
    GlobalgoodsMapper,
    MapperRegistryService,
    IngestionStatsService,
    IngestionPipelineService,
    { provide: SourceHttpClient, useClass: FetchSourceHttpClient },
    SourceReaderService,
    PollingService,
  ],
  exports: [IngestionPipelineService],
})
export class IngestionModule {}

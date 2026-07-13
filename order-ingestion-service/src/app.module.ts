import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { AppController } from './controllers/app.controller';
import { HealthController } from './controllers/health.controller';
import { AppService } from './services/app.service';

@Module({
  imports: [TerminusModule],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}

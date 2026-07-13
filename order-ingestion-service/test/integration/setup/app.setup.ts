import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { AppModule } from '../../../src/app.module';
import { configureApp } from '../../../src/config/app.setup';

/**
 * The pollers are off in integration tests, for two reasons that both matter.
 *
 * These tests must not depend on the mock customer APIs being up on port 4000 — a
 * test that only passes when a second process happens to be running is not a test,
 * and it could never run in CI. And with the pollers on, BairroBox and GlobalGoods
 * orders would land in the same store the webhook assertions read from, so "one
 * order, total 5074" would quietly depend on how long the test took.
 *
 * The webhook path needs no source but the request itself. Polling is covered end to
 * end by its own suite, against a fake source that can be made to page, throttle and
 * fail on demand.
 */
process.env.POLLING_ENABLED = 'false';

export async function buildApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  configureApp(app);
  await app.init();
  return app;
}

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { IngestionOutcome } from '../../src/ingestion/pipeline/ingestion-outcome';
import type { StoredOrder } from '../../src/ingestion/persistence/order.repository';
import type { StatsSnapshot } from '../../src/ingestion/stats/ingestion-stats.service';
import { buildApp } from './setup/app.setup';

/**
 * The push path, black-box, over real HTTP: what a customer actually gets back, and
 * what the platform actually stores. The unit suites prove the pieces work; this
 * proves they are wired together.
 *
 * A fresh app per test, so each one owns its store and nothing leaks between them.
 */
const FIXTURES = resolve(__dirname, '../../../mock-customer-apis/fixtures');

function freshmartOrder(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, 'customer-a.sample.json'), 'utf8'),
  ) as Record<string, unknown>;
}

/** The scaffold's response envelope, typed — so the assertions below are checked too. */
function data<T>(response: { body: unknown }): T {
  return (response.body as { data: T }).data;
}

describe('Webhook ingestion (integration)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('accepts a pushed order with 202 and stores it as a canonical order', async () => {
    const accepted = await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send(freshmartOrder())
      .expect(202);

    expect(data<IngestionOutcome>(accepted)).toMatchObject({
      customerId: 'freshmart',
      received: 1,
      normalized: 1,
      created: 1,
      failed: 0,
    });

    const listed = await request(app.getHttpServer())
      .get('/orders')
      .expect(200);
    const orders = data<StoredOrder[]>(listed);

    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      externalOrderId: 'FM-100245',
      customerId: 'freshmart',
      status: 'received',
      createdAt: '2026-06-20T14:32:00.000Z',
      // Minor units, summed as integers. In floats this order is 50.739999999999995.
      total: { amount: 5074, currency: 'BRL' },
      deliveryAddress: { country: 'BR' },
    });
  });

  it('does not double-write when the same order is delivered twice', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send(freshmartOrder())
      .expect(202);

    const redelivery = await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send(freshmartOrder())
      .expect(202);

    // Recognised as the order we already have and upserted onto its row — not
    // rejected as a duplicate, and not written a second time.
    expect(data<IngestionOutcome>(redelivery)).toMatchObject({
      created: 0,
      duplicated: 1,
    });

    const listed = await request(app.getHttpServer())
      .get('/orders')
      .expect(200);
    expect(data<StoredOrder[]>(listed)).toHaveLength(1);
  });

  it('persists the good records in a batch and reports the bad ones with reasons', async () => {
    const undeliverable = {
      ...freshmartOrder(),
      order_id: 'FM-NO-ADDRESS',
      ship_to: { street: '', city: '', country: 'BR' },
    };
    const unknownStatus = {
      ...freshmartOrder(),
      order_id: 'FM-ON-HOLD',
      state: 'ON_HOLD',
    };

    const response = await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send([undeliverable, freshmartOrder(), unknownStatus])
      .expect(202);

    const outcome = data<IngestionOutcome>(response);
    expect(outcome).toMatchObject({ received: 3, normalized: 1, failed: 2 });

    // One bad record never takes the batch down, and never disappears quietly.
    expect(outcome.failures.map((failure) => failure.externalOrderId)).toEqual([
      'FM-NO-ADDRESS',
      'FM-ON-HOLD',
    ]);
    expect(outcome.failures.map((failure) => failure.field)).toEqual([
      'ship_to',
      'state',
    ]);
    expect(outcome.failures.every((failure) => failure.reason.length > 0)).toBe(
      true,
    );

    const listed = await request(app.getHttpServer())
      .get('/orders')
      .expect(200);
    const orders = data<StoredOrder[]>(listed);
    expect(orders).toHaveLength(1);
    expect(orders[0].externalOrderId).toBe('FM-100245');
  });

  it('surfaces the counters and the failure reasons on /stats', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send([
        freshmartOrder(),
        { ...freshmartOrder(), order_id: 'FM-BAD', state: 'ON_HOLD' },
      ])
      .expect(202);

    const response = await request(app.getHttpServer())
      .get('/stats')
      .expect(200);
    const stats = data<StatsSnapshot & { ordersStored: number }>(response);

    expect(stats.ordersStored).toBe(1);
    expect(stats.customers).toContainEqual(
      expect.objectContaining({
        customerId: 'freshmart',
        received: 2,
        normalized: 1,
        created: 1,
        failed: 1,
      }),
    );
    expect(stats.recentFailures[0]).toMatchObject({
      customerId: 'freshmart',
      externalOrderId: 'FM-BAD',
      field: 'state',
    });
  });

  it('404s an unknown customer rather than silently accepting their order', async () => {
    await request(app.getHttpServer())
      .post('/webhooks/not-a-customer')
      .send(freshmartOrder())
      .expect(404);
  });

  it('404s a customer we poll rather than one who pushes to us', async () => {
    // BairroBox exists, but they have no webhook capability — that is the whole
    // reason we poll them. Accepting a push from them would be accepting a lie.
    await request(app.getHttpServer())
      .post('/webhooks/bairrobox')
      .send(freshmartOrder())
      .expect(404);
  });

  it('captures a garbage payload as a failure instead of crashing', async () => {
    const response = await request(app.getHttpServer())
      .post('/webhooks/freshmart')
      .send({ nothing: 'like an order' })
      .expect(202);

    const outcome = data<IngestionOutcome>(response);
    expect(outcome).toMatchObject({ received: 1, failed: 1 });
    expect(outcome.failures[0].reason).toBeTruthy();

    const listed = await request(app.getHttpServer())
      .get('/orders')
      .expect(200);
    expect(data<StoredOrder[]>(listed)).toHaveLength(0);
  });
});

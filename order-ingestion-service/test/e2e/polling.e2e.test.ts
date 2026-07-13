import { SchedulerRegistry } from '@nestjs/schedule';
import { beforeEach, describe, expect, it } from 'vitest';
import { CustomerRegistryService } from '../../src/customers/customer-registry.service';
import { CUSTOMERS } from '../../src/customers/customer.config';
import { MapperRegistryService } from '../../src/ingestion/normalization/mapper-registry.service';
import { BairroboxMapper } from '../../src/ingestion/normalization/mappers/bairrobox.mapper';
import { FreshmartMapper } from '../../src/ingestion/normalization/mappers/freshmart.mapper';
import { GlobalgoodsMapper } from '../../src/ingestion/normalization/mappers/globalgoods.mapper';
import { InMemoryOrderRepository } from '../../src/ingestion/persistence/in-memory-order.repository';
import { IngestionPipelineService } from '../../src/ingestion/pipeline/ingestion-pipeline.service';
import { PollingService } from '../../src/ingestion/sources/polling/polling.service';
import { FetchSourceHttpClient } from '../../src/ingestion/sources/polling/source-http.client';
import { SourceReaderService } from '../../src/ingestion/sources/polling/source-reader.service';
import { IngestionStatsService } from '../../src/ingestion/stats/ingestion-stats.service';
import { THROTTLED_MOCK_URL } from './setup/mock-servers';

/**
 * The pollers against the REAL mock customer APIs, over real HTTP.
 *
 * The unit suite drives them with a fake source that I wrote — which means it can
 * only ever confirm what I already believed. Everything load-bearing about Customer
 * C is an assumption about SOMEONE ELSE'S implementation:
 *
 *   - that requesting page=1 advances their cursor (so a cycle must never ask twice)
 *   - that a 429 comes back BEFORE that advance (so retrying a throttled page is
 *     safe, and does not skip the records the cursor moved past)
 *
 * If either is wrong, the fake would keep passing and production would lose orders.
 * So these are checked against the thing itself.
 *
 * Out of CI on purpose: it spawns processes and one case waits out a real 60-second
 * rate-limit window. Run it with `pnpm test:e2e`.
 */

function newPoller() {
  const repository = new InMemoryOrderRepository();
  const http = new FetchSourceHttpClient();

  const pipeline = new IngestionPipelineService(
    new MapperRegistryService(
      new FreshmartMapper(),
      new BairroboxMapper(),
      new GlobalgoodsMapper(),
    ),
    repository,
    new IngestionStatsService(),
  );

  const polling = new PollingService(
    new CustomerRegistryService(),
    new SourceReaderService(http),
    pipeline,
    new SchedulerRegistry(),
  );

  return { polling, repository, http };
}

interface PageResponse {
  page: number;
  hasMore: boolean;
  orders: { reference: string }[];
}

describe('pollers against the live mock customer APIs', () => {
  let poller: ReturnType<typeof newPoller>;

  beforeEach(() => {
    poller = newPoller();
  });

  it('walks GlobalGoods page 1 then page 2 and ingests what comes back', async () => {
    const outcome = await poller.polling.poll(CUSTOMERS.globalgoods);

    // Their window is 4 across 2 pages — so a cycle that only read page 1 would
    // silently ingest half their orders.
    expect(outcome?.received).toBe(4);
    expect(outcome?.normalized).toBe(4);
    expect(await poller.repository.count()).toBeGreaterThan(0);
  });

  it('ingests BairroBox and rejects only what is genuinely undeliverable', async () => {
    const outcome = await poller.polling.poll(CUSTOMERS.bairrobox);

    expect(outcome?.received).toBe(4);
    // Whatever lands in the window, nothing throws and every failure has a reason.
    expect(outcome?.failures.every((f) => f.field && f.reason)).toBe(true);
    expect((outcome?.normalized ?? 0) + (outcome?.failed ?? 0)).toBe(4);
  });

  it('CONFIRMS the hazard: asking GlobalGoods for page 1 advances THEIR cursor', async () => {
    // This is the assumption the whole page-walk design rests on. If it were false,
    // re-requesting page 1 on a retry would be harmless and the code would be
    // needlessly careful. It is not false.
    const first = await poller.http.get(
      `${CUSTOMERS.globalgoods.source.url}?page=1`,
      'globalgoods',
    );
    const second = await poller.http.get(
      `${CUSTOMERS.globalgoods.source.url}?page=1`,
      'globalgoods',
    );

    const refsOf = (body: unknown) =>
      (body as PageResponse).orders.map((order) => order.reference);

    // Same request, different orders back: the window moved underneath us. Asking
    // twice inside one cycle would skip whatever it moved past.
    expect(refsOf(first.body)).not.toEqual(refsOf(second.body));
  });

  it('does not double-write orders re-read across consecutive poll cycles', async () => {
    // Their windows slide and overlap on purpose. Three real cycles: the row count
    // must stop growing once we have seen everything, no matter how often we re-read.
    await poller.polling.poll(CUSTOMERS.globalgoods);
    await poller.polling.poll(CUSTOMERS.globalgoods);
    const third = await poller.polling.poll(CUSTOMERS.globalgoods);

    const stored = await poller.repository.findAll();
    const distinct = new Set(stored.map((order) => order.externalOrderId));

    // Every order occupies exactly one row — never a second one for a re-read.
    expect(stored.length).toBe(distinct.size);
    // And by the third cycle we are mostly re-reading what we already have.
    expect(third?.duplicated).toBeGreaterThan(0);
    expect(third?.received).toBe(4);
  });

  it(
    'CONFIRMS a 429 does not advance their cursor — the reason retrying a page is safe',
    { timeout: 120_000 },
    async () => {
      // The load-bearing assumption. We retry the SAME page after a 429; if their
      // cursor had already moved when they rejected us, that retry would silently
      // skip records. Their code happens to reject before advancing — but that is
      // their implementation detail, not a promise, so it gets verified rather than
      // trusted.
      //
      // This mock is throttled to 3 requests/minute so a 429 can be provoked.
      const url = `${THROTTLED_MOCK_URL}/customer-c/orders?page=1`;
      const refsOf = (body: unknown) =>
        (body as PageResponse).orders.map((order) => order.reference);

      const first = await poller.http.get(url, 'globalgoods');
      await poller.http.get(url, 'globalgoods');
      await poller.http.get(url, 'globalgoods'); // 3 of 3 spent

      const throttled = await poller.http.get(url, 'globalgoods');
      const throttledAgain = await poller.http.get(url, 'globalgoods');

      // They really do throttle, and they really do say for how long.
      expect(throttled.status).toBe(429);
      expect(throttled.retryAfterSeconds).toBe(60);
      expect(throttledAgain.status).toBe(429);

      // Wait out their window, as our backoff does.
      await new Promise((resolve) => setTimeout(resolve, 62_000));

      const afterBackoff = await poller.http.get(url, 'globalgoods');

      // Three successful page=1 requests advanced their cursor three times and wrapped
      // it back to where it started. The two 429s advanced it ZERO times — so this
      // request returns exactly the window the very first one did. Had a rejected
      // request moved the cursor, these would differ, and every 429 in production
      // would be quietly dropping orders.
      expect(afterBackoff.status).toBe(200);
      expect(refsOf(afterBackoff.body)).toEqual(refsOf(first.body));
    },
  );
});

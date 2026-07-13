import { SchedulerRegistry } from '@nestjs/schedule';
import { beforeEach, describe, expect, it } from 'vitest';
import { CustomerRegistryService } from '../../../src/customers/customer-registry.service';
import { CUSTOMERS } from '../../../src/customers/customer.config';
import { MapperRegistryService } from '../../../src/ingestion/normalization/mapper-registry.service';
import { BairroboxMapper } from '../../../src/ingestion/normalization/mappers/bairrobox.mapper';
import { FreshmartMapper } from '../../../src/ingestion/normalization/mappers/freshmart.mapper';
import { GlobalgoodsMapper } from '../../../src/ingestion/normalization/mappers/globalgoods.mapper';
import { InMemoryOrderRepository } from '../../../src/ingestion/persistence/in-memory-order.repository';
import { IngestionPipelineService } from '../../../src/ingestion/pipeline/ingestion-pipeline.service';
import { PollingService } from '../../../src/ingestion/sources/polling/polling.service';
import {
  SourceHttpClient,
  SourceUnavailableError,
  type SourceResponse,
} from '../../../src/ingestion/sources/polling/source-http.client';
import { SourceReaderService } from '../../../src/ingestion/sources/polling/source-reader.service';

/**
 * A stand-in for a customer's API. Records every URL asked for, which is how the
 * page-walk and the 429 retry are checked: what matters is not just the records that
 * come back, but exactly which requests we made to get them.
 */
class FakeSource extends SourceHttpClient {
  readonly requested: string[] = [];
  private queue: (SourceResponse | Error)[] = [];

  respondWith(...responses: (SourceResponse | Error)[]): void {
    this.queue = [...responses];
  }

  get(url: string, customerId: string): Promise<SourceResponse> {
    this.requested.push(url);

    const next = this.queue.length > 1 ? this.queue.shift() : this.queue[0];

    if (next === undefined) {
      return Promise.reject(
        new SourceUnavailableError(
          customerId,
          url,
          new Error('nothing queued'),
        ),
      );
    }

    if (next instanceof Error) {
      return Promise.reject(next);
    }

    return Promise.resolve(next);
  }
}

function bairroboxOrder(id: string, situacao = 'Novo') {
  return {
    id,
    shop: 'BairroBox Centro',
    date: '20/06/2026 10:40',
    situacao,
    items: 'Arroz 5kg|x1|29.90',
    endereco: 'Rua Augusta 500, Sao Paulo',
    store_code: 'BB-01',
  };
}

function globalgoodsOrder(reference: string) {
  return {
    reference,
    location: { code: 'MX-CDMX-01', label: 'GlobalGoods Reforma' },
    timestamp: '06-20-2026 08:50 AM',
    order_status: 1,
    money: { currency: 'MXN', unit: 'cents' },
    products: [
      {
        code: 'C03',
        title: 'Tortilla de Maiz 1kg',
        amount: 1,
        uom: 'unit',
        line_total: 3200,
      },
    ],
    destination: {
      address: 'Paseo de la Reforma 222',
      city: 'Mexico City',
      country: 'Mexico',
    },
  };
}

describe('polling', () => {
  let source: FakeSource;
  let repository: InMemoryOrderRepository;
  let reader: SourceReaderService;
  let polling: PollingService;

  beforeEach(() => {
    source = new FakeSource();
    repository = new InMemoryOrderRepository();
    reader = new SourceReaderService(source);

    const pipeline = new IngestionPipelineService(
      new MapperRegistryService(
        new FreshmartMapper(),
        new BairroboxMapper(),
        new GlobalgoodsMapper(),
      ),
      repository,
    );

    polling = new PollingService(
      new CustomerRegistryService(),
      reader,
      pipeline,
      new SchedulerRegistry(),
    );
  });

  describe('a flat source (BairroBox)', () => {
    it('reads the whole array in one request and ingests it', async () => {
      source.respondWith({
        status: 200,
        body: [bairroboxOrder('5580'), bairroboxOrder('5581')],
      });

      const outcome = await polling.poll(CUSTOMERS.bairrobox);

      expect(source.requested).toHaveLength(1);
      expect(outcome?.received).toBe(2);
      expect(outcome?.created).toBe(2);
      expect(await repository.count()).toBe(2);
    });
  });

  describe('a paginated source (GlobalGoods)', () => {
    it('walks page 1 then page 2 exactly once, and stops when hasMore turns false', async () => {
      // Their page=1 ADVANCES the window on their side. Asking for it twice in one
      // cycle would silently skip whatever the cursor moved past.
      source.respondWith(
        {
          status: 200,
          body: {
            page: 1,
            hasMore: true,
            orders: [globalgoodsOrder('GG_1'), globalgoodsOrder('GG_2')],
          },
        },
        {
          status: 200,
          body: {
            page: 2,
            hasMore: false,
            orders: [globalgoodsOrder('GG_3')],
          },
        },
      );

      const outcome = await polling.poll(CUSTOMERS.globalgoods);

      expect(source.requested).toEqual([
        'http://localhost:4000/customer-c/orders?page=1',
        'http://localhost:4000/customer-c/orders?page=2',
      ]);
      expect(outcome?.received).toBe(3);
      expect(await repository.count()).toBe(3);
    });

    it('stops at the page cap when a source keeps saying hasMore forever', async () => {
      // An empty page that still claims hasMore would otherwise spin the cycle until
      // the process died.
      source.respondWith({
        status: 200,
        body: { page: 1, hasMore: true, orders: [] },
      });

      const outcome = await polling.poll(CUSTOMERS.globalgoods);

      const cap = CUSTOMERS.globalgoods.source.pagination.maxPagesPerCycle;
      expect(source.requested).toHaveLength(cap);
      expect(outcome?.received).toBe(0);
    });
  });

  describe('rate limiting', () => {
    it('obeys a 429 and retries THE SAME page, never re-requesting page 1', async () => {
      // Safe only because their 429 comes back before the cursor advances. Retrying a
      // different page would skip records; re-requesting page 1 would skip a window.
      source.respondWith(
        { status: 429, retryAfterSeconds: 0 },
        { status: 429, retryAfterSeconds: 0 },
        {
          status: 200,
          body: { page: 1, hasMore: false, orders: [globalgoodsOrder('GG_1')] },
        },
      );

      const outcome = await polling.poll(CUSTOMERS.globalgoods);

      expect(source.requested).toEqual([
        'http://localhost:4000/customer-c/orders?page=1',
        'http://localhost:4000/customer-c/orders?page=1',
        'http://localhost:4000/customer-c/orders?page=1',
      ]);
      expect(outcome?.created).toBe(1);
    });

    it('gives the cycle up rather than hammering a source that keeps throttling', async () => {
      source.respondWith({ status: 429, retryAfterSeconds: 0 });

      const outcome = await polling.poll(CUSTOMERS.globalgoods);

      expect(source.requested).toHaveLength(3); // capped attempts, then it stops
      expect(outcome?.received).toBe(0);
      expect(await repository.count()).toBe(0);
    });
  });

  describe('isolation and failure', () => {
    it('does not let one customer being down break another', async () => {
      // GlobalGoods is unreachable; BairroBox must still be ingested. A source outage
      // is infrastructure failing, not a bad record — it propagates out of the reader
      // and is contained at the poll cycle.
      source.respondWith(new Error('ECONNREFUSED'));
      const globalgoods = await polling.poll(CUSTOMERS.globalgoods);

      expect(globalgoods).toBeUndefined(); // the cycle was lost, not the service
      expect(await repository.count()).toBe(0);

      source.respondWith({ status: 200, body: [bairroboxOrder('5580')] });
      const bairrobox = await polling.poll(CUSTOMERS.bairrobox);

      expect(bairrobox?.created).toBe(1);
      expect(await repository.count()).toBe(1);
    });

    it('treats a source that answers with the wrong shape as an empty cycle', async () => {
      source.respondWith({ status: 200, body: { unexpected: 'shape' } });

      const outcome = await polling.poll(CUSTOMERS.bairrobox);

      expect(outcome?.received).toBe(0);
      expect(await repository.count()).toBe(0);
    });
  });

  describe('idempotency across poll cycles', () => {
    it('writes one row for an order seen in two consecutive cycles', async () => {
      // Their windows slide and overlap on purpose: a real second poll returns orders
      // the first one already gave us.
      source.respondWith({
        status: 200,
        body: [bairroboxOrder('5582'), bairroboxOrder('5583')],
      });
      await polling.poll(CUSTOMERS.bairrobox);

      source.respondWith({
        status: 200,
        body: [bairroboxOrder('5583'), bairroboxOrder('5584')], // 5583 again
      });
      const second = await polling.poll(CUSTOMERS.bairrobox);

      expect(second?.created).toBe(1); // only 5584 is new
      expect(second?.duplicated).toBe(1); // 5583 was a re-read
      expect(await repository.count()).toBe(3); // 5582, 5583, 5584 — no fourth row
    });

    it('UPDATES a re-read order whose status moved on, instead of dropping it', async () => {
      source.respondWith({
        status: 200,
        body: [bairroboxOrder('5582', 'Novo')],
      });
      await polling.poll(CUSTOMERS.bairrobox);

      const [first] = await repository.findAll();
      expect(first.status).toBe('received');

      // Next cycle: same order, but they have started picking it.
      source.respondWith({
        status: 200,
        body: [bairroboxOrder('5582', 'Em separacao')],
      });
      const second = await polling.poll(CUSTOMERS.bairrobox);

      expect(second?.duplicated).toBe(1);
      expect(await repository.count()).toBe(1); // still one row

      const [updated] = await repository.findAll();
      expect(updated.status).toBe('picking'); // the update was NOT lost
      expect(updated.orderId).toBe(first.orderId);
      expect(updated.ingestedAt).toBe(first.ingestedAt);
    });

    it('collapses an order repeated inside a single response', async () => {
      // Their real feed does this: one window contains 5582 twice.
      source.respondWith({
        status: 200,
        body: [
          bairroboxOrder('5582'),
          bairroboxOrder('5583'),
          bairroboxOrder('5582'),
        ],
      });

      const outcome = await polling.poll(CUSTOMERS.bairrobox);

      expect(outcome?.received).toBe(3);
      expect(outcome?.created).toBe(2);
      expect(outcome?.duplicated).toBe(1);
      expect(await repository.count()).toBe(2);
    });
  });
});

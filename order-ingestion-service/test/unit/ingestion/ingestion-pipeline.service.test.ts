import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CUSTOMERS } from '../../../src/customers/customer.config';
import { stableOrderId } from '../../../src/ingestion/dedup/order-id';
import { MapperRegistryService } from '../../../src/ingestion/normalization/mapper-registry.service';
import { BairroboxMapper } from '../../../src/ingestion/normalization/mappers/bairrobox.mapper';
import { FreshmartMapper } from '../../../src/ingestion/normalization/mappers/freshmart.mapper';
import { GlobalgoodsMapper } from '../../../src/ingestion/normalization/mappers/globalgoods.mapper';
import { InMemoryOrderRepository } from '../../../src/ingestion/persistence/in-memory-order.repository';
import { IngestionPipelineService } from '../../../src/ingestion/pipeline/ingestion-pipeline.service';

const FIXTURES = resolve(__dirname, '../../../../mock-customer-apis/fixtures');

function freshmartOrder(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(FIXTURES, 'customer-a.sample.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('IngestionPipelineService', () => {
  let repository: InMemoryOrderRepository;
  let pipeline: IngestionPipelineService;

  beforeEach(() => {
    repository = new InMemoryOrderRepository();
    pipeline = new IngestionPipelineService(
      new MapperRegistryService(
        new FreshmartMapper(),
        new BairroboxMapper(),
        new GlobalgoodsMapper(),
      ),
      repository,
    );
  });

  it('normalizes and persists a real FreshMart payload', async () => {
    const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [
      freshmartOrder(),
    ]);

    expect(outcome.received).toBe(1);
    expect(outcome.normalized).toBe(1);
    expect(outcome.created).toBe(1);
    expect(outcome.failed).toBe(0);

    const [order] = await repository.findAll();
    expect(order.externalOrderId).toBe('FM-100245');
    expect(order.customerId).toBe('freshmart');
    expect(order.status).toBe('received');
    expect(order.createdAt).toBe('2026-06-20T14:32:00.000Z');
    expect(order.deliveryAddress.country).toBe('BR');
  });

  it('keeps money exact by summing in minor units', async () => {
    // 6 x 5.49 + 2 x 8.90. In floats this is 50.739999999999995; the total must be
    // 5074 cents exactly, and each unit price an integer.
    await pipeline.ingest(CUSTOMERS.freshmart, [freshmartOrder()]);

    const [order] = await repository.findAll();

    expect(order.items.map((item) => item.unitPrice.amount)).toEqual([
      549, 890,
    ]);
    expect(order.total).toEqual({ amount: 5074, currency: 'BRL' });
    expect(Number.isInteger(order.total.amount)).toBe(true);
  });

  describe('idempotency', () => {
    it('writes one row when the same order arrives twice', async () => {
      await pipeline.ingest(CUSTOMERS.freshmart, [freshmartOrder()]);
      const second = await pipeline.ingest(CUSTOMERS.freshmart, [
        freshmartOrder(),
      ]);

      expect(await repository.count()).toBe(1);
      expect(second.created).toBe(0);
      expect(second.duplicated).toBe(1);
    });

    it('updates the row when a re-read carries a NEW status, rather than dropping it', async () => {
      // This is the whole reason dedup is an upsert. The pollers re-read orders
      // whose status has moved on; discarding the repeat as a "duplicate" would
      // silently lose the update.
      await pipeline.ingest(CUSTOMERS.freshmart, [freshmartOrder()]);

      const orderId = stableOrderId('freshmart', 'FM-100245');
      const before = await repository.findById(orderId);

      // The same order, re-read with different content — as a poller would see it
      // once the customer edited it.
      const changed = freshmartOrder();
      changed.lines = [
        { sku: '7891000', desc: 'Leite Integral 1L', qty: 6, price: 5.49 },
      ];
      await pipeline.ingest(CUSTOMERS.freshmart, [changed]);

      const after = await repository.findById(orderId);
      expect(await repository.count()).toBe(1);
      expect(after?.items).toHaveLength(1);
      expect(after?.total.amount).toBe(3294);
      expect(after?.ingestedAt).toBe(before?.ingestedAt); // first sighting is kept
    });

    it('collapses an order repeated INSIDE one batch, as the real feeds do', async () => {
      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [
        freshmartOrder(),
        freshmartOrder(),
      ]);

      expect(outcome.received).toBe(2);
      expect(outcome.created).toBe(1);
      expect(outcome.duplicated).toBe(1);
      expect(await repository.count()).toBe(1);
    });

    it('derives the same orderId for the same customer and external id', () => {
      expect(stableOrderId('freshmart', 'FM-100245')).toBe(
        stableOrderId('freshmart', 'FM-100245'),
      );
      expect(stableOrderId('freshmart', 'FM-100245')).not.toBe(
        stableOrderId('bairrobox', 'FM-100245'),
      );
    });
  });

  describe('resilience', () => {
    it('persists the good records in a batch and captures the bad one with a reason', async () => {
      const good = freshmartOrder();
      const undeliverable = {
        ...freshmartOrder(),
        order_id: 'FM-BROKEN',
        ship_to: { street: '', city: '', country: 'BR' },
      };

      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [
        undeliverable,
        good,
      ]);

      expect(outcome.failed).toBe(1);
      expect(outcome.normalized).toBe(1);
      expect(await repository.count()).toBe(1);

      const [order] = await repository.findAll();
      expect(order.externalOrderId).toBe('FM-100245');

      const [failure] = outcome.failures;
      expect(failure.externalOrderId).toBe('FM-BROKEN');
      expect(failure.field).toBe('ship_to');
      expect(failure.reason).toBeTruthy();
    });

    it('captures an unmapped status instead of guessing a default', async () => {
      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [
        { ...freshmartOrder(), state: 'ON_HOLD' },
      ]);

      expect(outcome.failed).toBe(1);
      expect(await repository.count()).toBe(0);
      expect(outcome.failures[0].field).toBe('state');
    });

    it('does not let a garbage record throw out of the batch', async () => {
      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [
        'not an object',
        null,
        freshmartOrder(),
      ]);

      expect(outcome.received).toBe(3);
      expect(outcome.failed).toBe(2);
      expect(outcome.normalized).toBe(1);
      expect(await repository.count()).toBe(1);
    });
  });

  describe('data quality', () => {
    it('drops a zero-quantity line with a reason but keeps the order', async () => {
      const order = freshmartOrder();
      order.lines = [
        { sku: '7891000', desc: 'Leite Integral 1L', qty: 6, price: 5.49 },
        { sku: '7890099', desc: 'Cafe 500g', qty: 0, price: 0 },
      ];

      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [order]);

      expect(outcome.normalized).toBe(1);
      expect(outcome.warnings).toHaveLength(1);
      expect(outcome.warnings[0].reason).toMatch(/quantity is 0/);

      const [stored] = await repository.findAll();
      expect(stored.items).toHaveLength(1);
      expect(stored.total.amount).toBe(3294);
    });

    it('keeps a zero-priced line, because the goods were still ordered', async () => {
      const order = freshmartOrder();
      order.lines = [{ sku: 'BB1', desc: 'Feijao 1kg', qty: 3, price: 0 }];

      const outcome = await pipeline.ingest(CUSTOMERS.freshmart, [order]);

      expect(outcome.normalized).toBe(1);
      expect(outcome.warnings[0].reason).toMatch(/line total is 0/i);

      const [stored] = await repository.findAll();
      expect(stored.items).toHaveLength(1);
      expect(stored.items[0].quantity).toBe(3);
      expect(stored.total.amount).toBe(0);
    });
  });
});

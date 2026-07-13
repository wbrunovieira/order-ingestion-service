import { describe, expect, it } from 'vitest';
import type { IngestionOutcome } from '../../../src/ingestion/pipeline/ingestion-outcome';
import { IngestionStatsService } from '../../../src/ingestion/stats/ingestion-stats.service';

function outcome(partial: Partial<IngestionOutcome>): IngestionOutcome {
  return {
    customerId: 'bairrobox',
    received: 0,
    normalized: 0,
    created: 0,
    duplicated: 0,
    failed: 0,
    failures: [],
    warnings: [],
    ...partial,
  };
}

describe('IngestionStatsService', () => {
  it('accumulates counters per customer across batches', () => {
    const stats = new IngestionStatsService();

    stats.record(
      outcome({
        customerId: 'bairrobox',
        received: 4,
        normalized: 4,
        created: 4,
      }),
    );
    stats.record(
      outcome({
        customerId: 'bairrobox',
        received: 4,
        normalized: 4,
        duplicated: 4,
      }),
    );
    stats.record(
      outcome({
        customerId: 'globalgoods',
        received: 2,
        normalized: 2,
        created: 2,
      }),
    );

    const { customers } = stats.snapshot();
    const bairrobox = customers.find((c) => c.customerId === 'bairrobox');

    expect(bairrobox).toMatchObject({
      received: 8,
      normalized: 8,
      created: 4,
      duplicated: 4, // the second cycle re-read what the first one created
      batches: 2,
    });
    expect(bairrobox?.lastIngestedAt).toBeTruthy();

    // One customer's numbers never leak into another's.
    expect(customers.find((c) => c.customerId === 'globalgoods')).toMatchObject(
      {
        received: 2,
        created: 2,
        duplicated: 0,
      },
    );
  });

  it('keeps failures with the field and the reason that caused them', () => {
    const stats = new IngestionStatsService();

    stats.record(
      outcome({
        received: 1,
        failed: 1,
        failures: [
          {
            customerId: 'bairrobox',
            externalOrderId: '5584',
            field: 'endereco',
            reason: 'delivery address is empty — the order is undeliverable',
            at: '2026-06-20T13:40:00.000Z',
          },
        ],
      }),
    );

    const { recentFailures, customers } = stats.snapshot();

    expect(customers[0].failed).toBe(1);
    expect(recentFailures).toHaveLength(1);
    expect(recentFailures[0]).toMatchObject({
      externalOrderId: '5584',
      field: 'endereco',
    });
    expect(recentFailures[0].reason).toBeTruthy();
  });

  it('shows the newest failures first, and does not grow without bound', () => {
    const stats = new IngestionStatsService();

    for (let i = 0; i < 60; i += 1) {
      stats.record(
        outcome({
          failed: 1,
          failures: [
            {
              customerId: 'bairrobox',
              externalOrderId: `order-${i}`,
              field: 'endereco',
              reason: 'empty',
              at: '2026-06-20T13:40:00.000Z',
            },
          ],
        }),
      );
    }

    const { recentFailures, customers } = stats.snapshot();

    // The counter still knows about all 60; the buffer keeps only the recent ones,
    // because this is a diagnostic aid, not a log store.
    expect(customers[0].failed).toBe(60);
    expect(recentFailures).toHaveLength(50);
    expect(recentFailures[0].externalOrderId).toBe('order-59'); // newest first
  });
});

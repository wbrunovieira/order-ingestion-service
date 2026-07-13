import { Injectable } from '@nestjs/common';
import { resolveStatus } from '../../../customers/customer-registry.service';
import type { CustomerConfig } from '../../../customers/customer.config';
import type { OrderItem } from '../../../orders/canonical-order.model';
import { stableOrderId } from '../../dedup/order-id';
import { WARNING_REASONS } from '../../pipeline/ingestion-failure';
import {
  MappingReport,
  type MapOutcome,
  type OrderMapper,
} from '../order-mapper';
import {
  asArray,
  asFiniteNumber,
  asNonEmptyString,
  asString,
  isRecord,
} from '../raw';
import { parseIsoDateTime } from '../transforms/date';
import { sumLineTotals, toMinorUnits } from '../transforms/money';

/**
 * Customer A — FreshMart. The clean one: nested JSON, ISO-8601 UTC timestamps,
 * ISO currency and country codes, and `price` is already a UNIT price.
 *
 * Even here two things must happen. Prices become integer minor units (their 5.49
 * is 549), and the total is derived, because they do not send one.
 */
@Injectable()
export class FreshmartMapper implements OrderMapper {
  map(raw: unknown, config: CustomerConfig): MapOutcome {
    const report = new MappingReport(config.id);

    if (!isRecord(raw)) {
      report.fail('(payload)', 'payload is not a JSON object');
      return { ok: false, failures: report.failures };
    }

    const externalOrderId = asNonEmptyString(raw.order_id);
    if (externalOrderId === undefined) {
      report.fail(
        'order_id',
        'missing — an order without their id cannot be identified or deduplicated',
      );
      return { ok: false, failures: report.failures };
    }
    report.identify(externalOrderId);

    const status = resolveStatus(config, raw.state);
    if (status === undefined) {
      report.fail(
        'state',
        `unmapped status ${JSON.stringify(raw.state)} — refusing to guess a default`,
      );
    }

    // FreshMart already sends an offset, so there is nothing to assume — but the
    // parsing still lives in transforms/date.ts with everyone else's. Three feeds and
    // three date formats is exactly the situation where a fourth private copy of "turn
    // this into an instant" starts drifting from the other three.
    const rawTimestamp = asNonEmptyString(raw.placed_at);
    const createdAt =
      rawTimestamp === undefined ? undefined : parseIsoDateTime(rawTimestamp);
    if (createdAt === undefined) {
      report.fail(
        'placed_at',
        `unparseable timestamp ${JSON.stringify(raw.placed_at)}`,
      );
    }

    const currency = asNonEmptyString(raw.currency) ?? config.defaultCurrency;
    const items = this.mapItems(raw.lines, currency, report);

    const shipTo = isRecord(raw.ship_to) ? raw.ship_to : undefined;
    const line1 = asNonEmptyString(shipTo?.street);
    const city = asNonEmptyString(shipTo?.city);
    const country = asNonEmptyString(shipTo?.country) ?? config.defaultCountry;

    if (line1 === undefined || city === undefined) {
      // Undeliverable, not merely incomplete. We reject rather than persist an
      // order no courier could ever act on.
      report.fail('ship_to', 'delivery address is missing a street or a city');
    }

    const storeId = asString(raw.store_id) ?? '';
    if (storeId === '') {
      report.warn('store_id', WARNING_REASONS.emptyStoreCode);
    }

    // One guard, so every reason the record is unusable is reported at once rather
    // than one per re-submission. It also narrows the optionals for the build below.
    if (
      report.failed ||
      status === undefined ||
      createdAt === undefined ||
      line1 === undefined ||
      city === undefined
    ) {
      return { ok: false, failures: report.failures };
    }

    return {
      ok: true,
      order: {
        orderId: stableOrderId(config.id, externalOrderId),
        externalOrderId,
        customerId: config.id,
        status,
        createdAt,
        store: {
          storeId,
          name: asNonEmptyString(raw.store_name) ?? config.name,
        },
        items,
        total: { amount: sumLineTotals(items), currency },
        deliveryAddress: { line1, city, country },
      },
      warnings: report.warnings,
    };
  }

  private mapItems(
    value: unknown,
    currency: string,
    report: MappingReport,
  ): OrderItem[] {
    const lines = asArray(value);
    if (lines === undefined || lines.length === 0) {
      report.fail('lines', 'order has no items');
      return [];
    }

    const items: OrderItem[] = [];

    for (const [index, line] of lines.entries()) {
      if (!isRecord(line)) {
        report.fail(`lines.${index}`, 'line is not an object');
        continue;
      }

      const sku = asNonEmptyString(line.sku);
      const name = asNonEmptyString(line.desc);
      const quantity = asFiniteNumber(line.qty);
      const price = asFiniteNumber(line.price);

      if (sku === undefined || name === undefined) {
        report.fail(`lines.${index}`, 'line is missing a sku or a description');
        continue;
      }

      if (quantity === undefined || price === undefined) {
        report.fail(
          `lines.${index}`,
          'line has a non-numeric quantity or price',
        );
        continue;
      }

      // Unorderable, and the shape of the divide-by-zero the other feeds plant.
      if (quantity <= 0) {
        report.warn(`lines.${index}`, WARNING_REASONS.droppedZeroQuantityLine);
        continue;
      }

      if (price === 0) {
        report.warn(`lines.${index}`, WARNING_REASONS.zeroPrice);
      }

      // Their price is already per unit — it only has to stop being a float.
      items.push({
        sku,
        name,
        quantity,
        unitPrice: { amount: toMinorUnits(price), currency },
      });
    }

    if (items.length === 0 && !report.failed) {
      report.fail('lines', 'every line was dropped — nothing left to fulfil');
    }

    return items;
  }
}

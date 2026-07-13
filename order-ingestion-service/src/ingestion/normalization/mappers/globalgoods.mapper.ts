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
import { asArray, asFiniteNumber, asNonEmptyString, isRecord } from '../raw';
import { countryToIso } from '../transforms/address';
import { parseUsDateTime12h } from '../transforms/date';
import { toMinorUnits, unitPriceFromLineTotal } from '../transforms/money';

/**
 * Customer C — GlobalGoods. The international one:
 *
 *   - money arrives in CENTS already (money.unit === "cents"), so it must NOT be
 *     multiplied again — the one feed where converting would be the bug
 *   - quantity can be a weight: 1.5 kg of avocado, not 1.5 avocados
 *   - line_total is a LINE total, so the unit price is a price per kg for those
 *   - the date is US month-first, 12-hour, in local time
 *   - the country is a full name where the model wants ISO-3166 alpha-2
 */
@Injectable()
export class GlobalgoodsMapper implements OrderMapper {
  map(raw: unknown, config: CustomerConfig): MapOutcome {
    const report = new MappingReport(config.id);

    if (!isRecord(raw)) {
      report.fail('(payload)', 'payload is not a JSON object');
      return { ok: false, failures: report.failures };
    }

    const externalOrderId = asNonEmptyString(raw.reference);
    if (externalOrderId === undefined) {
      report.fail(
        'reference',
        'missing — the order cannot be identified or deduplicated',
      );
      return { ok: false, failures: report.failures };
    }
    report.identify(externalOrderId);

    const status = resolveStatus(config, raw.order_status);
    if (status === undefined) {
      report.fail(
        'order_status',
        `unmapped status ${JSON.stringify(raw.order_status)} — refusing to guess a default`,
      );
    }

    const rawTimestamp = asNonEmptyString(raw.timestamp);
    const createdAt =
      rawTimestamp === undefined
        ? undefined
        : parseUsDateTime12h(rawTimestamp, config.timezone);
    if (createdAt === undefined) {
      report.fail(
        'timestamp',
        `unparseable timestamp ${JSON.stringify(raw.timestamp)} — expected MM-DD-YYYY hh:mm AM/PM`,
      );
    }

    const money = isRecord(raw.money) ? raw.money : undefined;
    const currency =
      asNonEmptyString(money?.currency) ?? config.defaultCurrency;
    const isAlreadyMinor =
      asNonEmptyString(money?.unit)?.toLowerCase() === 'cents';

    const { items, totalMinor } = this.mapItems(
      raw.products,
      currency,
      isAlreadyMinor,
      report,
    );

    const destination = isRecord(raw.destination) ? raw.destination : undefined;
    const line1 = asNonEmptyString(destination?.address);
    const city = asNonEmptyString(destination?.city);
    const rawCountry = asNonEmptyString(destination?.country);

    if (line1 === undefined || city === undefined) {
      report.fail(
        'destination',
        'delivery address is missing a street or a city — the order is undeliverable',
      );
    }

    // "Mexico" -> "MX". An unknown country is a failure, not a guess: them shipping
    // somewhere new is something we want to be told about.
    const country =
      rawCountry === undefined
        ? config.defaultCountry
        : countryToIso(rawCountry);
    if (country === undefined) {
      report.fail(
        'destination.country',
        `unrecognised country ${JSON.stringify(rawCountry)} — cannot map to ISO-3166 alpha-2`,
      );
    }

    const location = isRecord(raw.location) ? raw.location : undefined;

    if (
      report.failed ||
      status === undefined ||
      createdAt === undefined ||
      line1 === undefined ||
      city === undefined ||
      country === undefined
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
          storeId: asNonEmptyString(location?.code) ?? '',
          name: asNonEmptyString(location?.label) ?? config.name,
        },
        items,
        // Their line totals, summed as they sent them. Multiplying our derived unit
        // price back out by a fractional kg would round differently — and the total
        // is the number that has to be right.
        total: { amount: totalMinor, currency },
        deliveryAddress: { line1, city, country },
      },
      warnings: report.warnings,
    };
  }

  private mapItems(
    value: unknown,
    currency: string,
    isAlreadyMinor: boolean,
    report: MappingReport,
  ): { items: OrderItem[]; totalMinor: number } {
    const products = asArray(value);
    if (products === undefined || products.length === 0) {
      report.fail('products', 'order has no items');
      return { items: [], totalMinor: 0 };
    }

    const items: OrderItem[] = [];
    let totalMinor = 0;

    for (const [index, product] of products.entries()) {
      const field = `products.${index}`;

      if (!isRecord(product)) {
        report.fail(field, 'product is not an object');
        continue;
      }

      const sku = asNonEmptyString(product.code);
      const name = asNonEmptyString(product.title);
      const quantity = asFiniteNumber(product.amount);
      const rawLineTotal = asFiniteNumber(product.line_total);

      if (sku === undefined || name === undefined) {
        report.fail(field, 'product is missing a code or a title');
        continue;
      }

      if (quantity === undefined || rawLineTotal === undefined) {
        report.fail(field, 'product has a non-numeric amount or line_total');
        continue;
      }

      // They declare their unit. If they ever stop sending cents, this converts
      // instead of silently inflating every price by 100x.
      const lineTotalMinor = isAlreadyMinor
        ? Math.round(rawLineTotal)
        : toMinorUnits(rawLineTotal);

      const unitPrice = unitPriceFromLineTotal(lineTotalMinor, quantity);

      // "Limon (by kg)" with amount 0 and line_total 0 — unorderable, and the
      // divide-by-zero. The line goes, the rest of the order stays.
      if (unitPrice === undefined) {
        report.warn(field, WARNING_REASONS.droppedZeroQuantityLine);
        continue;
      }

      if (lineTotalMinor === 0) {
        report.warn(field, WARNING_REASONS.zeroPrice);
      }

      // quantity stays fractional for uom "kg": 1.5 means 1.5 kilos, and unitPrice is
      // then a price per kilo. Rounding it to 2 would invent a kilo of avocado.
      items.push({
        sku,
        name,
        quantity,
        unitPrice: { amount: unitPrice, currency },
      });

      totalMinor += lineTotalMinor;
    }

    if (items.length === 0 && !report.failed) {
      report.fail(
        'products',
        'every line was dropped — nothing left to fulfil',
      );
    }

    return { items, totalMinor };
  }
}

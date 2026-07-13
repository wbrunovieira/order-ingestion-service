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
import { asNonEmptyString, asString, isRecord } from '../raw';
import { splitAddressLine } from '../transforms/address';
import { parseBrDateTime } from '../transforms/date';
import { parseDelimitedItems } from '../transforms/delimited-items';
import { toMinorUnits, unitPriceFromLineTotal } from '../transforms/money';
import { synthesizeSku } from '../transforms/sku';

/**
 * Customer B — BairroBox. The messy one, and every quirk here is real:
 *
 *   - the entire item list is one string: "Arroz 5kg|x2|59.80;Feijao 1kg|x3|0"
 *   - the price is a LINE total, not a unit price
 *   - there is no product code at all, so the sku has to be synthesized
 *   - status is Portuguese, the date is DD/MM/YYYY in local time
 *   - the address is one string, and is sometimes empty
 *   - currency and country are simply absent
 *
 * The mapper only assembles; every transform it uses is named, shared and tested on
 * its own.
 */
@Injectable()
export class BairroboxMapper implements OrderMapper {
  map(raw: unknown, config: CustomerConfig): MapOutcome {
    const report = new MappingReport(config.id);

    if (!isRecord(raw)) {
      report.fail('(payload)', 'payload is not a JSON object');
      return { ok: false, failures: report.failures };
    }

    const externalOrderId = asNonEmptyString(raw.id);
    if (externalOrderId === undefined) {
      report.fail(
        'id',
        'missing — the order cannot be identified or deduplicated',
      );
      return { ok: false, failures: report.failures };
    }
    report.identify(externalOrderId);

    const status = resolveStatus(config, raw.situacao);
    if (status === undefined) {
      report.fail(
        'situacao',
        `unmapped status ${JSON.stringify(raw.situacao)} — refusing to guess a default`,
      );
    }

    const rawDate = asNonEmptyString(raw.date);
    const createdAt =
      rawDate === undefined
        ? undefined
        : parseBrDateTime(rawDate, config.timezone);
    if (createdAt === undefined) {
      report.fail(
        'date',
        `unparseable date ${JSON.stringify(raw.date)} — expected DD/MM/YYYY HH:mm`,
      );
    }

    // They send no currency at all. The assumption is declared in config, not here.
    const currency = config.defaultCurrency;
    const { items, totalMinor } = this.mapItems(
      raw.items,
      currency,
      config,
      report,
    );

    // An empty `endereco` is not a parse failure — it is an order nobody can deliver.
    //
    // Note what the reason does NOT say: the address itself. A failure reason is
    // stored, served on /stats, and would be shipped to a log aggregator — echoing a
    // customer's delivery address into all three is how personal data ends up
    // somewhere nobody meant it to be. The field name and the problem are enough to
    // act on; the value is one lookup away for anyone who is entitled to it.
    const rawAddress = asString(raw.endereco) ?? '';
    const address = splitAddressLine(rawAddress);
    if (address === undefined) {
      report.fail(
        'endereco',
        rawAddress === ''
          ? 'delivery address is empty — the order is undeliverable'
          : 'delivery address could not be split into a street and a city',
      );
    }

    // Two of their orders really do carry store_code: "". Incomplete, but the order is
    // still fulfillable, so it is flagged and kept rather than dropped.
    const storeId = asString(raw.store_code) ?? '';
    if (storeId === '') {
      report.warn('store_code', WARNING_REASONS.emptyStoreCode);
    }

    if (
      report.failed ||
      status === undefined ||
      createdAt === undefined ||
      address === undefined
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
          name: asNonEmptyString(raw.shop) ?? config.name,
        },
        items,
        // The total sums the line totals THEY sent, not our derived unit prices
        // multiplied back out. Re-deriving would reintroduce rounding we just removed.
        total: { amount: totalMinor, currency },
        deliveryAddress: {
          line1: address.line1,
          city: address.city,
          country: config.defaultCountry, // absent from their feed; assumed in config
        },
      },
      warnings: report.warnings,
    };
  }

  private mapItems(
    value: unknown,
    currency: string,
    config: CustomerConfig,
    report: MappingReport,
  ): { items: OrderItem[]; totalMinor: number } {
    const rawItems = asString(value) ?? '';
    if (rawItems === '') {
      report.fail('items', 'order has no items');
      return { items: [], totalMinor: 0 };
    }

    const items: OrderItem[] = [];
    let totalMinor = 0;

    for (const [index, line] of parseDelimitedItems(rawItems).entries()) {
      const field = `items.${index}`;

      if (!line.ok) {
        report.fail(field, `${line.reason} (in "${line.raw}")`);
        continue;
      }

      const lineTotalMinor = toMinorUnits(line.lineTotalMajor);
      const unitPrice = unitPriceFromLineTotal(lineTotalMinor, line.quantity);

      // "Cafe 500g|x0|0": zero quantity is unorderable AND the divide-by-zero. The
      // line goes, the order stays.
      if (unitPrice === undefined) {
        report.warn(field, WARNING_REASONS.droppedZeroQuantityLine);
        continue;
      }

      // "Feijao 1kg|x3|0": zero PRICE is different. Three bags of beans really were
      // ordered and someone still has to pick them, so the line is kept and flagged.
      if (lineTotalMinor === 0) {
        report.warn(field, WARNING_REASONS.zeroPrice);
      }

      items.push({
        sku: synthesizeSku(config.id, line.name),
        name: line.name,
        quantity: line.quantity,
        unitPrice: { amount: unitPrice, currency },
      });

      totalMinor += lineTotalMinor;
    }

    if (items.length === 0 && !report.failed) {
      report.fail('items', 'every line was dropped — nothing left to fulfil');
    }

    return { items, totalMinor };
  }
}

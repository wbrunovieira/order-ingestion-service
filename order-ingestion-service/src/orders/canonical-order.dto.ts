import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsIn,
  IsInt,
  IsISO4217CurrencyCode,
  IsISO8601,
  IsISO31661Alpha2,
  IsNotEmpty,
  IsPositive,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';
import { ORDER_STATUSES, type OrderStatus } from './order-status';

/**
 * The validation boundary. A record only becomes a CanonicalOrder by passing this;
 * anything that fails becomes a captured failure with a reason, never a throw and
 * never a silent persist.
 *
 * The decorators are where the design decisions stop being documentation and start
 * being enforced.
 */

export class MoneyDto {
  /**
   * Integer minor units (cents). @IsInt is the guard rail for the money decision:
   * a mapper that forgets to convert and passes 5.49 fails validation loudly
   * instead of quietly seeding float drift through every later sum.
   */
  @IsInt({
    message: 'amount must be an integer in minor units (cents), not a float',
  })
  @Min(0)
  amount!: number;

  @IsISO4217CurrencyCode()
  currency!: string;
}

export class StoreDto {
  /**
   * Deliberately only @IsString: BairroBox sends `store_code: ""` for real orders.
   * A missing store code is incomplete, not unfulfillable, so it is flagged as a
   * data-quality warning rather than dropping an otherwise good order.
   */
  @IsString()
  storeId!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;
}

export class OrderItemDto {
  @IsString()
  @IsNotEmpty()
  sku!: string;

  @IsString()
  @IsNotEmpty()
  name!: string;

  /**
   * @IsPositive, not @Min(0): a zero-quantity line is not orderable, and it is the
   * divide-by-zero in `unitPrice = lineTotal / quantity`. Such lines are dropped
   * upstream with a reason, so none should ever reach here — this is the net.
   * Fractional values are allowed on purpose (GlobalGoods sells avocado by the kg).
   */
  @IsPositive()
  quantity!: number;

  @ValidateNested()
  @Type(() => MoneyDto)
  unitPrice!: MoneyDto;
}

export class DeliveryAddressDto {
  @IsString()
  @IsNotEmpty()
  line1!: string;

  @IsString()
  @IsNotEmpty()
  city!: string;

  /**
   * ISO-3166-1 alpha-2 only. GlobalGoods sends the full name "Mexico", so this
   * rejects the raw value by design — the mapper has to normalize it to "MX".
   */
  @IsISO31661Alpha2()
  country!: string;
}

export class CanonicalOrderDto {
  @IsString()
  @IsNotEmpty()
  orderId!: string;

  @IsString()
  @IsNotEmpty()
  externalOrderId!: string;

  @IsString()
  @IsNotEmpty()
  customerId!: string;

  @IsIn(ORDER_STATUSES)
  status!: OrderStatus;

  /** Strict: rejects a local timestamp that was never converted to UTC. */
  @IsISO8601({ strict: true })
  createdAt!: string;

  @ValidateNested()
  @Type(() => StoreDto)
  store!: StoreDto;

  /** An order with no items is not an order — it is a mapping failure. */
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items!: OrderItemDto[];

  @ValidateNested()
  @Type(() => MoneyDto)
  total!: MoneyDto;

  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  deliveryAddress!: DeliveryAddressDto;
}

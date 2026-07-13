import { Controller, Get } from '@nestjs/common';
import { OrderRepository } from '../ingestion/persistence/order.repository';
import { success } from '../utils/http-response';

/**
 * The read side. Whatever the rest of the platform builds on top of orders sees only
 * this shape — never a hint of which customer it came from or how it arrived.
 */
@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrderRepository) {}

  @Get()
  async list() {
    const orders = await this.orders.findAll();

    return success(`${orders.length} order(s)`, orders);
  }
}

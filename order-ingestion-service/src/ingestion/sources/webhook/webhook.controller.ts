import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { CustomerRegistryService } from '../../../customers/customer-registry.service';
import { success } from '../../../utils/http-response';
import { IngestionPipelineService } from '../../pipeline/ingestion-pipeline.service';

/**
 * Push ingestion — Customer A. The customer calls us.
 *
 * The controller is deliberately dumb: resolve who is calling, hand the raw payload
 * to the shared pipeline, answer. It does no mapping and makes no domain decision,
 * because the webhook and the pollers must converge on exactly the same pipeline —
 * that only holds if neither entry point does any of the work itself.
 */
@Controller('webhooks')
export class WebhookController {
  constructor(
    private readonly customers: CustomerRegistryService,
    private readonly pipeline: IngestionPipelineService,
  ) {}

  /**
   * 202, not 200: the customer is told we have taken responsibility for the order,
   * not that every downstream effect is done. Today the pipeline runs inline because
   * it is small; at scale this becomes "ack, then enqueue" without the contract
   * changing for the customer (see DESIGN.md).
   */
  @Post(':customer')
  @HttpCode(HttpStatus.ACCEPTED)
  async receive(@Param('customer') customerId: string, @Body() body: unknown) {
    const config = this.customers.find(customerId);

    if (config === undefined || config.mode !== 'push') {
      throw new NotFoundException(
        `No push customer is configured as "${customerId}"`,
      );
    }

    // A burst may arrive batched. One order or many is the same thing to the
    // pipeline, so accept both rather than making the customer care.
    const records = Array.isArray(body) ? body : [body];
    const outcome = await this.pipeline.ingest(config, records);

    return success(
      `Accepted ${outcome.received} order(s) from ${config.name}`,
      outcome,
    );
  }
}

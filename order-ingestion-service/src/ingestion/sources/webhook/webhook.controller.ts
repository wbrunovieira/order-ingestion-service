import {
  Body,
  Controller,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CustomerRegistryService } from '../../../customers/customer-registry.service';
import { failure, success } from '../../../utils/http-response';
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
   * The status code has to be honest, because the customer acts on it.
   *
   * 202 means we have taken responsibility for at least one order — including a
   * partial batch, where the good records are ours and the bad ones come back with
   * reasons so they can be fixed and resent. It is 202 rather than 200 because the
   * customer is told we own the order, not that every downstream effect is finished:
   * today the pipeline runs inline, and at scale this becomes "ack, then enqueue"
   * without their contract changing (DESIGN.md).
   *
   * 400 means we took NOTHING. Sending back a 202 for a payload where every record
   * failed would be telling the customer their orders are safe with us while we drop
   * them — the exact silent failure this service exists to prevent. They get the
   * failures, with the field and the reason, and a status their own monitoring will
   * notice.
   */
  @Post(':customer')
  async receive(
    @Param('customer') customerId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
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

    if (outcome.received > 0 && outcome.normalized === 0) {
      response.status(HttpStatus.BAD_REQUEST);

      return failure(
        `Rejected all ${outcome.received} order(s) from ${config.name}`,
        'NO_RECORD_COULD_BE_INGESTED',
        {
          received: outcome.received,
          failed: outcome.failed,
          failures: outcome.failures,
        },
      );
    }

    response.status(HttpStatus.ACCEPTED);

    return success(
      `Accepted ${outcome.normalized} of ${outcome.received} order(s) from ${config.name}`,
      outcome,
    );
  }
}

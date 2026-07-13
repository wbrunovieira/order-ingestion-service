import { Injectable, Logger } from '@nestjs/common';
import type {
  PaginationConfig,
  PullCustomerConfig,
} from '../../../customers/customer.config';
import { asArray, isRecord } from '../../normalization/raw';
import { RateLimiter, sleep } from './rate-limiter';
import { SourceHttpClient } from './source-http.client';

const MAX_RATE_LIMIT_RETRIES = 3;
const DEFAULT_RETRY_AFTER_SECONDS = 5;

/**
 * Reads one poll cycle's worth of raw records from a pull source: the whole feed if
 * it is flat, or a full page walk if it is paginated. Respects the customer's rate
 * limit, and obeys a 429 rather than failing.
 *
 * It knows nothing about any customer's data — only about how their source BEHAVES,
 * which is described in config. What comes out is raw records for the pipeline.
 */
@Injectable()
export class SourceReaderService {
  private readonly logger = new Logger(SourceReaderService.name);
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(private readonly http: SourceHttpClient) {}

  async read(config: PullCustomerConfig): Promise<unknown[]> {
    const { pagination } = config.source;

    return pagination === undefined
      ? this.readFlat(config)
      : this.walkPages(config, pagination);
  }

  /** BairroBox: one request, one array. */
  private async readFlat(config: PullCustomerConfig): Promise<unknown[]> {
    const body = await this.fetchWithBackoff(config, config.source.url);
    const records = asArray(body);

    if (records === undefined) {
      // Their contract says "an array of orders". Something else means they changed
      // it, or something is between us and them. Either way the cycle is empty and
      // loud, never a silent zero.
      this.logger.warn(
        `${config.id}: expected an array of orders, got ${typeof body} — treating the cycle as empty`,
      );
      return [];
    }

    return records;
  }

  /**
   * GlobalGoods: walk from page 1 until they stop saying hasMore.
   *
   * THE HAZARD: their `page=1` is not a read, it is a side effect — it advances the
   * window on THEIR side. So a cycle asks for page 1 exactly once and then follows
   * hasMore. Re-requesting page 1 mid-cycle (to "retry from the top") would silently
   * skip the records the cursor moved past.
   *
   * That is also why a page fetch that fails outright abandons the whole cycle rather
   * than restarting it: the next cycle re-reads an overlapping window anyway, and the
   * upsert makes the overlap free.
   */
  private async walkPages(
    config: PullCustomerConfig,
    pagination: PaginationConfig,
  ): Promise<unknown[]> {
    const records: unknown[] = [];
    let page = pagination.startPage;

    for (let walked = 0; walked < pagination.maxPagesPerCycle; walked += 1) {
      const url = this.pageUrl(config.source.url, pagination.pageParam, page);
      const body = await this.fetchWithBackoff(config, url);

      if (!isRecord(body)) {
        this.logger.warn(
          `${config.id}: page ${page} is not a JSON object — stopping the walk here`,
        );
        break;
      }

      const pageRecords = asArray(body[pagination.recordsField]);
      if (pageRecords !== undefined) {
        records.push(...pageRecords);
      }

      if (body[pagination.hasMoreField] !== true) {
        break;
      }

      page += 1;
    }

    return records;
  }

  /**
   * A 429 is the source asking us to wait, not failing. We wait what they asked for
   * and retry THE SAME page.
   *
   * That retry is safe only because their 429 is returned BEFORE the cursor advances,
   * so a rejected page-1 request did not move anything. We depend on that, and it is
   * an assumption about their implementation rather than a promise in their contract
   * — a source that advanced its cursor and then rejected us would lose records here.
   * DESIGN.md covers what a real system does instead: a client-side cursor, so
   * re-reading is never destructive.
   */
  private async fetchWithBackoff(
    config: PullCustomerConfig,
    url: string,
  ): Promise<unknown> {
    const limiter = this.limiterFor(config);

    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
      await limiter?.acquire();
      const response = await this.http.get(url, config.id);

      if (response.status !== 429) {
        return response.body;
      }

      const waitSeconds =
        response.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS;
      this.logger.warn(
        `${config.id}: rate limited, waiting ${waitSeconds}s before retrying the same page ` +
          `(attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES})`,
      );

      await sleep(waitSeconds * 1000);
    }

    // Still throttled after backing off. Give the cycle up rather than hammer them;
    // the next one re-reads the same window, and the upsert absorbs the repeat.
    this.logger.warn(
      `${config.id}: still rate limited after ${MAX_RATE_LIMIT_RETRIES} attempts — abandoning this cycle`,
    );

    return undefined;
  }

  private limiterFor(config: PullCustomerConfig): RateLimiter | undefined {
    const limit = config.source.rateLimit;
    if (limit === undefined) {
      return undefined;
    }

    let limiter = this.limiters.get(config.id);
    if (limiter === undefined) {
      limiter = new RateLimiter(limit.requestsPerMinute);
      this.limiters.set(config.id, limiter);
    }

    return limiter;
  }

  private pageUrl(baseUrl: string, pageParam: string, page: number): string {
    const url = new URL(baseUrl);
    url.searchParams.set(pageParam, String(page));

    return url.toString();
  }
}

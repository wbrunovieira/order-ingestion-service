import { Injectable } from '@nestjs/common';

/** A source being down is INFRASTRUCTURE failing, so it throws — unlike a bad record. */
export class SourceUnavailableError extends Error {
  constructor(
    readonly customerId: string,
    readonly url: string,
    readonly cause_: unknown,
  ) {
    super(
      `Source for "${customerId}" is unavailable (${url}): ${
        cause_ instanceof Error ? cause_.message : String(cause_)
      }`,
    );
    this.name = 'SourceUnavailableError';
  }
}

export interface SourceResponse {
  status: number;
  /** Absent when there is nothing to read — a 429, or an unparseable body. */
  body?: unknown;
  /** Seconds the source asked us to wait, from its Retry-After header. */
  retryAfterSeconds?: number;
}

/**
 * Abstract so the pollers can be tested against a fake source rather than a live
 * one, and so swapping fetch for an instrumented client is one provider change.
 */
export abstract class SourceHttpClient {
  abstract get(url: string, customerId: string): Promise<SourceResponse>;
}

@Injectable()
export class FetchSourceHttpClient extends SourceHttpClient {
  async get(url: string, customerId: string): Promise<SourceResponse> {
    let response: Response;

    try {
      response = await fetch(url, { headers: { Accept: 'application/json' } });
    } catch (error) {
      // The customer's API is unreachable. That is not bad data — it is an outage,
      // and it propagates so the poller can back off rather than pretend it read
      // an empty feed (which would look exactly like "they have no orders").
      throw new SourceUnavailableError(customerId, url, error);
    }

    // 429 is not an error to us: it is the source telling us to slow down, and the
    // reader knows how to obey. Anything else outside 2xx is an outage.
    if (!response.ok && response.status !== 429) {
      throw new SourceUnavailableError(
        customerId,
        url,
        new Error(`HTTP ${response.status}`),
      );
    }

    return {
      status: response.status,
      body: await this.readJson(response),
      retryAfterSeconds: this.readRetryAfter(response),
    };
  }

  private async readJson(response: Response): Promise<unknown> {
    try {
      return (await response.json()) as unknown;
    } catch {
      return undefined;
    }
  }

  private readRetryAfter(response: Response): number | undefined {
    const header = response.headers.get('Retry-After');
    if (header === null) {
      return undefined;
    }

    const seconds = Number(header);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
  }
}

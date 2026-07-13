# Solution Engineer Challenge

> **⚠️ `mock-customer-apis/` is not part of this challenge's code. Do not
> modify it.** It's a separate project (its own `package.json`, its own
> port, `4000`) simulating BairroBox's and GlobalGoods' real APIs. Start it
> first: `cd mock-customer-apis && pnpm install && pnpm start`. Then build
> and run your own service in `order-ingestion-service/` (port `3000`) in a
> second terminal, and poll the mocks over HTTP like you would a real third
> party's API. Full step-by-step in [README.md](./README.md).

## The scenario

The Company connects retailers and e-commerce platforms to a flexible
workforce who fulfill tasks like picking, packing, and delivery. To do that,
the Company ingests order data from many customers. No two customers are
alike, not in the shape of their data, and not in how or how often they
deliver it:

- **Customer A - "FreshMart" (Enterprise):** pushes orders to us in real time
  via webhook. High volume, bursty. Clean REST JSON.
- **Customer B - "BairroBox" (SMB):** no webhook capability. We poll their
  endpoint (or pick up a file export) roughly every 15 minutes. Messy, flat
  data.
- **Customer C - "GlobalGoods" (International):** exposes a paginated REST
  API we poll every 5 minutes, with a rate limit (e.g. 60 req/min), and
  different formats, currencies, and units.

Build the ingestion layer that handles both push (webhook) and pull (polling)
sources at their different rates, and turns all of them into one canonical
order so the rest of the platform never has to care where the data came from
or how it arrived.

## Deliverable 1: Working service (code)

A NestJS service that supports **both** ingestion modes:

1. A webhook endpoint that receives pushed orders (Customer A). Simulate
   deliveries with the sample payload in
   `mock-customer-apis/fixtures/customer-a.sample.json`, e.g.:
   ```bash
   curl -X POST http://localhost:3000/webhooks/freshmart \
     -H "Content-Type: application/json" \
     -d @mock-customer-apis/fixtures/customer-a.sample.json
   ```
   (The exact route is your call. Document it in
   `order-ingestion-service/README.md`.)
2. A scheduled poller that pulls orders from a source on an interval
   (Customers B and C). Point it at the mock customer APIs, a separate
   project and process from your service, running on its own port (see
   README.md for how to start both): `GET http://localhost:4000/customer-b/orders`
   and `GET http://localhost:4000/customer-c/orders?page=1`.
3. A common pipeline both modes feed into: normalize each payload into the
   canonical order model (below), validate, and persist.
4. Per-customer configuration capturing **both** the field mapping AND the
   ingestion behavior, mode (push/pull), polling interval, rate limit, so a
   new customer is config, not code.
5. Graceful handling of bad / partial / duplicate records, and idempotency so
   the same order arriving twice (common with polling) is not double-written.
6. Persistence (in-memory store or SQLite is fine, don't spend the budget on
   infra).

Optional (only if time allows): a minimal Next.js page listing normalized
orders and surfacing mapping failures with reasons; respecting Customer C's
rate limit with backoff instead of just failing; webhook signature
verification; a `docker-compose.yml` for Postgres if you'd rather use a real
database than SQLite.

### The canonical order model

```json
{
  "orderId": "string",          // system-generated, stable, idempotent
  "externalOrderId": "string",  // the customer's own id
  "customerId": "string",       // which integration this came from
  "status": "received|ready|picking|delivered|cancelled",
  "createdAt": "ISO-8601 UTC",
  "store": { "storeId": "string", "name": "string" },
  "items": [
    { "sku": "string", "name": "string", "quantity": number,
      "unitPrice": { "amount": number, "currency": "ISO-4217" } }
  ],
  "total": { "amount": number, "currency": "ISO-4217" },
  "deliveryAddress": { "line1": "string", "city": "string", "country": "ISO-3166" }
}
```

### Sample payloads

- **Customer A (webhook, clean REST JSON):** see
  `mock-customer-apis/fixtures/customer-a.sample.json`.
- **Customer B (polled, flat & messy):** items are a delimited string, prices
  are line totals (not unit price), status is in Portuguese, some fields are
  empty. See `GET http://localhost:4000/customer-b/orders`.
- **Customer C (polled, paginated, rate-limited):** currency in cents,
  quantity by weight for some products, full country names, integer status
  codes, a 12h US-style date. See
  `GET http://localhost:4000/customer-c/orders?page=1`.

Poll both a few times in a row and look closely at what comes back. The
mock APIs don't expose a `since`/cursor parameter, on purpose.

## Deliverable 2: DESIGN.md (the system design)

Because this is a take-home, the system-design assessment is a written
document AND a video explaining the system, not more code. The service you build here is intentionally small
in scope. In `DESIGN.md` at the repo root (about 1-2 pages, diagrams
encouraged), describe how you'd build this for production, at scale. Then record a video explaining your process. 

Make sure the video covers:

- **Architecture at scale**: ingesting orders from hundreds of customers
  across mixed push/pull modes and update rates from sub-second to nightly.
  How is ingestion decoupled from processing (queue/stream)?
- **Polling at scale**: scheduling hundreds of pollers, per-customer
  intervals, cursors/watermarks to avoid re-reading, respecting rate limits,
  backoff when an API is down.
- **Webhook ingestion**: absorbing bursts, fast acknowledgement, signature
  verification, replay/retries.
- **Exactly-once & idempotency**: dedup strategy across both modes; where
  you'd accept at-least-once + dedup.
- **Backpressure & isolation**: how one noisy or broken customer can't
  starve or break the others.
- **Failure handling & observability**: retries, dead-letter queues, replay;
  and how you detect a customer silently changing their contract before they
  complain.
- **Trade-offs**: what you'd defer, and what you deliberately kept simple.

## Deliverable 3: Written solutions scenario (SOLUTIONS.md)

Answer briefly in `SOLUTIONS.md` at the repo root:

> "A mid-size retailer wants to use the Company's platform and needs to be live in six weeks
> for peak season. Their 'API' turns out to be a nightly CSV on an SFTP
> server; their IT team is small and can't change their export format. Sales
> has already told them integration is easy. How do you scope and run this?
> What do you commit to, what do you push back on, and how do you phase it?"

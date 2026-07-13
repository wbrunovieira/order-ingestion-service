# ⚠️ DO NOT MODIFY, Simulated Customer APIs

**This is not your project.** It's a separate, standalone project (its own
`package.json`, its own port) that stands in for two real customers' APIs
(BairroBox and GlobalGoods), your service is meant to poll it over HTTP,
exactly like you would with a real third party's API.

- **DO NOT edit, "fix," or refactor anything in this folder.** Its quirks
  (messy fields, overlapping polls, rate limiting) are intentional.
- **START THIS BEFORE (or alongside) your own service.** Your poller has
  nothing to call until this is running:
  ```bash
  pnpm install
  cp .env.sample .env
  pnpm start
  ```
- Your actual deliverable lives in `../order-ingestion-service/`. This
  folder is never reviewed as part of your submission.

## Endpoints

Runs on its own port (`MOCKS_PORT`, default `4000`):

```bash
curl http://localhost:4000/customer-b/orders
```

`GET /customer-b/orders`: BairroBox's export endpoint. Flat, messy records;
no `since`/cursor parameter, so polling it repeatedly returns an overlapping
window of the same underlying rows (same as the real customer's file export
would).

```bash
curl "http://localhost:4000/customer-c/orders?page=1"
```

`GET /customer-c/orders?page=1`: GlobalGoods' paginated API. Paginates
within a poll cycle (`page=1`, `2`, ... until `hasMore` is `false`), and
enforces a configurable rate limit (`MOCKS_CUSTOMER_C_RATE_LIMIT_PER_MINUTE`,
default 60/min), responding `429` with a `Retry-After` header once exceeded.

Customer A (FreshMart) is push-based in real life, so there's no mock
endpoint for it. See `fixtures/customer-a.sample.json` for a sample payload
to POST at whatever webhook route you build in your own service.

See the repo root [README.md](../README.md) and
[INSTRUCTIONS.md](../INSTRUCTIONS.md) for the actual task.

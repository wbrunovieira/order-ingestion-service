# Order Ingestion Service

Ingests orders from three customers who agree on nothing — one pushes a clean
webhook, two are polled at different rates with messy, international, paginated
data — and turns all of them into **one canonical order**, so the rest of the
platform never has to care where an order came from or how it arrived.

Adding a fourth customer should be a **config entry**, not a change to the
pipeline. That constraint drove most of the design below.

---

## Quick start

The mock customer APIs are a separate process on port `4000` and must be running
first, otherwise the pollers have nothing to call.

```bash
# terminal 1 — the customers' "real" APIs (never modified by this service)
cd mock-customer-apis && pnpm install && cp .env.sample .env && pnpm start

# terminal 2 — this service, port 3000
cd order-ingestion-service && pnpm install && cp .env.sample .env && pnpm start
```

Send Customer A an order over the webhook:

```bash
curl -X POST http://localhost:3000/webhooks/freshmart \
  -H 'Content-Type: application/json' \
  -d @../mock-customer-apis/fixtures/customer-a.sample.json
```

Customers B and C need no action — their pollers start on boot (once immediately,
then on their own interval) and pull from the mocks.

```bash
curl http://localhost:3000/orders   # canonical orders
```

Their real cadence is 15 and 5 minutes, which is a long time to wait to see the
second cycle deduplicate. To watch it happen:

```bash
POLL_INTERVAL_MS=4000 pnpm start
```

The first cycle creates; by the third, the sliding windows have wrapped and every
record is a re-read:

```
bairrobox:   received=4 normalized=4 created=4 duplicated=0 failed=0
bairrobox:   received=4 normalized=3 created=0 duplicated=3 failed=1
globalgoods: received=4 normalized=4 created=0 duplicated=4 failed=0
```

`created=0, duplicated=4` and no new rows — the same orders, upserted onto the rows
they already own.

---

## Architecture

Both ingestion modes converge on one pipeline. Nothing customer-specific lives in
the pipeline itself — the differences are pushed out to the edges (a mapper) and
declared in config.

```
   Customer A (push)                  Customers B, C (pull)
   POST /webhooks/:customer           @nestjs/schedule pollers
   clean JSON, bursty                 B: ~15 min · C: 5 min, paginated, 60 req/min
           │                                       │
           └──────────────┬────────────────────────┘
                          ▼
          ┌───────────────────────────────┐
          │  normalize → validate → dedup → persist
          └───────────────────────────────┘
             mapper +      canonical    stable      upsert
             transforms    DTO          orderId     by orderId
                          (class-        (hash)
                           validator)
                          │
                          └── on failure: record reason, keep going
```

```
src/
├── ingestion/
│   ├── sources/
│   │   ├── webhook/          # push  (Customer A)
│   │   └── polling/          # pull  (Customers B, C) — scheduling, pagination, rate limit
│   ├── pipeline/             # normalize → validate → dedup → persist (shared by both modes)
│   ├── normalization/
│   │   ├── mappers/          # one mapper per customer, driven by config
│   │   └── transforms/       # reusable, named transforms the config refers to
│   ├── dedup/                # stable orderId
│   └── persistence/          # OrderRepository
├── customers/                # per-customer config: mode, interval, rate limit, mapping, status map
└── orders/                   # the canonical model + validation DTO
```

---

## The canonical order model

```jsonc
{
  "orderId":         "a3f1…",           // system-generated, stable, idempotent
  "externalOrderId": "FM-100245",       // the customer's own id
  "customerId":      "freshmart",       // which integration it came from
  "status":          "received",        // received | ready | picking | delivered | cancelled
  "createdAt":       "2026-06-20T14:32:00.000Z",  // ISO-8601, always UTC
  "store":  { "storeId": "SP-014", "name": "FreshMart Pinheiros" },
  "items": [
    { "sku": "7891000", "name": "Leite Integral 1L", "quantity": 6,
      "unitPrice": { "amount": 549, "currency": "BRL" } }   // ← minor units. see below
  ],
  "total":           { "amount": 5074, "currency": "BRL" },
  "deliveryAddress": { "line1": "Rua dos Pinheiros 123", "city": "São Paulo", "country": "BR" }
}
```

---

## The three customers

| | **A — FreshMart** | **B — BairroBox** | **C — GlobalGoods** |
|---|---|---|---|
| Mode | webhook (push) | poll ~15 min | poll 5 min |
| Shape | clean nested JSON | flat, messy | paginated, rate-limited (60/min) |
| Price given as | **unit** price | **line total** | **line total, in cents** |
| Quantity | integer | integer (`x3` prefix) | integer **or kg** (1.5) |
| Date | ISO UTC | `20/06/2026 10:40` | `06-20-2026 08:50 AM` |
| Status | `NEW` | Portuguese | integer code |
| Currency | `BRL` | **absent** | `MXN` |
| Country | `BR` | **absent** | `"Mexico"` |
| Items | array | `"Arroz 5kg\|x1\|29.90;…"` | array |

---

## Design decisions & trade-offs

### 1. "Config, not code" is a hybrid — and that's deliberate

A purely declarative config (`source path → canonical field`) cannot express
Customer B's `"Arroz 5kg|x1|29.90;Feijao 1kg|x3|0"` or Customer C's cents-per-kg.
That logic has to exist somewhere. Pretending otherwise produces a config language
that slowly becomes a bad programming language.

So the config is declarative **and refers to named transforms by name**:

```ts
{
  id: 'globalgoods',
  mode: 'pull', pollIntervalMs: 300_000, rateLimit: { reqPerMin: 60 },
  source: { url: '…/customer-c/orders', paginated: true },
  mapping: { externalOrderId: 'reference', createdAt: ['timestamp', parseUsDate12h] },
  statusMap: { 1: 'received', 2: 'picking', … },
}
```

Transforms (`parseDelimitedItems`, `centsToMinor`, `parseUsDate12h`, `parseBrDate`,
`countryNameToIso`, `unitPriceFromLineTotal`) are reusable and independently tested.

**The trade-off, stated plainly:** a *simple* new customer is pure config. A
*messy* one is config plus maybe one new transform — which is then available to
every customer after them. What you never touch is the pipeline.

### 2. Idempotency is an **upsert**, not "drop duplicates"

`orderId = sha256(customerId + ':' + externalOrderId)` — stable, so the same order
always lands on the same row.

The pollers deliberately have no `since`/cursor param, so every cycle re-reads
orders we've already seen. The naive reading is "recognise it and drop it" — but
that's a bug: an order re-read on a later poll may have a **new status**
(`received` → `picking`). Dropping it as a duplicate would silently discard the
update.

So the pipeline **upserts by `orderId`, last-write-wins on `updatedAt`**. Never a
second row, never a lost update. The same holds *within* a single batch: both mock
APIs return the same order twice in one response window, so dedup happens
in-batch too.

### 3. Money is in integer minor units

Every `amount` in the canonical model is an **integer in the currency's minor unit**
(cents). `549` is R$ 5,49.

This is not pedantry — it's the actual fixture data:

```
Customer A total, in floats:  6 × 5.49 + 2 × 8.90  =  50.739999999999995   ✗
Customer A total, in cents:   6 × 549  + 2 × 890   =  5074                 ✓

Customer B unit price, float: 32.94 / 6  =  5.489999999999999              ✗
Customer B unit price, cents: 3294  / 6  =  549                            ✓
```

Floats accumulate error the moment you sum them, and this is a payments-adjacent
domain. Customer C already sends cents; we keep integers end-to-end and convert A
and B *into* minor units on the way in. Formatting for humans is a presentation
concern, not a storage one.

### 4. Timezones are a decision, not a date format

Neither B (`20/06/2026 10:40`) nor C (`06-20-2026 08:50 AM`) carries a timezone.
Converting them to UTC is impossible without **assuming** the source zone — so we
assume explicitly, in config, rather than accidentally in code:

- **BairroBox → `America/Sao_Paulo`** (UTC−3)
- **GlobalGoods → `America/Mexico_City`** (UTC−6)
- **FreshMart** already sends UTC (`2026-06-20T14:32:00Z`) — nothing to assume.

Getting this wrong is a silent 3–6 hour error on every order. It's called out here
because an assumption you can't see is a bug waiting to happen.

### 5. Persistence is in-memory, behind a repository interface

Orders live in a `Map` behind an abstract `OrderRepository`. The brief says not to
spend the budget on infra, and for this scope a Map satisfies every requirement —
including the one that actually matters, idempotency, since the stable `orderId` is
the map key.

What earns the abstraction is that swapping it is a one-line `useClass` in
`PersistenceModule`: SQLite or Postgres implements the same four methods and nothing
upstream changes. The cost of being wrong here is bounded, so the cheap option wins.

### 6. Reject what's unactionable; flag what's merely incomplete

A delivery platform can't act on an order with no address — but it *can* act on one
with a missing store code. Treating those the same would either drop good orders or
persist unfulfillable ones. The policy:

| Data problem | Real example | What we do | Why |
|---|---|---|---|
| Empty address | B `"endereco": ""` | **reject** the order, with a reason | undeliverable — the order is not actionable |
| Quantity 0 | B `Cafe 500g\|x0\|0` · C `Limon`, amount `0` | **drop the line**, flag the order `partial` | an unorderable line — and it's the divide-by-zero in `lineTotal / qty` |
| Price 0 | B `Feijao 1kg\|x3\|0` | **keep the line** at `amount: 0`, warn | 3 units of beans really *were* ordered; the picker still picks them. A zero price is a pricing anomaly, not a reason to hide the item |
| Empty store code | B `"store_code": ""` | **keep**, warn | incomplete, not unfulfillable |
| Unmappable status | any unknown code | **reject**, with a reason | a wrong default status is worse than a visible failure |

Nothing here throws. A bad record produces a **mapping failure with a reason**
(customer, external id, field, message) and the rest of the batch continues — one
poisoned record must never take down a poll cycle.

---

## Assumptions

Where the customers' data was ambiguous, a call was made. All of them are here:

**Status maps.** The canonical model has no "in transit" state, and the customers
don't agree on what states exist:

| Customer | Their value | → canonical | Note |
|---|---|---|---|
| A | `NEW` | `received` | |
| B | `Novo` | `received` | |
| B | `Em separacao` | `picking` | |
| B | `Separado` | `ready` | |
| B | `Em entrega` | `ready` | ⚠️ **no exact match.** Out-for-delivery is past `ready` but not `delivered`. Mapped to the closest **non-terminal** state — never to `delivered`, which would falsely close the order. Flagged as a gap to raise with the customer |
| B | `Entregue` | `delivered` | |
| B | `Cancelado` | `cancelled` | |
| C | `1` `2` `3` `5` | `received` `picking` `ready` `cancelled` | |
| C | `4` | `delivered` | never appears in their data; inferred from the sequence. Any *other* integer is a failure, not a guess |

**Customer B sends no currency and no country.** Assumed **BRL** and **BR** — every
address in their data is in São Paulo and they are a Brazilian SMB. Declared in
config, so it's one line to change if that's wrong.

**Customer B sends no product code, and the canonical model requires `item.sku`.**
Every option here is imperfect: an empty string fails validation and would drop
*every* BairroBox order; a generated id would be unstable, so the same product would
look new on every poll. So the sku is a **slug of the product name, namespaced** —
`bairrobox:arroz-5kg` — so nobody mistakes it for a code they issued.

The trade-off, stated plainly: **if they rename a product, its sku changes** and
downstream it looks like a different product. That's acceptable while the sku is only
a line identifier within an order, and the real fix isn't cleverer code — it's asking
BairroBox for a product code. That's the kind of gap worth raising with a customer
rather than silently papering over.

**Customer B's address is one string** (`"Rua Augusta 500, Sao Paulo"`). Split on the
last comma: everything before is `line1`, the last part is `city`.

**Customer C's pagination advances on the server.** Requesting `page=1` isn't a read,
it's a side effect: it moves the window on *their* side. So a cycle walks
`page=1 → hasMore → page=2` exactly once and never re-requests page 1 mid-cycle,
which would silently skip whatever the cursor moved past.

Their `429` happens to be returned *before* that advance, which is the only reason
retrying a throttled page is safe. **We depend on that, and it's an assumption about
their implementation, not a promise in their contract** — a source that advanced its
cursor and *then* rejected us would lose records here. A page fetch that fails outright
therefore abandons the whole cycle rather than restarting it; the next cycle re-reads
an overlapping window anyway, and the upsert makes the overlap free. The real fix is a
client-side cursor, which is in [`DESIGN.md`](../DESIGN.md).

---

## How to onboard a new customer

The pipeline does not change. In the common case, neither does any other code.

1. **Add a config entry** in `src/customers/` — id, mode (`push` | `pull`), poll
   interval, rate limit, source URL, field mapping, status map, timezone, default
   currency.
2. **If their data is clean**, you're done. The mapping is declarative and the
   shared pipeline picks the customer up on boot.
3. **If their data is messy**, check whether an existing transform already covers
   it (`parseDelimitedItems`, `centsToMinor`, `parseUsDate12h`, …). Reuse it if so.
4. **Only if it's genuinely new** — a format no existing transform handles — add one
   transform, name it, test it, and reference it from the config. It's now available
   to every customer after them.

A nightly CSV dropped on SFTP, for instance, is a new *source* (pull, but from a
file) plus a mapper — not a new pipeline. That's the point.

---

## API

| Route | Purpose |
|---|---|
| `POST /webhooks/:customer` | push ingestion (Customer A). Accepts one order or a batch. Answers `202` — the order is ours now; an unknown customer is a `404` |
| `GET /orders` | canonical orders |
| `GET /stats` | per-customer counters + recent mapping failures with reasons — *not built yet, see Build status* |
| `GET /health/liveness`, `GET /health/readiness` | health checks (from the scaffold) |

---

## Tests

```bash
pnpm test               # unit — normalizers, transforms, traps, idempotency
pnpm test:integration   # black-box HTTP against the app
pnpm lint
```

Tests are focused rather than exhaustive: they cover the specific traps this data
plants (divide-by-zero, empty address, float money, three date formats, in-batch
duplicates, PT/integer statuses) and the two behaviours that matter most — **the
same order polled twice produces one row, not two**, and **one bad record doesn't
kill the good ones in its batch**.

---

## Build status

- [x] Scaffold, canonical model plan (this README)
- [x] Canonical order model + validation DTO
- [x] Customer config registry + status maps
- [x] Webhook ingestion (A) + shared pipeline
- [x] Persistence + idempotent upsert by stable `orderId`
- [x] Customer B poller + messy-flat normalizer
- [x] Customer C poller + international normalizer + pagination + rate-limit backoff
- [ ] Graceful failures with reasons + `/stats`
- [ ] Integration tests (webhook → orders)

> Production concerns deliberately **not** built here — queues, DLQs, cursors,
> per-customer isolation, contract-drift detection — are in
> [`DESIGN.md`](../DESIGN.md). The brief asks for that as a document, not as more
> code, and the service is kept intentionally small on purpose.

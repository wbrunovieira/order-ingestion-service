# Senior Solution Engineer Challenge

[![CI](https://github.com/wbrunovieira/order-ingestion-service/actions/workflows/ci.yml/badge.svg)](https://github.com/wbrunovieira/order-ingestion-service/actions/workflows/ci.yml)

> **The deliverables:** the service in [`order-ingestion-service/`](./order-ingestion-service)
> (start with its [README](./order-ingestion-service/README.md) — design decisions,
> assumptions, how to onboard a new customer) · [`DESIGN.md`](./DESIGN.md) — ingestion at
> scale · [`SOLUTIONS.md`](./SOLUTIONS.md) — the nightly-CSV scenario.

This repo has **two independent projects** in it, each with its own
`package.json`, its own dependencies, and its own port. Don't confuse one
for the other:

| | `order-ingestion-service/` | `mock-customer-apis/` |
|---|---|---|
| What it is | **Your deliverable.** The NestJS service you build. | A standalone stand-in for BairroBox's and GlobalGoods' real APIs. |
| Do you edit it? | Yes, this is the whole challenge. | **No.** Never. |
| Port | `3000` (`PORT` env var) | `4000` (`MOCKS_PORT` env var) |
| Started with | `pnpm start` (from inside the folder) | `pnpm start` (from inside the folder) |
| Details | [order-ingestion-service/README.md](./order-ingestion-service/README.md) | [mock-customer-apis/README.md](./mock-customer-apis/README.md) |

> **⚠️ IMPORTANT - READ BEFORE YOU START**
> `mock-customer-apis/` IS NOT PART OF YOUR DELIVERABLE. It simulates two
> real customers' APIs, runs as its own process on its own port, and
> **MUST BE STARTED BEFORE (or alongside) your own service** so your poller
> has something to call.
> **DO NOT MODIFY ANYTHING INSIDE `mock-customer-apis/`.** If something looks
> broken when you poll it, the bug is in your own code, not in the mock.
> Treat it exactly like you'd treat a real third party's API you have no
> control over. We only review `order-ingestion-service/`.

Read **[INSTRUCTIONS.md](./INSTRUCTIONS.md)** for the actual task, the
canonical order model, and the deliverables. For what's already in
`order-ingestion-service/` and what's deliberately left for you to build,
see [order-ingestion-service/README.md](./order-ingestion-service/README.md).

## Getting started

Both processes need to be running, the mock customer APIs first, so your
service has something to poll from the moment it boots. Each project's own
README has its full details (env vars, routes, test commands); this is just
the sequence that ties them together.

### Prerequisites

- Node.js 20+
- pnpm

### 1. Install both projects

```bash
cd mock-customer-apis && pnpm install && cp .env.sample .env && cd ..
cd order-ingestion-service && pnpm install && cp .env.sample .env && cd ..
```

### 2. Terminal 1, start the mock customer APIs first

```bash
cd mock-customer-apis
pnpm start
```

### 3. Terminal 2, start your service

```bash
cd order-ingestion-service
pnpm start
```

### 4. Verify both are up

```bash
curl http://localhost:4000/customer-b/orders   # mock customer APIs
curl http://localhost:3000/api/v1              # your service
```

Your poller (once you build it) calls `http://localhost:4000/...` like it
would call any external API.

## Project structure

```
README.md                       # this file
INSTRUCTIONS.md                 # the actual task

order-ingestion-service/        # YOUR service, the only thing we review
├── README.md
├── package.json
├── src/
│   ├── main.ts
│   ├── app.module.ts
│   ├── controllers/
│   │   ├── app.controller.ts
│   │   └── health.controller.ts
│   ├── services/
│   │   └── app.service.ts
│   ├── config/
│   │   └── app.setup.ts         # shared app config (validation, etc.)
│   └── utils/
│       └── http-response.ts     # { message, data } / { message, error, detail } envelope helpers
└── test/
    ├── unit/                    # mirrors src/
    │   └── controllers/
    └── integration/             # black-box HTTP tests against your app
        └── setup/

mock-customer-apis/             # NOT your service, standalone, do not edit
├── README.md
├── package.json
├── main.js
├── customer-b.js
├── customer-c.js
└── fixtures/
```

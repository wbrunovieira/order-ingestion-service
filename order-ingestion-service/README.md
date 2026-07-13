# Order Ingestion Service

This is your deliverable for the Solution Engineer take-home. For the full
brief, the canonical order model, and the deliverables, see the repo root
[README.md](../README.md) and [INSTRUCTIONS.md](../INSTRUCTIONS.md).

## What's here

A bare NestJS app:

- `GET /api/v1` - root route, returns `{ message, data }`.
- `GET /health/liveness`, `GET /health/readiness` - health checks.

Nothing about the ingestion pipeline, canonical model, persistence, or
per-customer configuration is implemented, that's the task. Whatever
routes/prefix/response shape you use for your own endpoints (the webhook
receiver, etc.) is entirely your call, the two routes above are simply
what this starter happens to use, not a requirement.

No database dependency is preinstalled. `in-memory` or SQLite are both fine
per the brief, add whatever you need (e.g. `pnpm add better-sqlite3
typeorm @nestjs/typeorm`) if you go that route.

## Setup

```bash
pnpm install
cp .env.sample .env
```

## Run

```bash
pnpm start   # http://localhost:3000, restarts on file changes
```

This service is meant to poll/receive from the mock customer APIs. Make
sure `../mock-customer-apis/` is running too (see the repo root
[README.md](../README.md) for the full two-terminal setup and why order
matters).

## Test

```bash
pnpm test               # unit, test/unit, mirrors src/
pnpm test:coverage      # unit tests with coverage
pnpm test:integration   # black-box HTTP against this app, test/integration
```

## Project structure

```
src/
├── main.ts
├── app.module.ts
├── controllers/
│   ├── app.controller.ts
│   └── health.controller.ts
├── services/
│   └── app.service.ts
├── config/
│   └── app.setup.ts          # shared app config (validation, etc.)
└── utils/
    └── http-response.ts      # { message, data } / { message, error, detail } envelope helpers

test/
├── unit/                     # mirrors src/
│   └── controllers/
└── integration/              # black-box HTTP tests against this app
    └── setup/
```

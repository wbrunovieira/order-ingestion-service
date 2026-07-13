# SOLUTIONS — the six-week retailer with a nightly CSV

> *A mid-size retailer needs to be live in six weeks for peak. Their "API" is a nightly
> CSV on SFTP, their IT team can't change the export, and Sales has already told them
> integration is easy. How do you scope and run it — what do you commit to, what do you
> push back on, how do you phase it?*

A nightly CSV is **batch**. No amount of engineering turns it into real-time, because the
data doesn't exist on their side until 2 a.m. So the job is to get them live for peak on
what their format can actually support — without promising what it can't, and without
torching the deal Sales has already made. Those are three conversations (customer, Sales,
engineering), and the SE owns all three.

The good news, and I'd say it in the kickoff: **this is not a special case for us.** An
SFTP-CSV drop is another *pull* source plus a mapper. Same pipeline, same canonical
order, same idempotency — which is exactly why six weeks is realistic.

## What I commit to

**Phase 1 — live for peak (weeks 1–3, buffer to 4).** A CSV-over-SFTP connector into the
existing ingestion pipeline. Concretely, and reusing what's already built:

- **A new source, not a new pipeline.** Config entry (mode: pull, schedule, credentials,
  field mapping, status map) plus one mapper. The pipeline doesn't change — that's the
  whole point of config-not-code.
- **Idempotent by a stable row key** (`hash(customerId + ':' + theirOrderId)`, same as
  every other customer). Re-ingesting the same file is free, which matters more here than
  anywhere else: files get resent, jobs get rerun, and someone *will* drop yesterday's
  file in the folder by mistake.
- **Malformed rows don't kill the file.** Same reject-vs-flag policy: a row with no
  delivery address is rejected with a reason; a row missing a store code is flagged and
  ingested. On a 40,000-row file, failing the batch on row 12 is not an option.
- **File-arrival monitoring from day one.** A late or missing file is a *silent* failure —
  it looks exactly like "they had no orders." This is the freshness check from DESIGN §6,
  and on a nightly feed it's the single most valuable alert in the whole integration.

**Phase 2 — after peak.** Incremental deltas, a reconciliation report (their row count vs
our ingested count, daily), richer error feedback so their IT can self-serve fixes, and a
path to a real API *if and when* their team has capacity. Not before.

## What I push back on

Diplomatically, early, and in writing — pushing back after peak is just an excuse.

- **Real-time.** Their orders will be up to 24 hours old, by construction. I reset that
  with Sales *first*, then with the customer, framed as what they gain: "you're live for
  peak on the integration you actually have, and we'll shorten the loop after." A promise
  quietly broken in December costs far more than an expectation reset in October.
- **Changing their export format.** Their IT team is small and it's peak — asking them to
  change the thing that works is how you break the one system nobody can afford to break.
  We adapt to their format. That's our job, and it's cheaper than theirs.
- **Undocumented edge cases.** The single biggest risk. Day 1, non-negotiable: a **real
  sample file** (not a spec — a file), plus volume, delivery schedule, encoding, and what
  each column means. Everything else is estimated from that.

## How I phase and de-risk peak

- **Sample file on day one** unblocks everything; without it, week 1 is guesswork and week
  5 is a surprise. If it doesn't arrive, that's the first escalation, not a silent slip.
- **Alert on the file being late or missing**, and on volume anomaly (they average 8,000
  rows and today sent 40). Silence is the failure mode of batch integrations.
- **Backfill and replay.** If a file was broken or skipped, we re-ingest it — safely,
  because dedup by stable key means a replayed row lands on the row it already owns
  (DESIGN §4).
- **Capacity for the spike.** Nightly means the entire day's volume in one burst — the
  2 a.m. spike from DESIGN §1. It's sized and load-tested before peak, not during it.
- **A human fallback.** If a file arrives corrupt at 2 a.m. during peak, someone is
  *paged*, and we have a documented manual re-drop. Never a silent drop.

## Why this is a three-week connector and not a rebuild

Because the ingestion layer is config-driven, a new source like SFTP-CSV is **a config
entry and a mapper** — not an architectural change. And because the platform already
watches per-customer failure rate, volume and freshness, a nightly file integration is
*observable* rather than hopeful. That combination is what makes a six-week commitment an
engineering estimate instead of a sales wish.

The line I'd give the customer: **"You will be live for peak, on a reliable nightly batch,
and you'll know within minutes if a file doesn't show up. What you won't have on day one
is real-time — and here's the plan for that, after peak."**

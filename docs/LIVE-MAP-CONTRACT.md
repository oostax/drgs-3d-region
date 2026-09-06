---
ontology: true
type: decision
domain: sber-atlas
status: active
summary: Contracts for the Tatarstan live source ledger, event API, map updates, and private Sber relevance overlay.
tags: [live-map, signals, sources, sqlite, api]
related: [../PRODUCT, ../DESIGN, data-sources]
---

# Контракт живой карты

## Границы данных

`data/live/atlas-live.sqlite` contains public-source documents, normalized events, evidence, jobs, and revision history. It never contains client, deal, KM, payroll, or meeting data. `private-data/atlas.sqlite` remains the only store for bank context. Public text may be sent to the configured AnyModel endpoint only when the source row has `ai_allowed=1`; private rows never enter that request.

The tracked `data/live/sources.json` is a candidate registry. Technical availability, permission to fetch, permission to analyze, and permission to display are independent fields. Coverage inherited from a district is a registry relationship, not proof of a recent publication for every settlement.

## Event identity and time

Documents and events are separate. A canonical event may cite many documents; document edits are versioned. Meaningless edits and republication do not advance `last_meaningful_at`. Missing pages and deleted Telegram messages create evidence/history records and never resolve an event automatically.

Existing `Signal.id` values are retained as `legacy_id` and `event_aliases`; editor-reviewed geometry and lifecycle fields take precedence over automated enrichment. Location precision is independent of source credibility. An LLM may extract an address candidate but may never create coordinates.

## HTTP surface

- `GET /api/signals?mode&region&territory&days=30|45|60&bbox&ongoing&limit&offset` returns `LiveSignalsResponse`.
- `GET /api/signals/changes` accepts the same scope plus `after`; it returns upserts, removed IDs, a new cursor, and `reset=true` if the cursor can no longer be continued.
- `GET /api/signals/:id` returns a signal with evidence and state history, resolving legacy aliases.
- `GET /api/sources` returns registry, coverage, qualification summary, and worker status; `/api/sources/export` returns UTF-8 CSV.
- `GET /api/work/signal-relevance?signalId&snapshot` is local-only and reads the private database. No public response contains private identifiers.

The client reconciles a full snapshot when scope changes or after a reset. The initial snapshot, backfill, and reconnect never produce a new-event notification. A delta can contain upserts and removals; removals mean the item left the selected view, not that the event ceased to exist.

## Runtime

The worker has one process lock, a heartbeat, resumable checkpoints, bounded concurrency, conditional HTTP requests, and per-host scheduling. On wake or reconnect it handles new material before backfill. UI copy reports actual heartbeat and lag; while the Mac sleeps the product does not claim continuous collection.

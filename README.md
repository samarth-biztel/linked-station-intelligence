# Linked Station Intelligence Platform

Implementation of the linked-operation design plan, built in phases. Phase 1 contains the canonical PostgreSQL tables and an explicit loader for the synthetic workbook. The loader reads only the two station sheets; the workbook's prewritten Linked View conclusions are excluded.

## Phase 1

Requirements: Node.js 22 or newer, npm, and PostgreSQL. The supplied Compose file runs PostgreSQL 16. A local PostgreSQL 17 instance can also run this phase's schema.

```powershell
docker compose up -d db
npm install
$env:DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/linked_stations'
npm run db:migrate
npm run load:fixture
npm run verify:phase1
```

If Docker is unavailable, start a local PostgreSQL database and set `DATABASE_URL` to its connection string before running the npm commands.

Set `FIXTURE_PATH` if the workbook is outside the repository root. The fixture's timestamps have no zone field; the loader interprets them as `Asia/Kolkata`, per the finalized design plan. It checks headers, result limits, times, and durations before writing anything. A single database transaction commits the load. Re-running the same workbook is idempotent.

The phase 1 gate expects 3,090 tightening cycles, 3,000 leak cycles, 3,000 engines, 90 successful retries, 720 leak failures, and 2,280 leak passes. `verify:phase1` checks those counts in PostgreSQL.

Later phases will add automatic mapping, context and link validation, staging and quarantine, generated linked views, findings, and the API and frontend.

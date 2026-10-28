# ATM Cash Replenishment & Downtime Monitoring

Operations ledger for a cash-management vendor that services 450 ATMs. It forecasts weekday cash need, plans replenishment runs onto vans and custodians, records cassette loads, reconciles counted cash, and tracks downtime and fault tickets.

The deployment runs on sample data for demonstration. Every page except sign-in and the health check requires a signed-in user.

## Local run

Requirements: Node.js 18 or newer, and PostgreSQL 14 or newer.

```bash
createdb atm_cash
psql -d atm_cash -c "CREATE USER atm_ops WITH PASSWORD 'atm_ops'; GRANT ALL PRIVILEGES ON DATABASE atm_cash TO atm_ops;"
cp .env.example .env
# edit DATABASE_URL if your user, password, or database name differ
npm install
npm start
```

The process listens on `PORT` (default **43123**). On first start against an empty database it applies `db/schema.sql` and loads the sample fleet. Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

`GET /health` returns JSON: `{ "status": "ok", "db": "up", "atms": 450, ... }`.

Signed-in accounts are seeded on startup: `superadmin` uses `ADMIN_PASSWORD`; `regional.manager`, `branch.manager`, `clerk`, `custodian`, and `engineer` use `DEMO_PASSWORD`. Set `SESSION_SECRET` as well. On Render, set those three as secret environment variables (`sync: false` in `render.yaml`).

Tests use the same `DATABASE_URL` and roll back their own rows:

```bash
npm test
```

To load the sample again, drop and recreate the database, then start the app. The seed runs only when `app_meta` has no `seeded` row.

## Deploy

The app is a single Node process plus any Postgres `DATABASE_URL` (Render, Neon, or another host). SSL is turned on automatically when the host is not localhost.

### Render

`render.yaml` is a blueprint for a web service and a Postgres instance. From the Render dashboard, create a Blueprint and point it at this repository. The service builds with `npm ci`, starts with `npm start`, and uses `/health`.

Render’s free web and free Postgres plans are not offered on every account. If the blueprint rejects `plan: free`, create the cheapest Postgres (or a [Neon](https://neon.tech) database) and a web service with:

| Setting | Value |
| --- | --- |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check path | `/health` |
| Environment | `DATABASE_URL` = the Postgres connection string, `NODE_ENV` = `production` |

The first boot creates the schema and the 450-ATM sample. On a small instance that can take a minute; the Docker health check waits 90 seconds before its first probe.

### Neon or any other Postgres

Create a database, copy its connection string into `DATABASE_URL`, and run `npm start` (or the Docker image). No code changes are required.

### Docker

```bash
docker build -t atm-cash-ops .
docker run --env-file .env -p 43123:43123 atm-cash-ops
```

## Architecture

```
browser  →  Express (EJS pages)  →  PostgreSQL
                │
                ├─ db/schema.sql     functions, procedure, trigger, views
                ├─ db/seed.js        450 ATMs and about nine weeks of history
                ├─ src/routes        pages and forms
                └─ oracle/           PL/SQL reference, not executed
```

Server-rendered pages, one shared stylesheet, and Chart.js on the uptime dashboard. Money math for cassette rows lives in `public/js/money.js` and is used by both the browser and the server so the live total and the saved total are the same calculation.

Session time zone is `Asia/Kolkata`. Amounts are Indian rupees. Denominations are 100, 200, 500, and 2000.

## Pages

| Route | What it is |
| --- | --- |
| `/` | Uptime dashboard: fleet uptime, cash alerts, charts, and the live-feed control |
| `/health` | JSON health check |
| `/atms`, `/atms/:id` | ATM list and detail, including a 7-day forecast |
| `/forecast` | Pick an ATM and a date; shows `forecast_cash` and the four source days |
| `/runs`, `/runs/new`, `/runs/:id` | Replenishment list, planner, and master/detail cassette form |
| `/reconciliations`, `/reconciliations/new` | Reconciliation list and entry |
| `/tickets` | Fault tickets, assign an engineer, close |
| `/reports/downtime-atms` | ATMs with downtime above 5% this month |
| `/reports/van-cashouts` | Cash vans ranked by cash-out tickets on their route |
| `/reports/withdrawal-matrix` | Withdrawals by ATM and weekday |
| `/reports/downtime-by-location` | Downtime grouped by location |
| `/switch`, `/switch/:id` | Switch-file upload, staging result, and error rows |
| `/imports`, `/imports/:id` | Every ingested batch and its per-row rejection reasons |
| `/operations/ej-archive` | What `scripts/archive_ej_logs.sh` does, and the script itself |

## Tables

| Table | Role |
| --- | --- |
| `locations` | City or metro the branches and vans belong to |
| `branches` | Branch inside a location. Holds a fictional `DEMO`-style IFSC |
| `atms` | Machine, site, status, cassette capacity, and cash still inside |
| `cash_vans` | Van based at a location. One Ahmedabad van is in maintenance |
| `custodians` | Crew assigned to a van |
| `engineers` | Field engineers who can be assigned to tickets |
| `replenishment_runs` | One trip: van, custodian, location, date, status |
| `cassette_loads` | Detail rows of a run. Amount must equal denomination × note count |
| `daily_withdrawals` | One total per ATM per day, from the seed or a switch file |
| `reconciliations` | Expected versus counted cash. `difference` is a generated column |
| `fault_tickets` | Service tickets. `source = trigger` means the reconciliation trigger created it |
| `downtime_log` | Outage windows. An open window has no end time |
| `replenishment_plan_log` | Each call of the planning procedure |
| `switch_import_batches`, `switch_import_rows` | Staging area for the inbound switch file |
| `inbound_files` | SHA-256 of each scheduled file so the same file is not loaded twice |
| `replenishment_requests` | Open cash alerts raised when a loaded level is under the threshold |
| `atm_link_status` | When the feed last saw an ATM go offline |
| `app_meta` | Records that the seeded fleet has been loaded |

## How the highlights map to code

| Highlight | Where it lives | Where you use it |
| --- | --- | --- |
| `forecast_cash(atm_id, target_date)` | `db/schema.sql`. Average of the same weekday over the previous 28 days (four points when history is complete). `forecast_cash_points` returns those rows | `/forecast` and the next-seven-days block on an ATM |
| `plan_replenishment_routes` | `db/schema.sql`. Picks ATMs whose forecast exceeds `current_cash`, groups them by location, assigns a van and custodian (15 stops per run), writes runs and cassette loads | **Plan routes** on `/runs` |
| Reconciliation trigger | `trg_reconciliation_variance` in `db/schema.sql`, fired `AFTER INSERT` | `/reconciliations/new`. A non-zero difference redirects to the new ticket. A match does not create one |
| Downtime above 5% | View `v_atm_downtime_above_5pct` | `/reports/downtime-atms` |
| Vans with the most cash-outs | View `v_van_cashout_incidents` | `/reports/van-cashouts` |
| Master/detail and total loaded | `views/run-form.ejs`, `public/js/run-form.js`, `public/js/money.js`, `src/services/runs.js` | `/runs/new` and `/runs/:id`. Add, edit, and remove cassette rows. **Total loaded** updates as you type |
| Withdrawal matrix | `src/routes/reports.js` | `/reports/withdrawal-matrix` |
| Downtime by location | `src/routes/reports.js` | `/reports/downtime-by-location` |
| Switch file interface | `src/lib/switchFile.js` parses CSV and 42-character fixed width. `src/services/switchImport.js` stages rows, posts valid ones into `daily_withdrawals`, and keeps error rows | `/switch`. Samples are linked on that page |
| EJ archive script | `scripts/archive_ej_logs.sh` | `/operations/ej-archive` explains it. Run it on the host; the web process does not shell out |
| Uptime dashboard | `src/routes/dashboard.js`, `views/dashboard.ejs` | `/` |
| Oracle reference | `oracle/01_ddl.sql`, `oracle/02_cash_ops.sql`, `oracle/03_trigger.sql` | Not executed. Same forecast, planner, and trigger in PL/SQL |

## Sample data

Ten locations (Mumbai, Delhi NCR, Bengaluru, Chennai, Hyderabad, Pune, Kolkata, Ahmedabad, Jaipur, Kochi), 50 branches, **450 ATMs**, 20 vans, 30 custodians, and 20 engineers. Each ATM has 63 days of withdrawals, with higher amounts on Friday, Saturday, and Sunday. Some machines are cash-out or out of service. About twenty have month-to-date downtime above 5%. Historical replenishment runs cover eight weeks. Six seeded reconciliations do not match and the trigger has already raised those tickets. A few more tickets are cassette errors, hardware, and cash-outs distributed unevenly across vans.

Branch IFSC values are fictional (`D` + city code) and are not real routing codes.

## Switch file

CSV header:

```text
atm_code,txn_date,amount,txn_count
```

Fixed width, 42 characters, no header:

| Columns | Content |
| --- | --- |
| 1–16 | ATM code, space padded |
| 17–24 | Date `YYYYMMDD` |
| 25–36 | Amount in whole rupees, zero padded |
| 37–42 | Transaction count, zero padded |

Valid rows are inserted into `switch_import_rows` as `staged`, copied into `daily_withdrawals`, then marked `loaded`. Invalid rows stay `error`. By default an ATM/date that already has a total is rejected. Tick **replace** to overwrite it.

Optional CSV columns, after the four required ones: `cash_level`, `fault_code`, `online`. A cash level replaces `current_cash`. A level below `CASH_ALERT_PCT` (default 20) of capacity opens one replenishment alert for that ATM. A fault code opens one open ticket per ATM and code. `online=no` starts downtime after `OFFLINE_MINUTES` (default 2) and a later `online=yes` closes it.

The web process polls `data/inbound/` every `SWITCH_POLL_MS` milliseconds (default 300000). A file is loaded once, keyed by SHA-256. Accepted files move to `data/processed/`; files with nothing loaded move to `data/rejected/`. Set `SWITCH_POLL_MS=0` to turn the poller off. Render’s free disk is ephemeral, so those folders do not survive a restart; use the dashboard live feed there. The feed stays off until someone starts it, and it stops after `SIMULATOR_MAX_MS` (default 15 minutes).

## EJ archive script

```bash
chmod +x scripts/archive_ej_logs.sh
scripts/archive_ej_logs.sh --source ./ej_logs --archive ./ej_archive --retain-days 90
```

It gzip-compresses `.log`, `.ej`, and `.jrn` files, stores them under `ej_archive/YYYY-MM-DD/`, deletes day folders older than the retention count, and appends `archive.log`. The date comes from `YYYY-MM-DD` or `YYYYMMDD` in the filename, otherwise the file’s modification time. GNU `date` is required (`date -d`).

## Tests

| Test | What it checks |
| --- | --- |
| `test/forecast.test.js` | `forecast_cash` is the four-week same-weekday average and ignores other weekdays and older Fridays |
| `test/reconciliation-trigger.test.js` | A mismatch inserts one `cash_variance` ticket with `source = trigger`; a match inserts none |
| `test/downtime.test.js` | The above-5% view includes an 8% outage and excludes a 2% outage |
| `test/total-loaded.test.js` | Denomination × note count, including the form normalizer |
| `test/switch-import.test.js` | CSV and fixed-width validation, staging, load, and error rows |
| `test/plan-routes.test.js` | The procedure loads the short ATM, skips the healthy one, and does not duplicate a second call |
| `test/archive-ej.test.js` | The shell script archives a current journal and purges a 2020 journal |

## Limitations

- No sign-in. Anyone who can open the site can edit the sample ledger.
- The forecast is a same-weekday average. It does not model holidays, paydays, or a trend.
- Planning compares that one-day forecast with cash still in the machine, then tops the machine up toward four days of that forecast, capped by cassette capacity.
- The switch file is a daily total per ATM, not an ISO 8583 message log.
- The EJ script is a host utility. The site only documents it.
- Oracle scripts are a reference port and are not executed or unit-tested here.
- Re-seeding means dropping the database. The app will not wipe an existing ledger on startup.
- Render free Postgres may be unavailable on new accounts; Neon or any other `DATABASE_URL` works the same way.

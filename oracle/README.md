# Oracle PL/SQL reference

These scripts are the Oracle equivalent of the live PostgreSQL objects in `db/schema.sql`. The Node application does not connect to Oracle and does not run this folder.

| File | Contents |
| --- | --- |
| `01_ddl.sql` | Tables, keys, checks, and the ticket-number sequence |
| `02_cash_ops.sql` | Package `cash_ops` with `forecast_cash` and `plan_replenishment_routes` |
| `03_trigger.sql` | `trg_reconciliation_variance`, plus the downtime and van cash-out views |

`forecast_cash` averages the same weekday over the previous 28 days. `plan_replenishment_routes` creates replenishment runs for ATMs whose forecast exceeds remaining cash, grouped by location onto a van and custodian. The reconciliation trigger inserts a `fault_tickets` row when the counted amount differs from the expected amount.

Apply them in filename order on an Oracle 12c or later database. `CONTINUE` inside the package body requires Oracle 11g or later; identity columns require 12c.

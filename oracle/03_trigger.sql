-- Oracle reference trigger.
-- AFTER INSERT on reconciliations raises a fault ticket when counted cash
-- does not match the expected amount. A zero difference does nothing.

CREATE OR REPLACE TRIGGER trg_reconciliation_variance
AFTER INSERT ON reconciliations
FOR EACH ROW
DECLARE
  v_code     atms.atm_code%TYPE;
  v_diff     NUMBER(14,2);
  v_priority fault_tickets.priority%TYPE;
BEGIN
  v_diff := :NEW.counted_amount - :NEW.expected_amount;
  IF v_diff = 0 THEN
    RETURN;
  END IF;

  SELECT atm_code INTO v_code FROM atms WHERE atm_id = :NEW.atm_id;

  IF ABS(v_diff) >= 100000 THEN
    v_priority := 'critical';
  ELSIF ABS(v_diff) >= 10000 THEN
    v_priority := 'high';
  ELSE
    v_priority := 'medium';
  END IF;

  INSERT INTO fault_tickets (
    atm_id, reconciliation_id, title, description, category, priority, status, source
  ) VALUES (
    :NEW.atm_id,
    :NEW.reconciliation_id,
    'Cash variance — ' || v_code,
    'Raised automatically because counted cash did not match the expected balance. Expected '
      || TO_CHAR(:NEW.expected_amount) || ', counted ' || TO_CHAR(:NEW.counted_amount)
      || ', difference ' || TO_CHAR(v_diff) || '.',
    'cash_variance',
    v_priority,
    'open',
    'trigger'
  );
END;
/

-- ATMs above 5% downtime this month, and cash-out tickets on each van's route.
-- These are the Oracle equivalents of v_atm_downtime_above_5pct and v_van_cashout_incidents.

CREATE OR REPLACE VIEW v_atm_downtime_above_5pct AS
WITH bounds AS (
  SELECT TRUNC(SYSTIMESTAMP, 'MM') AS month_start,
         SYSTIMESTAMP AS period_end
  FROM dual
),
per_atm AS (
  SELECT a.atm_id,
         SUM(
           CASE
             WHEN d.downtime_id IS NULL THEN 0
             ELSE GREATEST(
               (CAST(LEAST(NVL(d.ended_at, b.period_end), b.period_end) AS DATE)
                - CAST(GREATEST(d.started_at, b.month_start) AS DATE)) * 24 * 60,
               0
             )
           END
         ) AS downtime_minutes,
         (CAST(b.period_end AS DATE) - CAST(b.month_start AS DATE)) * 24 * 60 AS elapsed_minutes
    FROM atms a
    CROSS JOIN bounds b
    LEFT JOIN downtime_log d
      ON d.atm_id = a.atm_id
     AND d.started_at < b.period_end
     AND NVL(d.ended_at, b.period_end) > b.month_start
   GROUP BY a.atm_id, b.month_start, b.period_end
)
SELECT a.atm_id,
       a.atm_code,
       a.site_name,
       a.status,
       loc.location_name,
       loc.city,
       ROUND(p.downtime_minutes, 1) AS downtime_minutes,
       ROUND(p.downtime_minutes / NULLIF(p.elapsed_minutes, 0) * 100, 2) AS downtime_pct
  FROM per_atm p
  JOIN atms a ON a.atm_id = p.atm_id
  JOIN branches br ON br.branch_id = a.branch_id
  JOIN locations loc ON loc.location_id = br.location_id
 WHERE p.downtime_minutes / NULLIF(p.elapsed_minutes, 0) * 100 > 5;

CREATE OR REPLACE VIEW v_van_cashout_incidents AS
SELECT cv.van_id,
       cv.van_code,
       cv.registration_no,
       loc.location_name,
       (
         SELECT COUNT(*)
           FROM fault_tickets ft
          WHERE ft.category = 'cash_out'
            AND cv.van_id = (
              SELECT rr2.van_id
                FROM replenishment_runs rr2
                JOIN cassette_loads cl2 ON cl2.run_id = rr2.run_id
               WHERE cl2.atm_id = ft.atm_id
                 AND rr2.status <> 'cancelled'
                 AND rr2.planned_date <= TRUNC(ft.opened_at)
               ORDER BY rr2.planned_date DESC, rr2.run_id DESC
               FETCH FIRST 1 ROW ONLY
            )
       ) AS cashout_incidents,
       (
         SELECT COUNT(DISTINCT cl.atm_id)
           FROM replenishment_runs rr
           JOIN cassette_loads cl ON cl.run_id = rr.run_id
          WHERE rr.van_id = cv.van_id
            AND rr.status <> 'cancelled'
       ) AS atms_on_route
  FROM cash_vans cv
  JOIN locations loc ON loc.location_id = cv.location_id;

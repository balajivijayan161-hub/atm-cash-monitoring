-- Oracle reference package: forecast_cash and plan_replenishment_routes.
-- Mirrors the PostgreSQL function and procedure in db/schema.sql.
-- Same-weekday history uses an English day abbreviation so it does not depend on NLS_DATE_LANGUAGE.

CREATE OR REPLACE PACKAGE cash_ops AS
  FUNCTION forecast_cash(
    p_atm_id      IN atms.atm_id%TYPE,
    p_target_date IN DATE
  ) RETURN NUMBER;

  PROCEDURE plan_replenishment_routes(
    p_target_date   IN DATE,
    p_location_id   IN locations.location_id%TYPE,
    p_runs_created  IN OUT NUMBER,
    p_atms_assigned IN OUT NUMBER
  );
END cash_ops;
/

CREATE OR REPLACE PACKAGE BODY cash_ops AS
  FUNCTION forecast_cash(
    p_atm_id      IN atms.atm_id%TYPE,
    p_target_date IN DATE
  ) RETURN NUMBER IS
    v_forecast NUMBER(14,2);
  BEGIN
    IF p_atm_id IS NULL OR p_target_date IS NULL THEN
      RAISE_APPLICATION_ERROR(-20001, 'forecast_cash requires atm_id and target_date');
    END IF;

    SELECT ROUND(AVG(amount), 2)
      INTO v_forecast
      FROM daily_withdrawals
     WHERE atm_id = p_atm_id
       AND withdrawal_date >= p_target_date - 28
       AND withdrawal_date < p_target_date
       AND TO_CHAR(withdrawal_date, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH')
           = TO_CHAR(p_target_date, 'DY', 'NLS_DATE_LANGUAGE=ENGLISH');

    RETURN NVL(v_forecast, 0);
  END forecast_cash;

  PROCEDURE plan_replenishment_routes(
    p_target_date   IN DATE,
    p_location_id   IN locations.location_id%TYPE,
    p_runs_created  IN OUT NUMBER,
    p_atms_assigned IN OUT NUMBER
  ) IS
    v_forecast     NUMBER(14,2);
    v_run_id       replenishment_runs.run_id%TYPE;
    v_van_id       cash_vans.van_id%TYPE;
    v_custodian_id custodians.custodian_id%TYPE;
    v_target_fill  NUMBER(14,2);
    v_shortfall    NUMBER;
    v_rem          NUMBER;
    v_n100         NUMBER;
    v_n200         NUMBER;
    v_n500         NUMBER;
    v_n2000        NUMBER;
    v_stops        NUMBER;
  BEGIN
    p_runs_created := 0;
    p_atms_assigned := 0;

    IF p_target_date IS NULL THEN
      RAISE_APPLICATION_ERROR(-20002, 'plan_replenishment_routes requires a target date');
    END IF;

    FOR r IN (
      SELECT a.atm_id, a.current_cash, a.capacity_amount, b.location_id
        FROM atms a
        JOIN branches b ON b.branch_id = a.branch_id
       WHERE a.status IN ('active', 'cash_out')
         AND (p_location_id IS NULL OR b.location_id = p_location_id)
       ORDER BY b.location_id, a.atm_id
    ) LOOP
      SELECT COUNT(*)
        INTO v_stops
        FROM cassette_loads cl
        JOIN replenishment_runs rr ON rr.run_id = cl.run_id
       WHERE cl.atm_id = r.atm_id
         AND rr.planned_date = p_target_date
         AND rr.status <> 'cancelled';
      IF v_stops > 0 THEN
        CONTINUE;
      END IF;

      v_forecast := forecast_cash(r.atm_id, p_target_date);
      IF v_forecast <= r.current_cash THEN
        CONTINUE;
      END IF;

      v_target_fill := LEAST(r.capacity_amount, GREATEST(v_forecast * 4, r.current_cash));
      v_shortfall := FLOOR(v_target_fill - r.current_cash);
      IF r.current_cash + v_shortfall > r.capacity_amount THEN
        v_shortfall := FLOOR(r.capacity_amount - r.current_cash);
      END IF;
      IF v_shortfall < 100 THEN
        CONTINUE;
      END IF;

      v_n2000 := FLOOR(v_shortfall / 2000);
      v_rem := v_shortfall - (v_n2000 * 2000);
      v_n500 := FLOOR(v_rem / 500);
      v_rem := v_rem - (v_n500 * 500);
      v_n200 := FLOOR(v_rem / 200);
      v_rem := v_rem - (v_n200 * 200);
      v_n100 := FLOOR(v_rem / 100);
      IF v_n100 = 0 AND v_n200 = 0 AND v_n500 = 0 AND v_n2000 = 0 THEN
        CONTINUE;
      END IF;

      BEGIN
        SELECT van_id
          INTO v_van_id
          FROM (
            SELECT cv.van_id
              FROM cash_vans cv
             WHERE cv.location_id = r.location_id
               AND cv.status <> 'maintenance'
             ORDER BY (
               SELECT COUNT(DISTINCT cl.atm_id)
                 FROM replenishment_runs rr
                 JOIN cassette_loads cl ON cl.run_id = rr.run_id
                WHERE rr.van_id = cv.van_id
                  AND rr.planned_date = p_target_date
                  AND rr.status <> 'cancelled'
             ), cv.van_id
          )
         WHERE ROWNUM = 1;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          CONTINUE;
      END;

      BEGIN
        SELECT custodian_id
          INTO v_custodian_id
          FROM (
            SELECT c.custodian_id
              FROM custodians c
             WHERE c.van_id = v_van_id
               AND c.active = 1
             ORDER BY c.custodian_id
          )
         WHERE ROWNUM = 1;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          CONTINUE;
      END;

      v_run_id := NULL;
      BEGIN
        SELECT run_id
          INTO v_run_id
          FROM (
            SELECT rr.run_id
              FROM replenishment_runs rr
             WHERE rr.van_id = v_van_id
               AND rr.planned_date = p_target_date
               AND rr.location_id = r.location_id
               AND rr.status = 'planned'
               AND (
                 SELECT COUNT(DISTINCT cl.atm_id)
                   FROM cassette_loads cl
                  WHERE cl.run_id = rr.run_id
               ) < 15
             ORDER BY rr.run_id
          )
         WHERE ROWNUM = 1;
      EXCEPTION
        WHEN NO_DATA_FOUND THEN
          v_run_id := NULL;
      END;

      IF v_run_id IS NULL THEN
        INSERT INTO replenishment_runs (
          van_id, custodian_id, location_id, planned_date, status, notes, created_by
        ) VALUES (
          v_van_id, v_custodian_id, r.location_id, p_target_date, 'planned',
          'Auto-planned where forecast_cash exceeds cash still in the machine.',
          'plan_replenishment_routes'
        ) RETURNING run_id INTO v_run_id;
        p_runs_created := p_runs_created + 1;
      END IF;

      IF v_n100 > 0 THEN
        INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
        VALUES (v_run_id, r.atm_id, 1, 100, v_n100, v_n100 * 100);
      END IF;
      IF v_n200 > 0 THEN
        INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
        VALUES (v_run_id, r.atm_id, 2, 200, v_n200, v_n200 * 200);
      END IF;
      IF v_n500 > 0 THEN
        INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
        VALUES (v_run_id, r.atm_id, 3, 500, v_n500, v_n500 * 500);
      END IF;
      IF v_n2000 > 0 THEN
        INSERT INTO cassette_loads (run_id, atm_id, cassette_number, denomination, note_count, amount)
        VALUES (v_run_id, r.atm_id, 4, 2000, v_n2000, v_n2000 * 2000);
      END IF;

      p_atms_assigned := p_atms_assigned + 1;
    END LOOP;

    INSERT INTO replenishment_plan_log (target_date, location_id, runs_created, atms_assigned)
    VALUES (p_target_date, p_location_id, p_runs_created, p_atms_assigned);
  END plan_replenishment_routes;
END cash_ops;
/

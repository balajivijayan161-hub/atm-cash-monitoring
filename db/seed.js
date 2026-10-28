const { pool, ensureSchema } = require('../src/db');
const { forecastFactor } = require('../src/services/calendar');

const LOCATIONS = [
  { code: 'MUM', name: 'Mumbai Metro', city: 'Mumbai', state: 'Maharashtra', region: 'West', plate: 'MH' },
  { code: 'DEL', name: 'Delhi NCR', city: 'New Delhi', state: 'Delhi', region: 'North', plate: 'DL' },
  { code: 'BLR', name: 'Bengaluru Urban', city: 'Bengaluru', state: 'Karnataka', region: 'South', plate: 'KA' },
  { code: 'CHE', name: 'Chennai Metro', city: 'Chennai', state: 'Tamil Nadu', region: 'South', plate: 'TN' },
  { code: 'HYD', name: 'Hyderabad', city: 'Hyderabad', state: 'Telangana', region: 'South', plate: 'TS' },
  { code: 'PUN', name: 'Pune', city: 'Pune', state: 'Maharashtra', region: 'West', plate: 'MH' },
  { code: 'CCU', name: 'Kolkata', city: 'Kolkata', state: 'West Bengal', region: 'East', plate: 'WB' },
  { code: 'AMD', name: 'Ahmedabad', city: 'Ahmedabad', state: 'Gujarat', region: 'West', plate: 'GJ' },
  { code: 'JAI', name: 'Jaipur', city: 'Jaipur', state: 'Rajasthan', region: 'North', plate: 'RJ' },
  { code: 'COK', name: 'Kochi', city: 'Kochi', state: 'Kerala', region: 'South', plate: 'KL' },
];

const AREAS = ['Fort', 'Station Road', 'Market', 'Civil Lines', 'Tech Park'];
const SITES = [
  { name: 'Branch lobby', base: 190000 },
  { name: 'High-street market', base: 340000 },
  { name: 'Railway concourse', base: 520000 },
  { name: 'Mall atrium', base: 430000 },
  { name: 'Hospital gate', base: 160000 },
  { name: 'IT park', base: 275000 },
  { name: 'Bus terminal', base: 360000 },
  { name: 'Fuel station', base: 145000 },
  { name: 'College junction', base: 210000 },
];
const DOW_MULT = [1.24, 1.02, 0.86, 0.9, 0.98, 1.42, 1.62];

const CUSTODIAN_NAMES = [
  'Asha Kulkarni', 'Ramesh Iyer', 'Farah Qureshi', 'Joseph D Souza', 'Meera Nair',
  'Harpreet Singh', 'Lavanya Rao', 'Imran Sheikh', 'Smita Kulkarni', 'Arvind Menon',
  'Kavita Joshi', 'Noel Fernandes', 'Deepa Krishnan', 'Sajid Ansari', 'Ruthika Pal',
  'Bharat Deshmukh', 'Anjali Reddy', 'Vikram Sethi', 'Fathima Basheer', 'John Kurian',
  'Pooja Bhatt', 'Suresh Nambiar', 'Catherine Lobo', 'Irfan Qadri', 'Meenakshi Iyer',
  'George Varghese', 'Shabana Khan', 'Ritu Malhotra', 'Ajay Kulkarni', 'Nandini Rao',
];

const ENGINEER_NAMES = [
  'Nikhil Pawar', 'Sandra D Silva', 'Abdul Kareem', 'Priya Subramanian', 'Rohan Gupta',
  'Leela Thomas', 'Manish Agarwal', 'Keerthi Balan', 'Yusuf Khan', 'Anita George',
  'Prakash Jain', 'Divya Menon', 'Harish Chandra', 'Nalini Rao', 'Omar Farooq',
  'Sheetal Patil', 'Benjamin Koshy', 'Radha Iyer', 'Tanveer Ahmed', 'Grace Mathew',
];

const SPECIALTIES = ['hardware', 'network', 'cash_handling', 'general'];
const VAN_CASHOUT_WEIGHTS = [7, 1, 4, 0, 3, 1, 2, 0, 5, 1, 2, 1, 0, 3, 1, 0, 2, 1, 4, 0];
const VARIANCES = [-5000, -15000, 2000, -2500, -50000, 10000];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(iso, delta) {
  const [year, month, day] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function dow(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function round100(value) {
  return Math.round(value / 100) * 100;
}

function previousTuesday(today) {
  const delta = (dow(today) - 2 + 7) % 7;
  return addDays(today, delta === 0 ? -7 : -delta);
}

function phone(n) {
  return `+91 ${String(9800000000 + n).slice(0, 10)}`;
}

async function unnest(client, sql, arrays, size = 7000) {
  const length = arrays[0].length;
  for (let i = 0; i < length; i += size) {
    await client.query(sql, arrays.map((column) => column.slice(i, i + size)));
  }
}

async function seedIfEmpty(client) {
  const existing = await client.query(`SELECT value FROM app_meta WHERE key = 'seeded'`);
  if (existing.rowCount) return false;

  const today = (await client.query(`SELECT CURRENT_DATE::text AS today`)).rows[0].today;
  const holidayRows = await client.query(
    `SELECT holiday_date::text AS holiday_date, multiplier FROM holidays WHERE active`
  );
  const holidayFactor = new Map(holidayRows.rows.map((row) => [row.holiday_date, Number(row.multiplier)]));
  const rng = mulberry32(20261027);
  const dates = [];
  for (let offset = 62; offset >= 0; offset -= 1) dates.push(addDays(today, -offset));
  const lastTuesday = previousTuesday(today);

  const locationIds = [];
  for (const loc of LOCATIONS) {
    const inserted = await client.query(
      `INSERT INTO locations (location_code, location_name, city, state, region)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING location_id`,
      [loc.code, loc.name, loc.city, loc.state, loc.region]
    );
    locationIds.push(inserted.rows[0].location_id);
  }

  const branchIds = LOCATIONS.map(() => []);
  for (let locIndex = 0; locIndex < LOCATIONS.length; locIndex += 1) {
    const loc = LOCATIONS[locIndex];
    for (let areaIndex = 0; areaIndex < AREAS.length; areaIndex += 1) {
      const inserted = await client.query(
        `INSERT INTO branches (location_id, branch_code, branch_name, address, ifsc_code)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING branch_id`,
        [
          locationIds[locIndex],
          `${loc.code}${String(areaIndex + 1).padStart(2, '0')}`,
          `${loc.city} ${AREAS[areaIndex]}`,
          `${AREAS[areaIndex]}, ${loc.city}, ${loc.state}`,
          `D${loc.code}0${String(areaIndex + 1).padStart(6, '0')}`,
        ]
      );
      branchIds[locIndex].push(inserted.rows[0].branch_id);
    }
  }

  const plans = [];
  for (let i = 0; i < 450; i += 1) {
    const locIndex = Math.floor(i / 45);
    const withinLoc = i % 45;
    const branchWithin = Math.floor(withinLoc / 9);
    const site = SITES[withinLoc % 9];
    const jitter = 0.85 + rng() * 0.3;
    const base = site.base * jitter;
    let sum = 0;
    const daily = [];
    for (const date of dates) {
      const noise = 0.88 + rng() * 0.24;
      const amount = Math.max(20000, round100(base * DOW_MULT[dow(date)] * noise * forecastFactor(date, holidayFactor.get(date) || 1)));
      const txn = Math.max(8, Math.min(900, Math.round(amount / (1800 + rng() * 800))));
      daily.push({ date, amount, txn });
      sum += amount;
    }
    const avg = sum / daily.length;
    const isLong = withinLoc === 0 || withinLoc === 1;
    const ongoing = withinLoc === 0;
    const isCashout = !isLong && i % 18 === 0;
    const lowCash = !isLong && !isCashout && i % 13 === 0;
    let status = 'active';
    if (ongoing) status = 'out_of_service';
    else if (isCashout) status = 'cash_out';
    let current = round100(avg * 4.2);
    if (status === 'cash_out') current = 0;
    else if (lowCash) current = round100(avg * 0.15);
    const capacity = Math.max(800000, round100(avg * 12), current);
    plans.push({
      i,
      locIndex,
      withinLoc,
      branchId: branchIds[locIndex][branchWithin],
      code: `ATM-${LOCATIONS[locIndex].code}-${String(i + 1).padStart(4, '0')}`,
      site: site.name,
      address: `${site.name}, ${AREAS[branchWithin]}, ${LOCATIONS[locIndex].city}`,
      status,
      installedOn: addDays(today, -(420 + (i % 2400))),
      capacity,
      current,
      avg,
      daily,
      isLong,
      ongoing,
      isCashout,
      lowCash,
      vanSlot: withinLoc % 2,
    });
  }

  const insertedAtms = await client.query(
    `INSERT INTO atms (
       branch_id, atm_code, site_name, address, status, installed_on,
       cassette_count, capacity_amount, current_cash, last_replenished_on
     )
     SELECT * FROM UNNEST(
       $1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::date[],
       $7::int[], $8::numeric[], $9::numeric[], $10::date[]
     )
     RETURNING atm_id, atm_code`,
    [
      plans.map((plan) => plan.branchId),
      plans.map((plan) => plan.code),
      plans.map((plan) => plan.site),
      plans.map((plan) => plan.address),
      plans.map((plan) => plan.status),
      plans.map((plan) => plan.installedOn),
      plans.map(() => 4),
      plans.map((plan) => plan.capacity),
      plans.map((plan) => plan.current),
      plans.map(() => lastTuesday),
    ]
  );
  const idByCode = new Map(insertedAtms.rows.map((row) => [row.atm_code, row.atm_id]));
  for (const plan of plans) plan.atmId = idByCode.get(plan.code);

  const wAtm = [];
  const wDate = [];
  const wAmt = [];
  const wTxn = [];
  for (const plan of plans) {
    for (const day of plan.daily) {
      wAtm.push(plan.atmId);
      wDate.push(day.date);
      wAmt.push(day.amount);
      wTxn.push(day.txn);
    }
  }
  await unnest(
    client,
    `INSERT INTO daily_withdrawals (atm_id, withdrawal_date, amount, txn_count, source)
     SELECT x.atm_id, x.withdrawal_date, x.amount, x.txn_count, 'seed'
     FROM UNNEST($1::int[], $2::date[], $3::numeric[], $4::int[])
       AS x(atm_id, withdrawal_date, amount, txn_count)`,
    [wAtm, wDate, wAmt, wTxn]
  );

  const vanIds = LOCATIONS.map(() => []);
  let custodianNameIndex = 0;
  for (let locIndex = 0; locIndex < LOCATIONS.length; locIndex += 1) {
    const loc = LOCATIONS[locIndex];
    for (let slot = 0; slot < 2; slot += 1) {
      const status = locIndex === 7 && slot === 1 ? 'maintenance' : 'available';
      const van = await client.query(
        `INSERT INTO cash_vans (location_id, van_code, registration_no, capacity_amount, status)
         VALUES ($1, $2, $3, 25000000, $4)
         RETURNING van_id`,
        [
          locationIds[locIndex],
          `VAN-${loc.code}-${slot + 1}`,
          `${loc.plate}-${String(10 + locIndex).padStart(2, '0')}-CQ-${String(1000 + slot).padStart(4, '0')}`,
          status,
        ]
      );
      const vanId = van.rows[0].van_id;
      vanIds[locIndex].push(vanId);
      const crew = slot === 0 ? 2 : 1;
      for (let c = 0; c < crew; c += 1) {
        const name = CUSTODIAN_NAMES[custodianNameIndex];
        custodianNameIndex += 1;
        await client.query(
          `INSERT INTO custodians (van_id, employee_code, full_name, phone, active)
           VALUES ($1, $2, $3, $4, TRUE)`,
          [vanId, `CST${String(custodianNameIndex).padStart(3, '0')}`, name, phone(custodianNameIndex)]
        );
      }
    }
  }

  let engineerNameIndex = 0;
  const engineerByLocation = new Map();
  for (let locIndex = 0; locIndex < LOCATIONS.length; locIndex += 1) {
    for (let e = 0; e < 2; e += 1) {
      const name = ENGINEER_NAMES[engineerNameIndex];
      engineerNameIndex += 1;
      const inserted = await client.query(
        `INSERT INTO engineers (location_id, employee_code, full_name, phone, specialty, active)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING engineer_id`,
        [
          locationIds[locIndex],
          `ENG${String(engineerNameIndex).padStart(3, '0')}`,
          name,
          phone(200 + engineerNameIndex),
          SPECIALTIES[(locIndex + e) % SPECIALTIES.length],
        ]
      );
      if (!engineerByLocation.has(locationIds[locIndex])) {
        engineerByLocation.set(locationIds[locIndex], inserted.rows[0].engineer_id);
      }
    }
  }

  const loadRun = [];
  const loadAtm = [];
  const loadCassette = [];
  const loadDenom = [];
  const loadNotes = [];
  const loadAmount = [];
  const tuesdays = [];
  let cursor = lastTuesday;
  for (let week = 0; week < 8; week += 1) {
    tuesdays.push(cursor);
    cursor = addDays(cursor, -7);
  }

  for (const tuesday of tuesdays) {
    const thursday = addDays(tuesday, 2);
    for (let locIndex = 0; locIndex < LOCATIONS.length; locIndex += 1) {
      for (let slot = 0; slot < 2; slot += 1) {
        const group = plans.filter((plan) => plan.locIndex === locIndex && plan.vanSlot === slot);
        const chunks = thursday < today
          ? [[tuesday, group.slice(0, 12)], [thursday, group.slice(12)]]
          : [[tuesday, group]];
        for (const [runDate, members] of chunks) {
          if (!members.length || runDate >= today) continue;
          const custodian = await client.query(
            `SELECT custodian_id FROM custodians WHERE van_id = $1 AND active ORDER BY custodian_id LIMIT 1`,
            [vanIds[locIndex][slot]]
          );
          const run = await client.query(
            `INSERT INTO replenishment_runs
               (van_id, custodian_id, location_id, planned_date, status, notes, created_by)
             VALUES ($1, $2, $3, $4, 'completed', 'Weekly replenishment — seeded history.', 'seed')
             RETURNING run_id`,
            [vanIds[locIndex][slot], custodian.rows[0].custodian_id, locationIds[locIndex], runDate]
          );
          for (const plan of members) {
            const factor = Math.max(0.55, Math.min(1.5, plan.avg / 280000));
            const cassettes = [
              [1, 100, Math.max(1, Math.min(10000, Math.round(500 * factor)))],
              [3, 500, Math.max(1, Math.min(10000, Math.round(280 * factor)))],
              [4, 2000, Math.max(1, Math.min(10000, Math.round(180 * factor)))],
            ];
            if (plan.i % 2 === 0) {
              cassettes.splice(1, 0, [2, 200, Math.max(1, Math.min(10000, Math.round(220 * factor)))]);
            }
            for (const [cassette, denom, notes] of cassettes) {
              loadRun.push(run.rows[0].run_id);
              loadAtm.push(plan.atmId);
              loadCassette.push(cassette);
              loadDenom.push(denom);
              loadNotes.push(notes);
              loadAmount.push(denom * notes);
            }
          }
        }
      }
    }
  }

  await unnest(
    client,
    `INSERT INTO cassette_loads
       (run_id, atm_id, cassette_number, denomination, note_count, amount)
     SELECT * FROM UNNEST($1::int[], $2::int[], $3::int[], $4::numeric[], $5::int[], $6::numeric[])`,
    [loadRun, loadAtm, loadCassette, loadDenom, loadNotes, loadAmount],
    4000
  );
  await client.query(
    `UPDATE cassette_loads cl
     SET loaded_at = (rr.planned_date + time '10:30') AT TIME ZONE 'Asia/Kolkata'
     FROM replenishment_runs rr
     WHERE rr.run_id = cl.run_id
       AND rr.created_by = 'seed'`
  );

  const longPlans = plans.filter((plan) => plan.isLong);
  await client.query(
    `INSERT INTO downtime_log (atm_id, started_at, ended_at, reason, notes)
     SELECT x.atm_id,
            date_trunc('month', CURRENT_TIMESTAMP),
            CASE WHEN x.ongoing THEN NULL
                 ELSE date_trunc('month', CURRENT_TIMESTAMP) + interval '2 days' END,
            x.reason,
            x.notes
     FROM UNNEST($1::int[], $2::bool[], $3::text[], $4::text[])
       AS x(atm_id, ongoing, reason, notes)`,
    [
      longPlans.map((plan) => plan.atmId),
      longPlans.map((plan) => plan.ongoing),
      longPlans.map((plan) => (plan.i % 2 === 0 ? 'hardware' : 'communication')),
      longPlans.map((plan) => (
        plan.ongoing
          ? 'Site still down this month. Dispatch is waiting on a part.'
          : 'Two-day outage at the start of the month. Service restored after the second visit.'
      )),
    ]
  );

  const cashoutIds = plans.filter((plan) => plan.isCashout).map((plan) => plan.atmId);
  if (cashoutIds.length) {
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, ended_at, reason, notes)
       SELECT x.atm_id,
              (sat.saturday + time '18:00') AT TIME ZONE 'Asia/Kolkata',
              ((sat.saturday + 2) + time '11:00') AT TIME ZONE 'Asia/Kolkata',
              'cash_out',
              'Dispenser empty from Saturday evening until the Monday replenishment.'
       FROM UNNEST($1::int[]) AS x(atm_id)
       CROSS JOIN (
         SELECT (CURRENT_DATE - ((EXTRACT(DOW FROM CURRENT_DATE)::int + 1) % 7))::date AS saturday
       ) sat
       WHERE sat.saturday >= date_trunc('month', CURRENT_DATE)::date
         AND (sat.saturday + 2) < CURRENT_DATE`,
      [cashoutIds]
    );
  }

  const shortPlans = plans.filter((plan) => !plan.isLong && !plan.isCashout && plan.i % 8 === 3);
  if (shortPlans.length) {
    await client.query(
      `INSERT INTO downtime_log (atm_id, started_at, ended_at, reason, notes)
       SELECT x.atm_id,
              CURRENT_TIMESTAMP - make_interval(days => x.days_ago),
              CURRENT_TIMESTAMP - make_interval(days => x.days_ago) + make_interval(mins => x.minutes),
              x.reason,
              'Short interruption logged by the switch monitor.'
       FROM UNNEST($1::int[], $2::int[], $3::int[], $4::text[])
         AS x(atm_id, days_ago, minutes, reason)`,
      [
        shortPlans.map((plan) => plan.atmId),
        shortPlans.map((plan) => 2 + (plan.i % 9)),
        shortPlans.map((plan) => 40 + (plan.i % 8) * 12),
        shortPlans.map((plan) => (plan.i % 2 === 0 ? 'power' : 'cassette_error')),
      ]
    );
  }

  for (const plan of longPlans.filter((item) => item.ongoing)) {
    const reason = plan.i % 2 === 0 ? 'hardware' : 'communication';
    await client.query(
      `INSERT INTO fault_tickets
         (atm_id, title, description, category, priority, status, source, engineer_id, assigned_at)
       VALUES ($1, $2, $3, $4, 'high', 'assigned', 'manual', $5, CURRENT_TIMESTAMP - interval '1 day')`,
      [
        plan.atmId,
        `${reason === 'hardware' ? 'Dispenser offline' : 'Link down'} — ${plan.code}`,
        reason === 'hardware'
          ? 'Presenter fault after the morning settlement. Machine is out of service.'
          : 'ATM dropped off the switch. No heartbeats since the start of the outage.',
        reason,
        engineerByLocation.get(locationIds[plan.locIndex]),
      ]
    );
  }

  await client.query(
    `UPDATE downtime_log d
     SET ticket_id = ft.ticket_id
     FROM fault_tickets ft
     WHERE ft.atm_id = d.atm_id
       AND ft.source = 'manual'
       AND ft.category = d.reason
       AND d.ended_at IS NULL
       AND d.ticket_id IS NULL`
  );

  const vanRoutes = await client.query(
    `SELECT cv.van_id, cv.location_id,
            COALESCE(array_agg(DISTINCT cl.atm_id) FILTER (WHERE cl.atm_id IS NOT NULL), ARRAY[]::int[]) AS atm_ids
     FROM cash_vans cv
     LEFT JOIN replenishment_runs rr ON rr.van_id = cv.van_id
     LEFT JOIN cassette_loads cl ON cl.run_id = rr.run_id
     GROUP BY cv.van_id
     ORDER BY cv.van_id`
  );
  for (let vanIndex = 0; vanIndex < vanRoutes.rows.length; vanIndex += 1) {
    const route = vanRoutes.rows[vanIndex];
    const weight = VAN_CASHOUT_WEIGHTS[vanIndex] || 0;
    const atmIds = route.atm_ids || [];
    for (let n = 0; n < weight; n += 1) {
      if (!atmIds.length) break;
      const atmId = atmIds[n % atmIds.length];
      const daysAgo = 2 + n * 3 + vanIndex;
      const mode = n % 3;
      const status = mode === 0 ? 'closed' : (mode === 1 ? 'assigned' : 'open');
      const engineerId = status === 'open' ? null : engineerByLocation.get(route.location_id);
      await client.query(
        `INSERT INTO fault_tickets (
           atm_id, title, description, category, priority, status, source,
           engineer_id, assigned_at, resolution, opened_at, closed_at
         ) VALUES (
           $1, $2, $3, 'cash_out', 'high', $4::varchar, 'monitor',
           $5,
           CASE WHEN $4::varchar = 'open' THEN NULL ELSE CURRENT_TIMESTAMP - make_interval(days => $6) + interval '3 hours' END,
           CASE WHEN $4::varchar = 'closed' THEN 'Replenished and tested. Returned to service.' ELSE NULL END,
           CURRENT_TIMESTAMP - make_interval(days => $6),
           CASE WHEN $4::varchar = 'closed' THEN CURRENT_TIMESTAMP - make_interval(days => $6) + interval '1 day' ELSE NULL END
         )`,
        [
          atmId,
          'Cash out on van route',
          'Weekend withdrawals emptied the cassettes before the next scheduled run.',
          status,
          engineerId,
          daysAgo,
        ]
      );
    }
  }

  await client.query(
    `UPDATE downtime_log d
     SET ticket_id = sub.ticket_id
     FROM (
       SELECT DISTINCT ON (atm_id) atm_id, ticket_id
       FROM fault_tickets
       WHERE category = 'cash_out'
       ORDER BY atm_id, opened_at DESC
     ) sub
     WHERE d.atm_id = sub.atm_id
       AND d.reason = 'cash_out'
       AND d.ticket_id IS NULL`
  );

  const cassetteAtms = plans.filter((plan) => [5, 17, 29, 41, 53].includes(plan.i));
  for (const plan of cassetteAtms) {
    await client.query(
      `INSERT INTO fault_tickets
         (atm_id, title, description, category, priority, status, source, opened_at)
       VALUES ($1, $2, $3, 'cassette_error', 'medium', 'open', 'manual', CURRENT_TIMESTAMP - interval '4 days')`,
      [
        plan.atmId,
        `Cassette seating error — ${plan.code}`,
        'Loader reported cassette 3 was not seated. The counter and the physical notes will not match until it is reseated.',
      ]
    );
  }

  const reconRows = await client.query(
    `SELECT rr.run_id, rr.planned_date::text AS planned_date, cl.atm_id, SUM(cl.amount) AS expected
     FROM cassette_loads cl
     JOIN replenishment_runs rr ON rr.run_id = cl.run_id
     WHERE rr.created_by = 'seed'
     GROUP BY rr.run_id, rr.planned_date, cl.atm_id
     ORDER BY rr.planned_date DESC, cl.atm_id
     LIMIT 24`
  );
  for (let i = 0; i < reconRows.rows.length; i += 1) {
    const row = reconRows.rows[i];
    const variance = i < VARIANCES.length ? VARIANCES[i] : 0;
    await client.query(
      `INSERT INTO reconciliations (atm_id, run_id, recon_date, expected_amount, counted_amount, notes)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        row.atm_id,
        row.run_id,
        row.planned_date,
        row.expected,
        row.expected + variance,
        variance === 0
          ? 'Physical count agreed with the expected cassette total.'
          : 'Cassette counter did not match the physical count. Counted with the custodian present.',
      ]
    );
  }

  await client.query(
    `WITH picked AS (
       SELECT ticket_id
       FROM fault_tickets
       WHERE source = 'trigger'
       ORDER BY ticket_id
       LIMIT 2
     )
     UPDATE fault_tickets ft
     SET engineer_id = eng.engineer_id,
         status = 'assigned',
         assigned_at = CURRENT_TIMESTAMP
     FROM picked
     JOIN fault_tickets src ON src.ticket_id = picked.ticket_id
     JOIN atms a ON a.atm_id = src.atm_id
     JOIN branches b ON b.branch_id = a.branch_id
     JOIN LATERAL (
       SELECT engineer_id
       FROM engineers e
       WHERE e.location_id = b.location_id AND e.active
       ORDER BY engineer_id
       LIMIT 1
     ) eng ON TRUE
     WHERE ft.ticket_id = picked.ticket_id`
  );

  const checks = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM atms) AS atms,
       (SELECT COUNT(*)::int FROM daily_withdrawals) AS withdrawals,
       (SELECT COUNT(*)::int FROM locations) AS locations,
       (SELECT COUNT(*)::int FROM cash_vans) AS vans,
       (SELECT COUNT(*)::int FROM fault_tickets WHERE source = 'trigger') AS trigger_tickets,
       (SELECT COUNT(*)::int FROM v_atm_downtime_above_5pct) AS above_five,
       (SELECT COALESCE(MAX(cashout_incidents), 0)::int FROM v_van_cashout_incidents) AS top_cashouts`
  );
  const stats = checks.rows[0];
  if (stats.atms !== 450) throw new Error(`Expected 450 ATMs, found ${stats.atms}`);
  if (stats.withdrawals !== 450 * 63) {
    throw new Error(`Expected ${450 * 63} withdrawals, found ${stats.withdrawals}`);
  }
  if (stats.trigger_tickets !== VARIANCES.length) {
    throw new Error(`Reconciliation trigger raised ${stats.trigger_tickets} tickets, expected ${VARIANCES.length}`);
  }
  if (stats.above_five < 10) {
    throw new Error(`Expected ATMs above 5% downtime, found ${stats.above_five}`);
  }
  if (stats.top_cashouts < 1) throw new Error('Expected cash-out incidents on at least one van route');

  await client.query(`INSERT INTO app_meta (key, value) VALUES ('seeded', CURRENT_TIMESTAMP::text)`);
  await client.query('ANALYZE');
  console.log(
    `Seeded ${stats.atms} ATMs, ${stats.withdrawals} withdrawal days, ` +
    `${stats.trigger_tickets} variance tickets, ${stats.above_five} ATMs above 5% downtime.`
  );
  return true;
}

async function main() {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seeded = await seedIfEmpty(client);
    await client.query('COMMIT');
    console.log(seeded ? 'Sample ledger loaded.' : 'Sample ledger already present.');
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (rollbackErr) { /* connection already clearing */ }
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedIfEmpty };

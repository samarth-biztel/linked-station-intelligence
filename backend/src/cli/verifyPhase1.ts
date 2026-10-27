import { createClient } from '../db.js';

const client = createClient();
await client.connect();
try {
  const result = await client.query<{
    tightening_rows: string;
    leak_rows: string;
    engines: string;
    first_attempt_nok: string;
    second_attempt_ok: string;
    leak_nok: string;
    leak_ok: string;
    torque_measurements: string;
    leak_measurements: string;
  }>(`
    SELECT
      (SELECT count(*) FROM cycle WHERE operation_id = '10') AS tightening_rows,
      (SELECT count(*) FROM cycle WHERE operation_id = '20') AS leak_rows,
      (SELECT count(*) FROM engine) AS engines,
      (SELECT count(*) FROM cycle WHERE operation_id = '10' AND attempt = 1 AND result = 'NOK') AS first_attempt_nok,
      (SELECT count(*) FROM cycle WHERE operation_id = '10' AND attempt = 2 AND result = 'OK') AS second_attempt_ok,
      (SELECT count(*) FROM cycle WHERE operation_id = '20' AND result = 'NOK') AS leak_nok,
      (SELECT count(*) FROM cycle WHERE operation_id = '20' AND result = 'OK') AS leak_ok,
      (SELECT count(*) FROM measurement WHERE parameter IN ('bolt1_torque', 'bolt2_torque')) AS torque_measurements,
      (SELECT count(*) FROM measurement WHERE parameter = 'leak_rate') AS leak_measurements
  `);
  const actual = Object.fromEntries(Object.entries(result.rows[0]).map(([key, value]) => [key, Number(value)]));
  const expected = {
    tightening_rows: 3090,
    leak_rows: 3000,
    engines: 3000,
    first_attempt_nok: 90,
    second_attempt_ok: 90,
    leak_nok: 720,
    leak_ok: 2280,
    torque_measurements: 6180,
    leak_measurements: 3000,
  };
  console.table(actual);
  for (const [key, count] of Object.entries(expected)) {
    if (actual[key] !== count) throw new Error(`Phase 1 gate failed: ${key} expected ${count}, got ${actual[key]}`);
  }
  console.log('Phase 1 fixture gate passed.');
} finally {
  await client.end();
}

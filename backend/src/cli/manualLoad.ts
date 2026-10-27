/** Phase 1 fixture loader: explicit columns and rules, before automatic mapping. */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { createClient } from '../db.js';

type Measurement = {
  parameter: string;
  value: number;
  unit: string;
  lowerLimit: number | null;
  upperLimit: number | null;
};

type Cycle = {
  operationId: '10' | '20';
  engineSerial: string;
  attempt: number;
  enteredAt: Date;
  startedAt: Date;
  endedAt: Date;
  cycleTimeS: number;
  result: 'OK' | 'NOK';
  resourceId: string;
  sourceRecordId: string;
  measurements: Measurement[];
};

type SheetProfile = {
  cycles: Cycle[];
  ignoredCells: string[];
};

const fixturePath = path.resolve(
  process.env.FIXTURE_PATH ?? 'BiztelAI_Two_Station_Synthetic_Dataset_30_Days_3000_Engines_v2.xlsx',
);

function value(row: ExcelJS.Row, column: number): string | number {
  const raw = row.getCell(column).value;
  if (typeof raw === 'string' || typeof raw === 'number') return raw;
  throw new Error(`Expected text or number at ${row.worksheet.name}!${row.getCell(column).address}`);
}

function text(row: ExcelJS.Row, column: number): string {
  const raw = value(row, column);
  return String(raw).trim();
}

function number(row: ExcelJS.Row, column: number): number {
  const raw = value(row, column);
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number at ${row.worksheet.name}!${row.getCell(column).address}`);
  }
  return parsed;
}

function localTime(row: ExcelJS.Row, column: number): Date {
  const local = text(row, column);
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(local)) {
    throw new Error(`Expected local timestamp at ${row.worksheet.name}!${row.getCell(column).address}`);
  }
  // The design plan fixes the synthetic fixture's otherwise zone-free times to Asia/Kolkata.
  const instant = new Date(`${local.replace(' ', 'T')}+05:30`);
  if (Number.isNaN(instant.getTime())) throw new Error(`Invalid timestamp: ${local}`);
  return instant;
}

function headers(sheet: ExcelJS.Worksheet, expected: string[]): void {
  expected.forEach((header, index) => {
    if (text(sheet.getRow(1), index + 1) !== header) {
      throw new Error(`Unexpected header at ${sheet.name}!${index + 1}: expected ${header}`);
    }
  });
}

function baseCycle(row: ExcelJS.Row, operationId: '10' | '20', cols: {
  engine: number;
  machine: number;
  entry: number;
  start: number;
  end: number;
  result: number;
  attempt?: number;
}): Omit<Cycle, 'measurements'> {
  if (number(row, 1) !== Number(operationId)) {
    throw new Error(`Wrong operation number at ${row.worksheet.name}!A${row.number}`);
  }
  const engineSerial = text(row, cols.engine).toUpperCase();
  if (!/^BIZENGM\d+$/.test(engineSerial)) {
    throw new Error(`Invalid fixture engine serial at ${row.worksheet.name}!${row.number}`);
  }
  const attempt = cols.attempt ? number(row, cols.attempt) : 1;
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(`Invalid attempt for ${engineSerial}`);
  const enteredAt = localTime(row, cols.entry);
  const startedAt = localTime(row, cols.start);
  const endedAt = localTime(row, cols.end);
  const cycleTimeS = (endedAt.getTime() - startedAt.getTime()) / 1000;
  if (cycleTimeS < 0 || startedAt < enteredAt) {
    throw new Error(`Invalid time order for ${engineSerial} at ${row.worksheet.name}!${row.number}`);
  }
  const result = text(row, cols.result);
  if (result !== 'OK' && result !== 'NOK') throw new Error(`Invalid result for ${engineSerial}`);
  return {
    operationId,
    engineSerial,
    attempt,
    enteredAt,
    startedAt,
    endedAt,
    cycleTimeS,
    result,
    resourceId: text(row, cols.machine),
    sourceRecordId: `${row.worksheet.name}!${row.number}`,
  };
}

function profileTightening(sheet: ExcelJS.Worksheet): SheetProfile {
  headers(sheet, [
    'Operation Number', 'Engine No', 'Attempt', 'Station', 'Machine ID',
    'Station Entry Time', 'Cycle Start Time', 'Cycle End Time', 'Cycle Duration (sec)',
    'Bolt 1 Torque (Nm)', 'Bolt 2 Torque (Nm)', 'Torque Lower Limit (Nm)',
    'Torque Upper Limit (Nm)', 'Torque Station Result',
  ]);
  const cycles: Cycle[] = [];
  const ignoredCells: string[] = [];
  for (let i = 2; i <= sheet.rowCount; i += 1) {
    const row = sheet.getRow(i);
    const base = baseCycle(row, '10', {
      engine: 2, attempt: 3, machine: 5, entry: 6, start: 7, end: 8, result: 14,
    });
    if (number(row, 9) !== base.cycleTimeS) throw new Error(`Duration mismatch at ${sheet.name}!I${i}`);
    const lower = number(row, 12);
    const upper = number(row, 13);
    const bolt1 = number(row, 10);
    const bolt2 = number(row, 11);
    const expected = bolt1 >= lower && bolt1 <= upper && bolt2 >= lower && bolt2 <= upper ? 'OK' : 'NOK';
    if (base.result !== expected) throw new Error(`Torque result mismatch at ${sheet.name}!N${i}`);
    cycles.push({
      ...base,
      measurements: [
        { parameter: 'bolt1_torque', value: bolt1, unit: 'Nm', lowerLimit: lower, upperLimit: upper },
        { parameter: 'bolt2_torque', value: bolt2, unit: 'Nm', lowerLimit: lower, upperLimit: upper },
      ],
    });
    for (let col = 15; col <= row.cellCount; col += 1) {
      if (row.getCell(col).value !== null && row.getCell(col).value !== undefined) {
        ignoredCells.push(row.getCell(col).address);
      }
    }
  }
  return { cycles, ignoredCells };
}

function profileLeak(sheet: ExcelJS.Worksheet): SheetProfile {
  headers(sheet, [
    'Operation Number', 'Engine No', 'Station', 'Machine ID', 'Station Entry Time',
    'Cycle Start Time', 'Cycle End Time', 'Leak Test Timestamp', 'Leak Rate (sccm)',
    'Leak Threshold (sccm)', 'Leak Test Result',
  ]);
  const cycles: Cycle[] = [];
  for (let i = 2; i <= sheet.rowCount; i += 1) {
    const row = sheet.getRow(i);
    const base = baseCycle(row, '20', {
      engine: 2, machine: 4, entry: 5, start: 6, end: 7, result: 11,
    });
    if (localTime(row, 8).getTime() !== base.endedAt.getTime()) {
      throw new Error(`Leak timestamp mismatch at ${sheet.name}!H${i}`);
    }
    const leakRate = number(row, 9);
    const limit = number(row, 10);
    const expected = leakRate <= limit ? 'OK' : 'NOK';
    if (base.result !== expected) throw new Error(`Leak result mismatch at ${sheet.name}!K${i}`);
    cycles.push({
      ...base,
      measurements: [{ parameter: 'leak_rate', value: leakRate, unit: 'sccm', lowerLimit: null, upperLimit: limit }],
    });
  }
  return { cycles, ignoredCells: [] };
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

function placeholders(rows: number, columns: number): string {
  return Array.from({ length: rows }, (_, row) =>
    `(${Array.from({ length: columns }, (_, column) => `$${row * columns + column + 1}`).join(',')})`,
  ).join(',');
}

async function main(): Promise<void> {
  const bytes = await readFile(fixturePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const tighteningSheet = workbook.getWorksheet('Tightening Station');
  const leakSheet = workbook.getWorksheet('Leak Testing Station');
  if (!tighteningSheet || !leakSheet) throw new Error('Fixture station sheets are missing');
  const tightening = profileTightening(tighteningSheet);
  const leak = profileLeak(leakSheet);
  const profiles = [
    { operationId: '10', name: 'Top Cover Tightening', profile: tightening },
    { operationId: '20', name: 'Leak Testing', profile: leak },
  ] as const;
  console.log(`Parsed ${tightening.cycles.length} tightening and ${leak.cycles.length} leak records.`);
  console.log(`Ignored untitled cells: ${tightening.ignoredCells.join(', ') || 'none'}`);

  const client = createClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const operation of profiles) {
      await client.query(
        `INSERT INTO operation (operation_id, name) VALUES ($1, $2)
         ON CONFLICT (operation_id) DO UPDATE SET name = EXCLUDED.name`,
        [operation.operationId, operation.name],
      );
    }
    const file = await client.query<{ file_id: string }>(
      `INSERT INTO source_file (filename, sha256, row_count, status)
       VALUES ($1, $2, $3, 'uploaded')
       ON CONFLICT (sha256) DO UPDATE SET row_count = EXCLUDED.row_count
       RETURNING file_id`,
      [path.basename(fixturePath), sha256, tightening.cycles.length + leak.cycles.length],
    );
    const fileId = file.rows[0].file_id;
    const engines = [...new Set(profiles.flatMap(({ profile }) => profile.cycles.map((cycle) => cycle.engineSerial)))];
    for (const chunk of chunks(engines, 500)) {
      await client.query(
        `INSERT INTO engine (engine_serial) VALUES ${placeholders(chunk.length, 1)} ON CONFLICT DO NOTHING`,
        chunk,
      );
    }

    for (const { operationId, profile } of profiles) {
      const batch = await client.query<{ batch_id: string }>(
        `INSERT INTO load_batch (file_id, operation_id, mapping_ver, status)
         VALUES ($1, $2, 1, 'loading')
         ON CONFLICT (file_id, operation_id) DO UPDATE SET status = 'loading'
         RETURNING batch_id`,
        [fileId, operationId],
      );
      const batchId = batch.rows[0].batch_id;
      let inserted = 0;
      for (const chunk of chunks(profile.cycles, 200)) {
        const cycleValues = chunk.flatMap((cycle) => [
          cycle.operationId, cycle.engineSerial, cycle.attempt, cycle.enteredAt,
          cycle.startedAt, cycle.endedAt, cycle.cycleTimeS, cycle.result,
          cycle.resourceId, batchId, cycle.sourceRecordId,
        ]);
        const result = await client.query<{ cycle_id: string; source_record_id: string }>(
          `INSERT INTO cycle
           (operation_id, engine_serial, attempt, entered_at, started_at, ended_at,
            cycle_time_s, result, resource_id, batch_id, source_record_id)
           VALUES ${placeholders(chunk.length, 11)}
           ON CONFLICT (operation_id, source_record_id) DO NOTHING
           RETURNING cycle_id, source_record_id`,
          cycleValues,
        );
        inserted += result.rowCount ?? 0;
        const bySource = new Map(chunk.map((cycle) => [cycle.sourceRecordId, cycle]));
        const measurementValues = result.rows.flatMap(({ cycle_id: cycleId, source_record_id: sourceId }) =>
          bySource.get(sourceId)!.measurements.flatMap((m) => [
            cycleId, m.parameter, m.value, m.unit, m.lowerLimit, m.upperLimit, false,
          ]),
        );
        if (measurementValues.length > 0) {
          await client.query(
            `INSERT INTO measurement
             (cycle_id, parameter, value, unit, lower_limit, upper_limit, is_derived)
             VALUES ${placeholders(measurementValues.length / 7, 7)}
             ON CONFLICT (cycle_id, parameter) DO NOTHING`,
            measurementValues,
          );
        }
      }
      await client.query(
        `UPDATE load_batch SET status = 'committed', committed_at = now(), report = $2::jsonb
         WHERE batch_id = $1`,
        [batchId, JSON.stringify({ rowsRead: profile.cycles.length, insertedCycles: inserted, ignoredCells: profile.ignoredCells })],
      );
      console.log(`Operation ${operationId}: ${inserted} new cycles from ${profile.cycles.length} rows.`);
    }
    await client.query("UPDATE source_file SET status = 'loaded' WHERE file_id = $1", [fileId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

await main();

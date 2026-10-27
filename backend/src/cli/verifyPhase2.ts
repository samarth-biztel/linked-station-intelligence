import path from 'node:path';
import { createClient } from '../db.js';
import { readContext } from '../mapping/context.js';
import { profileWorkbook } from '../mapping/profile.js';
import { validateMapping } from '../mapping/validate.js';

const { context } = await readContext(path.resolve(process.env.CONTEXT_PATH ?? 'config/operations.yaml'));
const { profiles } = await profileWorkbook(
  path.resolve(process.env.FIXTURE_PATH ?? 'BiztelAI_Two_Station_Synthetic_Dataset_30_Days_3000_Engines_v2.xlsx'),
  context,
);
const client = createClient();
await client.connect();
try {
  const rows = await client.query<{
    operation_id: string;
    mapping: Record<string, unknown>;
    mapping_validation: {
      valid: boolean;
      rows_read: number;
      flagged_columns: { column: string; cells: string[] }[];
    };
    context_version: number;
  }>(`
    SELECT o.operation_id, o.mapping, o.mapping_validation, c.version AS context_version
    FROM operation o JOIN operation_context c ON c.context_id = o.context_id
    ORDER BY o.operation_id
  `);
  if (rows.rows.length !== 2) throw new Error(`Expected two mapped operations, found ${rows.rows.length}`);
  const expectedRows: Record<string, number> = { '10': 3090, '20': 3000 };
  for (const row of rows.rows) {
    if (!row.mapping_validation.valid || row.mapping_validation.rows_read !== expectedRows[row.operation_id]) {
      throw new Error(`Mapping gate failed for operation ${row.operation_id}`);
    }
    if (row.context_version !== 1) throw new Error('Unexpected context version');
    console.log(`Operation ${row.operation_id}: validated ${row.mapping_validation.rows_read} rows.`);
  }
  const flagged = rows.rows.find((row) => row.operation_id === '10')!.mapping_validation.flagged_columns
    .flatMap((column) => column.cells);
  if (flagged.join(',') !== 'O8,P8') throw new Error(`Expected stray cells O8,P8, found ${flagged.join(',')}`);
  console.log(`Untitled cells flagged: ${flagged.join(', ')}`);

  const tightening = profiles.find((item) => item.operationId === '10')!;
  const operation = context.operations.find((item) => item.id === '10')!;
  const badMapping = structuredClone(rows.rows.find((row) => row.operation_id === '10')!.mapping);
  (badMapping as { result: { column: string } }).result.column = 'Bolt 1 Torque (Nm)';
  const rejected = validateMapping(badMapping, tightening, operation);
  if (rejected.report.valid || rejected.report.parse_rate >= 0.99) {
    throw new Error('Whole-file validation accepted a wrong result column');
  }
  console.log('Wrong-result-column proposal rejected. Phase 2 gate passed.');
} finally {
  await client.end();
}

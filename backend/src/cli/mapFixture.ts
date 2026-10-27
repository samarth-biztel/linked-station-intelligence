import path from 'node:path';
import { createClient } from '../db.js';
import { readContext, registerContext } from '../mapping/context.js';
import { profileWorkbook } from '../mapping/profile.js';
import { mappingProposer } from '../mapping/proposer.js';
import { proposeValidateApply } from '../mapping/service.js';

const contextPath = path.resolve(process.env.CONTEXT_PATH ?? 'config/operations.yaml');
const fixturePath = path.resolve(process.env.FIXTURE_PATH ?? 'BiztelAI_Two_Station_Synthetic_Dataset_30_Days_3000_Engines_v2.xlsx');
const { context, sha256: contextSha } = await readContext(contextPath);
const { profiles, sha256: fileSha } = await profileWorkbook(fixturePath, context);
const proposer = mappingProposer();
console.log(`Mapping proposal source: ${proposer.source}`);
const client = createClient();
await client.connect();
try {
  const contextId = await registerContext(client, context, contextSha);
  for (const operation of context.operations) {
    const profile = profiles.find((item) => item.operationId === operation.id)!;
    const report = await proposeValidateApply(client, contextId, fileSha, operation, profile, proposer);
    console.log(`Operation ${operation.id}: ${report.parsed_rows}/${report.rows_read} rows parsed; flagged ${report.flagged_columns.flatMap((item) => item.cells).join(', ') || 'none'}.`);
  }
} finally {
  await client.end();
}

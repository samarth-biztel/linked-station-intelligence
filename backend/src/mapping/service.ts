import type pg from 'pg';
import type { OperationContext } from './context.js';
import type { SheetProfile } from './profile.js';
import type { MappingProposer } from './proposer.js';
import { validateMapping, type MappingReport } from './validate.js';

export async function proposeValidateApply(
  client: pg.Client,
  contextId: string,
  fileSha256: string,
  operation: OperationContext,
  profile: SheetProfile,
  proposer: MappingProposer,
): Promise<MappingReport> {
  let feedback: string[] = [];
  const attempts = proposer.source === 'llm' ? 3 : 1;
  for (let index = 0; index < attempts; index += 1) {
    let proposal: unknown;
    let report: MappingReport;
    try {
      proposal = await proposer.propose(profile, operation, feedback);
      ({ report } = validateMapping(proposal, profile, operation));
    } catch (error) {
      proposal = { proposal_error: String(error) };
      report = {
        valid: false, rows_read: profile.rowCount, parsed_rows: 0, parse_rate: 0,
        result_limit_agreement: 0, duration_agreement: 0, serial_pattern_agreement: 0,
        operation_check_agreement: 0, flagged_columns: profile.flaggedColumns,
        unmapped_columns: [], row_issues: [], errors: [String(error)],
      };
    }
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO mapping_attempt
         (context_id, operation_id, file_sha256, proposal_source, proposal, report, accepted)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
        [contextId, operation.id, fileSha256, proposer.source, JSON.stringify(proposal), JSON.stringify(report), report.valid],
      );
      if (report.valid) {
        await client.query(
          `UPDATE operation SET
             mapping_ver = CASE WHEN mapping = '{}'::jsonb OR mapping = $2::jsonb THEN mapping_ver ELSE mapping_ver + 1 END,
             mapping = $2::jsonb,
             mapping_validation = $3::jsonb,
             context_id = $4
           WHERE operation_id = $1`,
          [operation.id, JSON.stringify(proposal), JSON.stringify(report), contextId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    if (report.valid) return report;
    feedback = report.errors;
  }
  throw new Error(`Mapping failed for operation ${operation.id}: ${feedback.slice(0, 4).join('; ')}`);
}

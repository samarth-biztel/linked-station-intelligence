import type { OperationContext } from './context.js';
import { cellString, type FlaggedColumn, type SheetProfile } from './profile.js';
import { MappingSchema, type Mapping } from './schema.js';

export type MappingReport = {
  valid: boolean;
  rows_read: number;
  parsed_rows: number;
  parse_rate: number;
  result_limit_agreement: number;
  duration_agreement: number;
  serial_pattern_agreement: number;
  operation_check_agreement: number;
  flagged_columns: FlaggedColumn[];
  unmapped_columns: string[];
  row_issues: string[];
  errors: string[];
};

function number(raw: string): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function localMillis(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const value = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(value);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day ||
      date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) return null;
  return value;
}

function serialShape(serial: string): string {
  return [...serial].map((character) => /[A-Z]/.test(character) ? 'A' : /[0-9]/.test(character) ? '9' : character).join('');
}

function mappedColumns(mapping: Mapping): Set<string> {
  return new Set([
    mapping.operation_check.column, mapping.engine_key, mapping.attempt, mapping.resource,
    mapping.entered_at, mapping.started_at, mapping.ended_at, mapping.result.column,
    ...mapping.measurements.flatMap((item) => [item.column, item.lower_col, item.upper_col]),
    ...mapping.checks.map((item) => item.column), ...mapping.ignore,
  ].filter((item): item is string => Boolean(item)));
}

export function validateMapping(
  proposal: unknown,
  profile: SheetProfile,
  operation: OperationContext,
): { mapping: Mapping | null; report: MappingReport } {
  const errors: string[] = [];
  const parsed = MappingSchema.safeParse(proposal);
  if (!parsed.success) errors.push(...parsed.error.issues.map((issue) => issue.message));
  const mapping = parsed.success ? parsed.data : null;
  const empty: MappingReport = {
    valid: false, rows_read: profile.rowCount, parsed_rows: 0, parse_rate: 0,
    result_limit_agreement: 0, duration_agreement: 0, serial_pattern_agreement: 0,
    operation_check_agreement: 0, flagged_columns: profile.flaggedColumns,
    unmapped_columns: [], row_issues: [], errors,
  };
  if (!mapping) return { mapping: null, report: empty };
  if (mapping.operation_id !== operation.id || String(mapping.operation_check.must_equal) !== operation.id) {
    errors.push('Operation ID or operation check does not match context');
  }
  if (mapping.name !== operation.name) errors.push('Operation name does not match context');
  if (mapping.sheet !== profile.sheet.name) errors.push('Sheet does not match the profiled operation');
  if (mapping.timezone !== operation.timezone) errors.push('Time zone does not match registered context');
  const used = mappedColumns(mapping);
  for (const column of used) if (!profile.headers.has(column)) errors.push(`Missing column: ${column}`);
  const parameters = new Set(mapping.measurements.map((item) => item.parameter));
  for (const derived of mapping.derived) {
    const numericDifference = /^abs\(([a-z][a-z0-9_]*) - ([a-z][a-z0-9_]*)\)$/.exec(derived.expr);
    const timeDifference = /^seconds\((entered_at|started_at|ended_at) - (entered_at|started_at|ended_at)\)$/.exec(derived.expr);
    if (!(numericDifference && parameters.has(numericDifference[1]) && parameters.has(numericDifference[2])) &&
        !timeDifference) {
      errors.push(`Unsupported derived expression: ${derived.expr}`);
    }
  }
  for (const check of mapping.checks) {
    if (!['seconds(ended_at - started_at)', 'ended_at'].includes(check.equals)) {
      errors.push(`Unsupported check expression: ${check.equals}`);
    }
  }
  if (errors.length) return { mapping, report: empty };

  const read = (row: number, column: string): string =>
    cellString(profile.sheet.getRow(row).getCell(profile.headers.get(column)!));
  let parsedRows = 0;
  let limitAgreement = 0;
  let durationAgreement = 0;
  let serialAgreement = 0;
  let operationAgreement = 0;
  let referenceShape = '';
  const rowIssues: string[] = [];
  for (let row = 2; row <= profile.sheet.rowCount; row += 1) {
    const opMatches = read(row, mapping.operation_check.column) === operation.id;
    if (opMatches) operationAgreement += 1;
    const serial = read(row, mapping.engine_key).trim().toUpperCase();
    if (serial && !referenceShape) referenceShape = serialShape(serial);
    if (serial && serialShape(serial) === referenceShape) serialAgreement += 1;
    const entry = localMillis(read(row, mapping.entered_at));
    const start = localMillis(read(row, mapping.started_at));
    const end = localMillis(read(row, mapping.ended_at));
    const result = read(row, mapping.result.column);
    const recognized = mapping.result.ok.includes(result) || mapping.result.nok.includes(result);
    const attempt = mapping.attempt ? number(read(row, mapping.attempt)) : 1;
    const values = mapping.measurements.map((item) => ({
      value: number(read(row, item.column)),
      lower: item.lower_col ? number(read(row, item.lower_col)) : null,
      upper: item.upper_col ? number(read(row, item.upper_col)) : null,
      hasLower: Boolean(item.lower_col), hasUpper: Boolean(item.upper_col),
    }));
    const numbersValid = values.every((item) => item.value !== null &&
      (!item.hasLower || item.lower !== null) && (!item.hasUpper || item.upper !== null));
    const durationValid = mapping.checks.every((check) => {
      if (check.equals === 'seconds(ended_at - started_at)') {
        const supplied = number(read(row, check.column));
        return supplied !== null && start !== null && end !== null && Math.abs(supplied - (end - start) / 1000) < 0.001;
      }
      return end !== null && localMillis(read(row, check.column)) === end;
    });
    if (durationValid) durationAgreement += 1;
    if (numbersValid && recognized) {
      const withinLimits = values.every((item) =>
        (item.lower === null || item.value! >= item.lower) &&
        (item.upper === null || item.value! <= item.upper));
      if (mapping.result.ok.includes(result) === withinLimits) limitAgreement += 1;
    }
    if (opMatches && serial && entry !== null && start !== null && end !== null &&
        start >= entry && end >= start && recognized && numbersValid &&
        attempt !== null && Number.isInteger(attempt) && attempt >= 1 &&
        read(row, mapping.resource)) parsedRows += 1;
    else if (rowIssues.length < 20) rowIssues.push(`Unparsable or invalid record at ${profile.sheet.name}!${row}`);
  }
  const rows = profile.rowCount;
  const ratio = (count: number): number => rows ? count / rows : 0;
  const unmappedColumns = [...profile.headers.keys()].filter((header) => !used.has(header) &&
    Array.from({ length: rows }, (_, index) => read(index + 2, header)).some(Boolean));
  const report: MappingReport = {
    valid: false, rows_read: rows, parsed_rows: parsedRows, parse_rate: ratio(parsedRows),
    result_limit_agreement: ratio(limitAgreement), duration_agreement: ratio(durationAgreement),
    serial_pattern_agreement: ratio(serialAgreement), operation_check_agreement: ratio(operationAgreement),
    flagged_columns: profile.flaggedColumns, unmapped_columns: unmappedColumns, row_issues: rowIssues, errors,
  };
  if (rows < 1) errors.push('Sheet has no data rows');
  for (const [label, rate] of [
    ['parse rate', report.parse_rate], ['result and limit agreement', report.result_limit_agreement],
    ['duration agreement', report.duration_agreement], ['serial pattern', report.serial_pattern_agreement],
  ] as const) if (rate < 0.99) errors.push(`${label} below 99%: ${(rate * 100).toFixed(2)}%`);
  if (report.operation_check_agreement !== 1) errors.push('Operation number differs in some rows');
  report.valid = errors.length === 0;
  return { mapping, report };
}

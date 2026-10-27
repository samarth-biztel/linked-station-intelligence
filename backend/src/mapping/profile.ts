import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import type { LineContext } from './context.js';

export type FlaggedColumn = { column: string; cells: string[]; reason: string };
export type SheetProfile = {
  operationId: string;
  sheet: ExcelJS.Worksheet;
  headers: Map<string, number>;
  rowCount: number;
  sample: Record<string, string>[];
  flaggedColumns: FlaggedColumn[];
};

export function cellString(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (value instanceof Date) return value.toISOString();
  return cell.text.trim();
}

function profileSheet(sheet: ExcelJS.Worksheet, operationId: string): SheetProfile {
  const headers = new Map<string, number>();
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    const header = cellString(sheet.getRow(1).getCell(column)) || `Unnamed:${column - 1}`;
    if (headers.has(header)) throw new Error(`Duplicate header ${header} in ${sheet.name}`);
    headers.set(header, column);
  }
  const sample: Record<string, string>[] = [];
  for (let rowNumber = 2; rowNumber <= Math.min(sheet.rowCount, 6); rowNumber += 1) {
    const row: Record<string, string> = {};
    for (const [header, column] of headers) row[header] = cellString(sheet.getRow(rowNumber).getCell(column));
    sample.push(row);
  }
  const flaggedColumns: FlaggedColumn[] = [];
  for (const [header, column] of headers) {
    if (!header.startsWith('Unnamed:')) continue;
    const cells: string[] = [];
    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const cell = sheet.getRow(rowNumber).getCell(column);
      if (cellString(cell)) cells.push(cell.address);
    }
    if (cells.length) flaggedColumns.push({ column: header, cells, reason: 'untitled_with_data' });
  }
  return { operationId, sheet, headers, rowCount: sheet.rowCount - 1, sample, flaggedColumns };
}

export async function profileWorkbook(
  filePath: string,
  context: LineContext,
): Promise<{ sha256: string; profiles: SheetProfile[] }> {
  const bytes = await readFile(filePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer);
  const profiles: SheetProfile[] = [];
  for (const operation of context.operations) {
    const matches = workbook.worksheets.filter((sheet) => {
      let opColumn = -1;
      for (let column = 1; column <= sheet.columnCount; column += 1) {
        if (cellString(sheet.getRow(1).getCell(column)) === 'Operation Number') opColumn = column;
      }
      return opColumn > 0 && cellString(sheet.getRow(2).getCell(opColumn)) === operation.id;
    });
    if (matches.length !== 1) {
      throw new Error(`Expected one station sheet for operation ${operation.id}, found ${matches.length}`);
    }
    profiles.push(profileSheet(matches[0], operation.id));
  }
  return { sha256, profiles };
}

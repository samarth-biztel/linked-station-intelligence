import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const OperationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timezone: z.string().min(1),
  upstream: z.array(z.string()),
  downstream: z.array(z.string()),
});

const ContextSchema = z.object({
  line_id: z.string().min(1),
  operations: z.array(OperationSchema).min(1),
});

export type OperationContext = z.infer<typeof OperationSchema>;
export type LineContext = z.infer<typeof ContextSchema>;

export async function readContext(filePath: string): Promise<{ context: LineContext; sha256: string }> {
  const bytes = await readFile(filePath);
  const document = parseDocument(bytes.toString('utf8'), { uniqueKeys: true });
  if (document.errors.length) throw new Error(`Invalid YAML: ${document.errors[0].message}`);
  const context = ContextSchema.parse(document.toJS());
  const byId = new Map(context.operations.map((operation) => [operation.id, operation]));
  if (byId.size !== context.operations.length) throw new Error('Duplicate operation ID in context');
  for (const operation of context.operations) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: operation.timezone });
    } catch {
      throw new Error(`Invalid IANA time zone for operation ${operation.id}: ${operation.timezone}`);
    }
    for (const upstream of operation.upstream) {
      if (!byId.get(upstream)?.downstream.includes(operation.id)) {
        throw new Error(`Non-reciprocal link ${upstream} -> ${operation.id}`);
      }
    }
    for (const downstream of operation.downstream) {
      if (!byId.get(downstream)?.upstream.includes(operation.id)) {
        throw new Error(`Non-reciprocal link ${operation.id} -> ${downstream}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Operation context contains a cycle at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of byId.get(id)!.downstream) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const operation of context.operations) visit(operation.id);
  return { context, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function registerContext(
  client: pg.Client,
  context: LineContext,
  sha256: string,
): Promise<string> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [context.line_id]);
    const existing = await client.query<{ context_id: string; version: number }>(
      'SELECT context_id, version FROM operation_context WHERE sha256 = $1', [sha256],
    );
    let contextId: string;
    let version: number;
    if (existing.rows.length) {
      ({ context_id: contextId, version } = existing.rows[0]);
    } else {
      const inserted = await client.query<{ context_id: string; version: number }>(
        `INSERT INTO operation_context (line_id, version, sha256, content)
         VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM operation_context WHERE line_id = $1), $2, $3::jsonb)
         RETURNING context_id, version`,
        [context.line_id, sha256, JSON.stringify(context)],
      );
      ({ context_id: contextId, version } = inserted.rows[0]);
    }
    for (const operation of context.operations) {
      await client.query(
        `INSERT INTO operation (operation_id, name, context_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (operation_id) DO UPDATE SET
           name = EXCLUDED.name,
           context_id = EXCLUDED.context_id,
           mapping_validation = CASE
             WHEN operation.context_id IS DISTINCT FROM EXCLUDED.context_id
             THEN '{"valid":false,"reason":"context_changed"}'::jsonb
             ELSE operation.mapping_validation END`,
        [operation.id, operation.name, contextId],
      );
    }
    await client.query('COMMIT');
    console.log(`Registered context ${context.line_id} version ${version}.`);
    return contextId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

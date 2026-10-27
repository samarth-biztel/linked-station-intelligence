import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { OperationContext } from './context.js';
import type { SheetProfile } from './profile.js';

export type ProposalSource = 'llm' | 'config';

export interface MappingProposer {
  readonly source: ProposalSource;
  propose(profile: SheetProfile, operation: OperationContext, feedback: string[]): Promise<unknown>;
}

class ConfigMappingProposer implements MappingProposer {
  readonly source = 'config';
  async propose(_profile: SheetProfile, operation: OperationContext): Promise<unknown> {
    const filePath = path.resolve('config/fixture-mappings.json');
    const mappings = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
    if (!(operation.id in mappings)) throw new Error(`No configured fallback mapping for operation ${operation.id}`);
    return mappings[operation.id];
  }
}

class HostedMappingProposer implements MappingProposer {
  readonly source = 'llm';
  async propose(profile: SheetProfile, operation: OperationContext, feedback: string[]): Promise<unknown> {
    const endpoint = process.env.LLM_MAPPING_URL;
    const model = process.env.LLM_MODEL;
    if (!endpoint || !model) throw new Error('LLM_MAPPING_URL and LLM_MODEL are required');
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'Propose one operation mapping as a JSON object only. Use only supplied headers. Do not infer the time zone; copy it from context. Never use answer or conclusion columns. Derived expressions are metadata, not executable code.' },
          { role: 'user', content: JSON.stringify({
            operation, sheet: profile.sheet.name, headers: [...profile.headers.keys()],
            sample_rows: profile.sample, previous_validation_errors: feedback,
            required_shape: {
              operation_id: 'string', name: 'string', operation_check: { column: 'string', must_equal: 'number or string' },
              sheet: 'string', engine_key: 'string', attempt: 'optional string', resource: 'string',
              entered_at: 'string', started_at: 'string', ended_at: 'string', timezone: operation.timezone,
              result: { column: 'string', ok: ['OK'], nok: ['NOK'] },
              measurements: [{ column: 'string', parameter: 'snake_case', unit: 'string', lower_col: 'optional string', upper_col: 'optional string' }],
              derived: [], checks: [], ignore: [],
            },
          }) },
        ],
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Mapping model returned HTTP ${response.status}`);
    const data = await response.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Mapping model returned no text');
    return JSON.parse(content) as unknown;
  }
}

export function mappingProposer(): MappingProposer {
  return process.env.LLM_MAPPING_URL ? new HostedMappingProposer() : new ConfigMappingProposer();
}

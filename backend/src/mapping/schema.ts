import { z } from 'zod';

const MeasurementSchema = z.object({
  column: z.string().min(1),
  parameter: z.string().regex(/^[a-z][a-z0-9_]*$/),
  unit: z.string().min(1),
  lower_col: z.string().optional(),
  upper_col: z.string().optional(),
});

export const MappingSchema = z.object({
  operation_id: z.string().min(1),
  name: z.string().min(1),
  operation_check: z.object({ column: z.string().min(1), must_equal: z.union([z.string(), z.number()]) }),
  sheet: z.string().min(1),
  engine_key: z.string().min(1),
  attempt: z.string().optional(),
  resource: z.string().min(1),
  entered_at: z.string().min(1),
  started_at: z.string().min(1),
  ended_at: z.string().min(1),
  timezone: z.string().min(1),
  result: z.object({
    column: z.string().min(1),
    ok: z.array(z.string()).min(1),
    nok: z.array(z.string()).min(1),
  }),
  measurements: z.array(MeasurementSchema).min(1),
  derived: z.array(z.object({ parameter: z.string(), unit: z.string(), expr: z.string() })).default([]),
  checks: z.array(z.object({ column: z.string(), equals: z.string() })).default([]),
  ignore: z.array(z.string()).default([]),
}).superRefine((mapping, ctx) => {
  const parameters = mapping.measurements.map((item) => item.parameter);
  if (new Set(parameters).size !== parameters.length) {
    ctx.addIssue({ code: 'custom', message: 'Duplicate parameter name' });
  }
  if (mapping.result.ok.some((value) => mapping.result.nok.includes(value))) {
    ctx.addIssue({ code: 'custom', message: 'Result values overlap' });
  }
});

export type Mapping = z.infer<typeof MappingSchema>;

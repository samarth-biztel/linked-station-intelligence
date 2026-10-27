-- Phase 1: canonical operation, engine, cycle and measurement storage.
-- Additional link, staging, quarantine and findings tables follow in later phases.
CREATE TABLE IF NOT EXISTS source_file (
  file_id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count INT,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'loaded', 'failed'))
);

CREATE TABLE IF NOT EXISTS operation (
  operation_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mapping JSONB NOT NULL DEFAULT '{}'::jsonb,
  mapping_ver INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS load_batch (
  batch_id BIGSERIAL PRIMARY KEY,
  file_id BIGINT NOT NULL REFERENCES source_file(file_id),
  operation_id TEXT NOT NULL REFERENCES operation(operation_id),
  mapping_ver INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('loading', 'committed', 'failed')),
  report JSONB NOT NULL DEFAULT '{}'::jsonb,
  committed_at TIMESTAMPTZ,
  UNIQUE (file_id, operation_id)
);

CREATE TABLE IF NOT EXISTS engine (
  engine_serial TEXT PRIMARY KEY,
  first_seen_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS cycle (
  cycle_id BIGSERIAL PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES operation(operation_id),
  engine_serial TEXT REFERENCES engine(engine_serial),
  attempt INT NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  entered_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  cycle_time_s NUMERIC,
  result TEXT NOT NULL CHECK (result IN ('OK', 'NOK')),
  resource_id TEXT,
  batch_id BIGINT REFERENCES load_batch(batch_id),
  source_record_id TEXT NOT NULL,
  UNIQUE (operation_id, source_record_id)
);

CREATE INDEX IF NOT EXISTS cycle_engine_operation_attempt_idx
  ON cycle (engine_serial, operation_id, attempt);

CREATE TABLE IF NOT EXISTS measurement (
  measurement_id BIGSERIAL PRIMARY KEY,
  cycle_id BIGINT NOT NULL REFERENCES cycle(cycle_id) ON DELETE CASCADE,
  parameter TEXT NOT NULL,
  value NUMERIC NOT NULL,
  unit TEXT,
  lower_limit NUMERIC,
  upper_limit NUMERIC,
  is_derived BOOLEAN NOT NULL DEFAULT FALSE,
  UNIQUE (cycle_id, parameter)
);

CREATE INDEX IF NOT EXISTS measurement_parameter_cycle_idx
  ON measurement (parameter, cycle_id);

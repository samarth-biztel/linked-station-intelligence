-- Phase 2: versioned source context and validated operation mappings.
CREATE TABLE operation_context (
  context_id BIGSERIAL PRIMARY KEY,
  line_id TEXT NOT NULL,
  version INT NOT NULL CHECK (version >= 1),
  sha256 TEXT NOT NULL UNIQUE,
  content JSONB NOT NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (line_id, version)
);

ALTER TABLE operation
  ADD COLUMN context_id BIGINT REFERENCES operation_context(context_id),
  ADD COLUMN mapping_validation JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE load_batch
  ADD COLUMN context_id BIGINT REFERENCES operation_context(context_id);

CREATE TABLE mapping_attempt (
  attempt_id BIGSERIAL PRIMARY KEY,
  context_id BIGINT NOT NULL REFERENCES operation_context(context_id),
  operation_id TEXT NOT NULL REFERENCES operation(operation_id),
  file_sha256 TEXT NOT NULL,
  proposal_source TEXT NOT NULL CHECK (proposal_source IN ('llm', 'config')),
  proposal JSONB NOT NULL,
  report JSONB NOT NULL,
  accepted BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proposed v1 design only; not a production migration.
-- Enable foreign keys on EVERY connection before starting a transaction.
PRAGMA foreign_keys = ON;
CREATE TABLE schema_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version > 0)
);
INSERT INTO schema_meta VALUES (1, 1);
CREATE TABLE learners (
  study_id TEXT NOT NULL,
  learner_code TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (study_id, learner_code)
);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  study_id TEXT NOT NULL,
  learner_code TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  app_version TEXT NOT NULL,
  content_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('active','completed','interrupted')),
  FOREIGN KEY (study_id, learner_code) REFERENCES learners(study_id, learner_code)
);
CREATE TABLE attempts (
  event_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  sequence_no INTEGER NOT NULL CHECK (sequence_no >= 0),
  activity_id TEXT NOT NULL,
  activity_version TEXT NOT NULL,
  instrument_version TEXT,
  event_kind TEXT NOT NULL CHECK (event_kind IN
    ('puzzle_result','quiz_answer','pretest_answer','posttest_answer')),
  answer_code TEXT,
  correct INTEGER CHECK (correct IN (0,1)),
  retry_no INTEGER NOT NULL DEFAULT 0 CHECK (retry_no >= 0),
  hints_used INTEGER NOT NULL DEFAULT 0 CHECK (hints_used >= 0),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  occurred_at TEXT NOT NULL,
  UNIQUE (session_id, sequence_no)
);
CREATE TABLE progress (
  study_id TEXT NOT NULL,
  learner_code TEXT NOT NULL,
  level_id TEXT NOT NULL,
  content_version TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0,1)),
  checkpoint_payload TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (study_id, learner_code, level_id),
  FOREIGN KEY (study_id, learner_code) REFERENCES learners(study_id, learner_code)
);
CREATE TABLE export_batches (
  export_id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  record_count INTEGER NOT NULL CHECK (record_count >= 0),
  digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('prepared','written','received','failed')),
  receipt_id TEXT
);
CREATE TABLE export_events (
  export_id TEXT NOT NULL REFERENCES export_batches(export_id),
  event_id TEXT NOT NULL REFERENCES attempts(event_id),
  PRIMARY KEY (export_id, event_id)
);
CREATE INDEX attempts_by_session ON attempts(session_id);
CREATE INDEX sessions_by_learner ON sessions(study_id, learner_code);
-- Code normalization, payload validation, event immutability, encryption/access
-- policy and conflict-safe importer behavior require application-level checks.

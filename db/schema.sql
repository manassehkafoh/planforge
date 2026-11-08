-- PlanForge physical data model - PostgreSQL 16
-- Conventions: UUIDv7 primary keys (time-ordered, generated in app; gen_random_uuid() fallback),
-- every tenant-owned table carries tenant_id and is protected by Row-Level Security,
-- timestamps are timestamptz (UTC), scheduling instants are stored as *naive local* timestamp
-- (see docs/06 section 2) in columns suffixed _local, durations/work are integer minutes.
-- See docs/05-domain-and-data-model.md for the explanatory notes for every table.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE SCHEMA IF NOT EXISTS pf;
SET search_path = pf, public;

-- ------------------------------------------------------------------------------------------
-- Enumerations
-- ------------------------------------------------------------------------------------------
CREATE TYPE dep_type        AS ENUM ('FS','SS','FF','SF');
CREATE TYPE constraint_type AS ENUM ('ASAP','ALAP','MSO','MFO','SNET','SNLT','FNET','FNLT');
CREATE TYPE sched_mode      AS ENUM ('AUTO','MANUAL');
CREATE TYPE task_kind       AS ENUM ('FIXED_UNITS','FIXED_DURATION','FIXED_WORK');
CREATE TYPE resource_kind   AS ENUM ('WORK','MATERIAL','COST');
CREATE TYPE member_role     AS ENUM ('ORG_ADMIN','PORTFOLIO_MANAGER','PROJECT_MANAGER','SCHEDULER','TEAM_MEMBER','VIEWER');
CREATE TYPE job_status      AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED');

-- ------------------------------------------------------------------------------------------
-- Identity & tenancy
-- ------------------------------------------------------------------------------------------
CREATE TABLE tenant (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  slug          text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  data_region   text NOT NULL DEFAULT 'eu',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  oidc_subject  text NOT NULL,                 -- 'sub' claim from the IdP; no passwords are stored
  email         text NOT NULL,
  display_name  text NOT NULL,
  is_active     boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, oidc_subject),
  UNIQUE (tenant_id, email)
);

-- ------------------------------------------------------------------------------------------
-- Portfolio
-- ------------------------------------------------------------------------------------------
CREATE TABLE portfolio (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  name       text NOT NULL,
  owner_id   uuid REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  name        text NOT NULL,
  base_id     uuid REFERENCES calendar(id),     -- derived calendars inherit from a base
  time_zone   text NOT NULL DEFAULT 'UTC',      -- IANA name
  week        jsonb NOT NULL,                   -- [[{"startMin":480,"endMin":720},...] x7], index 0 = Sunday
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(week) = 'array' AND jsonb_array_length(week) = 7)
);

CREATE TABLE calendar_exception (
  calendar_id uuid NOT NULL REFERENCES calendar(id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  day         date NOT NULL,
  ranges      jsonb NOT NULL DEFAULT '[]',      -- empty array = non-working day
  label       text,
  PRIMARY KEY (calendar_id, day)
);

CREATE TABLE project (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  portfolio_id    uuid REFERENCES portfolio(id),
  name            text NOT NULL,
  calendar_id     uuid NOT NULL REFERENCES calendar(id),
  start_local     timestamp NOT NULL,           -- naive local wall-clock
  deadline_local  timestamp,
  currency        char(3) NOT NULL DEFAULT 'USD',
  default_task_kind task_kind NOT NULL DEFAULT 'FIXED_UNITS',
  plan_version    bigint NOT NULL DEFAULT 0,    -- optimistic concurrency token for the whole Plan aggregate
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('DRAFT','ACTIVE','ON_HOLD','CLOSED','ARCHIVED')),
  created_by      uuid REFERENCES app_user(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX project_tenant_idx ON project (tenant_id, portfolio_id);

CREATE TABLE project_member (
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  role        member_role NOT NULL,
  PRIMARY KEY (project_id, user_id)
);

-- ------------------------------------------------------------------------------------------
-- Planning (Plan aggregate)
-- ------------------------------------------------------------------------------------------
CREATE TABLE task (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  project_id       uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_id        uuid REFERENCES task(id) ON DELETE CASCADE,
  sort_key         text NOT NULL COLLATE "C",   -- fractional index: O(1) reorder without renumbering siblings
  wbs              text,                        -- derived, denormalised for display/search
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  notes            text,
  duration_min     integer NOT NULL DEFAULT 0 CHECK (duration_min >= 0),
  mode             sched_mode NOT NULL DEFAULT 'AUTO',
  kind             task_kind NOT NULL DEFAULT 'FIXED_UNITS',
  effort_driven    boolean NOT NULL DEFAULT false,
  constraint_type  constraint_type NOT NULL DEFAULT 'ASAP',
  constraint_local timestamp,
  calendar_id      uuid REFERENCES calendar(id),
  percent_complete numeric(5,4) NOT NULL DEFAULT 0 CHECK (percent_complete BETWEEN 0 AND 1),
  actual_start_local  timestamp,
  actual_finish_local timestamp,
  est_optimistic_min  integer,                  -- three-point estimate for Monte Carlo
  est_likely_min      integer,
  est_pessimistic_min integer,
  custom           jsonb NOT NULL DEFAULT '{}', -- values for custom_field_def, validated in the app layer
  -- scheduler output (derived; recomputed by the engine, never edited by users)
  es_local timestamp, ef_local timestamp, ls_local timestamp, lf_local timestamp,
  total_float_min integer, free_float_min integer, is_critical boolean NOT NULL DEFAULT false,
  version          bigint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (constraint_type IN ('ASAP','ALAP') OR constraint_local IS NOT NULL),
  CHECK ((est_optimistic_min IS NULL) = (est_likely_min IS NULL) AND (est_likely_min IS NULL) = (est_pessimistic_min IS NULL)),
  CHECK (est_optimistic_min IS NULL OR est_optimistic_min <= est_likely_min AND est_likely_min <= est_pessimistic_min)
);
CREATE INDEX task_project_order_idx ON task (project_id, parent_id, sort_key);
CREATE INDEX task_critical_idx ON task (project_id) WHERE is_critical;
CREATE INDEX task_custom_gin ON task USING gin (custom jsonb_path_ops);

CREATE TABLE task_link (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  pred_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  succ_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  type        dep_type NOT NULL DEFAULT 'FS',
  lag_min     integer NOT NULL DEFAULT 0,       -- negative = lead
  CHECK (pred_id <> succ_id),
  UNIQUE (pred_id, succ_id, type)
);
CREATE INDEX task_link_succ_idx ON task_link (project_id, succ_id);
CREATE INDEX task_link_pred_idx ON task_link (project_id, pred_id);

CREATE TABLE custom_field_def (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  entity      text NOT NULL CHECK (entity IN ('TASK','RESOURCE','PROJECT')),
  key         text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,40}$'),
  label       text NOT NULL,
  data_type   text NOT NULL CHECK (data_type IN ('TEXT','NUMBER','DATE','BOOLEAN','ENUM','COST','DURATION')),
  options     jsonb,
  formula     text,                              -- sandboxed expression, see docs/06 section 9
  UNIQUE (tenant_id, entity, key)
);

-- ------------------------------------------------------------------------------------------
-- Resources & assignments
-- ------------------------------------------------------------------------------------------
CREATE TABLE resource (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  user_id      uuid REFERENCES app_user(id),
  name         text NOT NULL,
  kind         resource_kind NOT NULL DEFAULT 'WORK',
  max_units    numeric(6,2) NOT NULL DEFAULT 1.00 CHECK (max_units >= 0),  -- 1.00 = 100 %
  calendar_id  uuid REFERENCES calendar(id),
  custom       jsonb NOT NULL DEFAULT '{}',
  is_active    boolean NOT NULL DEFAULT true
);

CREATE TABLE resource_rate (
  resource_id   uuid NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  effective_from date NOT NULL,
  std_rate_per_hour numeric(14,4) NOT NULL CHECK (std_rate_per_hour >= 0),
  ovt_rate_per_hour numeric(14,4) CHECK (ovt_rate_per_hour >= 0),
  per_use_cost  numeric(14,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (resource_id, effective_from)
);

CREATE TABLE assignment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id     uuid NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES resource(id),
  units       numeric(6,2) NOT NULL DEFAULT 1.00 CHECK (units > 0),
  work_min    integer NOT NULL DEFAULT 0 CHECK (work_min >= 0),
  actual_work_min integer NOT NULL DEFAULT 0 CHECK (actual_work_min >= 0),
  leveling_delay_min integer NOT NULL DEFAULT 0 CHECK (leveling_delay_min >= 0),
  UNIQUE (task_id, resource_id)
);
CREATE INDEX assignment_resource_idx ON assignment (resource_id);

-- Timephased work/cost: one row per assignment per day (sparse). Source of truth for histograms and EVM.
CREATE TABLE assignment_timephase (
  assignment_id uuid NOT NULL REFERENCES assignment(id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  day           date NOT NULL,
  planned_work_min integer NOT NULL DEFAULT 0,
  actual_work_min  integer NOT NULL DEFAULT 0,
  planned_cost  numeric(16,4) NOT NULL DEFAULT 0,
  actual_cost   numeric(16,4) NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, day)
) PARTITION BY HASH (assignment_id);
CREATE TABLE assignment_timephase_p0 PARTITION OF assignment_timephase FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE assignment_timephase_p1 PARTITION OF assignment_timephase FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE assignment_timephase_p2 PARTITION OF assignment_timephase FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE assignment_timephase_p3 PARTITION OF assignment_timephase FOR VALUES WITH (MODULUS 4, REMAINDER 3);
CREATE INDEX timephase_day_idx ON assignment_timephase (day);

-- ------------------------------------------------------------------------------------------
-- Baselines, scenarios, risk
-- ------------------------------------------------------------------------------------------
CREATE TABLE baseline (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  number      smallint NOT NULL CHECK (number BETWEEN 0 AND 10),   -- 0 = primary baseline
  label       text,
  plan_version bigint NOT NULL,
  saved_by    uuid REFERENCES app_user(id),
  saved_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);

CREATE TABLE baseline_task (
  baseline_id  uuid NOT NULL REFERENCES baseline(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL,                    -- no FK: the task may be deleted later; baseline is immutable history
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  start_local  timestamp, finish_local timestamp,
  duration_min integer, work_min integer, cost numeric(16,4),
  PRIMARY KEY (baseline_id, task_id)
);

CREATE TABLE scenario (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name        text NOT NULL,
  base_plan_version bigint NOT NULL,
  patch       jsonb NOT NULL,                    -- list of commands applied on top of the base plan (what-if branch)
  result      jsonb,                             -- cached ScheduleResult summary
  created_by  uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risk_run (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  plan_version bigint NOT NULL,
  iterations  integer NOT NULL CHECK (iterations BETWEEN 100 AND 100000),
  seed        bigint NOT NULL,
  status      job_status NOT NULL DEFAULT 'QUEUED',
  p50_local   timestamp, p80_local timestamp, p90_local timestamp,
  criticality jsonb,                             -- {taskId: 0..1}
  requested_by uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

-- ------------------------------------------------------------------------------------------
-- Collaboration, integration, audit
-- ------------------------------------------------------------------------------------------
CREATE TABLE plan_op (                           -- append-only operation log (sequenced per project)
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  seq         bigint NOT NULL,
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  actor_id    uuid REFERENCES app_user(id),
  client_op_id uuid NOT NULL,                    -- idempotency key supplied by the client
  command     jsonb NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, seq),
  UNIQUE (project_id, client_op_id)
);

CREATE TABLE comment (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id     uuid REFERENCES task(id) ON DELETE CASCADE,
  author_id   uuid NOT NULL REFERENCES app_user(id),
  body        text NOT NULL CHECK (length(body) <= 10000),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_subscription (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid REFERENCES project(id) ON DELETE CASCADE,
  url         text NOT NULL CHECK (url ~ '^https://'),
  events      text[] NOT NULL,
  secret_ref  text NOT NULL,                     -- reference into the secrets manager, never the secret itself
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE outbox (                            -- transactional outbox -> message bus / webhooks / analytics CDC
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  aggregate   text NOT NULL,
  aggregate_id uuid NOT NULL,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE import_job (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid REFERENCES project(id) ON DELETE SET NULL,
  format      text NOT NULL CHECK (format IN ('MSPDI','MPP','LEGACY_POD','PLAN','CSV')),
  object_key  text NOT NULL,                     -- location in object storage (quarantine bucket until scanned)
  status      job_status NOT NULL DEFAULT 'QUEUED',
  report      jsonb,                             -- fidelity report: mapped / approximated / dropped fields
  requested_by uuid REFERENCES app_user(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_event (                       -- immutable, hash-chained
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id    uuid,
  action      text NOT NULL,
  resource    text NOT NULL,
  resource_id uuid,
  ip          inet,
  detail      jsonb NOT NULL DEFAULT '{}',
  prev_hash   bytea,
  hash        bytea NOT NULL
);
CREATE INDEX audit_tenant_time_idx ON audit_event (tenant_id, occurred_at DESC);

CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- ------------------------------------------------------------------------------------------
-- Row-Level Security: tenant isolation enforced in the database, not only in application code.
-- The app sets  SET LOCAL pf.tenant_id = '<uuid>'  at the start of every transaction.
-- ------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'app_user','portfolio','calendar','calendar_exception','project','project_member','task','task_link',
    'custom_field_def','resource','resource_rate','assignment','assignment_timephase','baseline','baseline_task',
    'scenario','risk_run','plan_op','comment','webhook_subscription','import_job'])
  LOOP
    EXECUTE format('ALTER TABLE pf.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE pf.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON pf.%I
                      USING (tenant_id = current_setting('pf.tenant_id', true)::uuid)
                      WITH CHECK (tenant_id = current_setting('pf.tenant_id', true)::uuid)$p$, t);
  END LOOP;
END $$;

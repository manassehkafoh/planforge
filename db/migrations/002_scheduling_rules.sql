-- Migration 002: columns and policies required by the v0.2 scheduling engine and the reference server.
-- Idempotent where practical; run after db/schema.sql.
SET search_path = pf, public;

-- Scheduling rules
ALTER TABLE task
  ADD COLUMN IF NOT EXISTS priority            smallint NOT NULL DEFAULT 500 CHECK (priority BETWEEN 0 AND 1000),
  ADD COLUMN IF NOT EXISTS fixed_cost          numeric(16,4) NOT NULL DEFAULT 0 CHECK (fixed_cost >= 0),
  ADD COLUMN IF NOT EXISTS work_min            integer CHECK (work_min >= 0),
  ADD COLUMN IF NOT EXISTS manual_start_local  timestamp,
  ADD COLUMN IF NOT EXISTS manual_finish_local timestamp,
  ADD COLUMN IF NOT EXISTS leveling_delay_min  integer NOT NULL DEFAULT 0 CHECK (leveling_delay_min >= 0),
  ADD COLUMN IF NOT EXISTS is_near_critical    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver              jsonb,
  ADD COLUMN IF NOT EXISTS state               text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','PROGRESS','DONE')),
  ADD COLUMN IF NOT EXISTS is_summary          boolean NOT NULL DEFAULT false;
ALTER TABLE task ADD CONSTRAINT task_manual_needs_start CHECK (mode <> 'MANUAL' OR manual_start_local IS NOT NULL);
ALTER TABLE task ADD CONSTRAINT task_fixedwork_needs_work CHECK (kind <> 'FIXED_WORK' OR work_min IS NOT NULL);

ALTER TABLE task_link
  ADD COLUMN IF NOT EXISTS lag_basis text NOT NULL DEFAULT 'PROJECT' CHECK (lag_basis IN ('PROJECT','PRED','SUCC'));

ALTER TABLE project
  ADD COLUMN IF NOT EXISTS status_date_local   timestamp,
  ADD COLUMN IF NOT EXISTS near_critical_min   integer NOT NULL DEFAULT 960 CHECK (near_critical_min >= 0);

-- the engine drives overtime-free levelling from the TASK; the per-assignment column is retained for import fidelity only
COMMENT ON COLUMN assignment.leveling_delay_min IS 'import fidelity only; the engine reads task.leveling_delay_min';
COMMENT ON COLUMN resource_rate.ovt_rate_per_hour IS 'reserved: overtime is not modelled in v0.2 (see docs/17 gap register G-14)';

-- Gap closure G-01: audit_event and outbox were not tenant-isolated by RLS. Now they are.
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_event
  USING (tenant_id = current_setting('pf.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('pf.tenant_id', true)::uuid);
ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = current_setting('pf.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('pf.tenant_id', true)::uuid);

-- One-time realtime tickets (single use, short lived, bound to user + project)
CREATE TABLE IF NOT EXISTS realtime_ticket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  project_id  uuid NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
ALTER TABLE realtime_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON realtime_ticket
  USING (tenant_id = current_setting('pf.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('pf.tenant_id', true)::uuid);

-- Risk runs executed by the reference server keep their result inline
ALTER TABLE risk_run ADD COLUMN IF NOT EXISTS result jsonb;

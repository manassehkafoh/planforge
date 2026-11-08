-- Development / e2e seed: two tenants, deterministic ids, one standard calendar each, users for every role.
-- Run as a privileged role (tenants and users are provisioned by the identity pipeline, not by the API).
SET search_path = pf, public;
INSERT INTO tenant (id, name, slug) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'Acme Delivery', 'acme'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'Birch Works', 'birch');
SELECT set_config('pf.tenant_id', 'aaaaaaaa-0000-4000-8000-000000000001', false);
INSERT INTO calendar (id, tenant_id, name, week) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Standard 5x8',
   '[[],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[]]');
INSERT INTO calendar_exception (calendar_id, tenant_id, day, ranges, label) VALUES
  ('ca000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '2026-12-25', '[]', 'Christmas Day');
INSERT INTO app_user (id, tenant_id, oidc_subject, email, display_name) VALUES
  ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'admin-a',     'admin@acme.test',     'Ada Admin'),
  ('a1000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'portfolio-a', 'portfolio@acme.test', 'Pia Portfolio'),
  ('a1000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'pm-a',        'pm@acme.test',        'Percy Manager'),
  ('a1000000-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'sched-a',     'sched@acme.test',     'Sam Scheduler'),
  ('a1000000-0000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'member-a',    'member@acme.test',    'Tess Member'),
  ('a1000000-0000-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'viewer-a',    'viewer@acme.test',    'Vic Viewer');
SELECT set_config('pf.tenant_id', 'bbbbbbbb-0000-4000-8000-000000000001', false);
INSERT INTO calendar (id, tenant_id, name, week) VALUES
  ('cb000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'Standard 5x8',
   '[[],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[{"startMin":480,"endMin":720},{"startMin":780,"endMin":1020}],[]]');
INSERT INTO app_user (id, tenant_id, oidc_subject, email, display_name) VALUES
  ('b1000000-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'pm-b', 'pm@birch.test', 'Bea Manager');

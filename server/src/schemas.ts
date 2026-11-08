import { z } from 'zod';

const uuid = z.string().uuid();
/** naive local date-time: 2026-11-09T08:00[:00] (no zone designator by contract) */
export const localDt = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/, 'expected naive local date-time, e.g. 2026-11-09T08:00:00');
const mins = z.number().int().min(0).max(10_000_000);
const constraint = z.object({ type: z.enum(['ASAP', 'ALAP', 'MSO', 'MFO', 'SNET', 'SNLT', 'FNET', 'FNLT']), date: localDt.optional() }).strict();

const taskFields = {
  name: z.string().min(1).max(500),
  notes: z.string().max(10_000).optional(),
  parentId: uuid.nullable().optional(),
  durationMin: mins,
  mode: z.enum(['AUTO', 'MANUAL']).optional(),
  kind: z.enum(['FIXED_UNITS', 'FIXED_DURATION', 'FIXED_WORK']).optional(),
  effortDriven: z.boolean().optional(),
  constraint: constraint.optional(),
  calendarId: uuid.nullable().optional(),
  percentComplete: z.number().min(0).max(1).optional(),
  actualStart: localDt.nullable().optional(),
  actualFinish: localDt.nullable().optional(),
  manualStart: localDt.nullable().optional(),
  manualFinish: localDt.nullable().optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  levelingDelayMin: mins.optional(),
  fixedCost: z.number().min(0).max(1e12).optional(),
  workMin: mins.nullable().optional(),
  estimate: z.object({ optimisticMin: mins, likelyMin: mins, pessimisticMin: mins }).strict().nullable().optional(),
  custom: z.record(z.unknown()).optional(),
};
export const TaskCreate = z.object({ id: uuid, ...taskFields }).strict();
export const TaskPatch = z.object({ ...Object.fromEntries(Object.entries(taskFields).filter(([k]) => k !== 'parentId').map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) }).strict();

const Link = z.object({ id: uuid, predId: uuid, succId: uuid, type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(), lagMin: z.number().int().min(-10_000_000).max(10_000_000).optional(), lagBasis: z.enum(['PROJECT', 'PRED', 'SUCC']).optional() }).strict();

export const Command = z.discriminatedUnion('op', [
  z.object({ op: z.literal('addTask'), task: TaskCreate, afterId: uuid.nullable().optional() }).strict(),
  z.object({ op: z.literal('updateTask'), id: uuid, patch: TaskPatch }).strict(),
  z.object({ op: z.literal('moveTask'), id: uuid, newParentId: uuid.nullable().optional(), afterId: uuid.nullable().optional() }).strict(),
  z.object({ op: z.literal('deleteTask'), id: uuid }).strict(),
  z.object({ op: z.literal('addLink'), link: Link }).strict(),
  z.object({ op: z.literal('updateLink'), id: uuid, patch: z.object({ type: z.enum(['FS', 'SS', 'FF', 'SF']).optional(), lagMin: z.number().int().optional(), lagBasis: z.enum(['PROJECT', 'PRED', 'SUCC']).optional() }).strict() }).strict(),
  z.object({ op: z.literal('removeLink'), id: uuid }).strict(),
  z.object({ op: z.literal('addAssignment'), assignment: z.object({ id: uuid, taskId: uuid, resourceId: uuid, units: z.number().positive().max(100).optional() }).strict() }).strict(),
  z.object({ op: z.literal('updateAssignment'), id: uuid, patch: z.object({ units: z.number().positive().max(100) }).strict() }).strict(),
  z.object({ op: z.literal('removeAssignment'), id: uuid }).strict(),
  z.object({ op: z.literal('setProject'), patch: z.object({ startDate: localDt.optional(), deadline: localDt.nullable().optional(), statusDate: localDt.nullable().optional(), nearCriticalMin: mins.optional() }).strict() }).strict(),
]);
export type Cmd = z.infer<typeof Command>;

export const CommandBatch = z.object({
  clientOpId: uuid,
  expectedPlanVersion: z.number().int().min(0),
  commands: z.array(Command).min(1).max(1000),
}).strict();

export const ProjectCreate = z.object({
  name: z.string().min(1).max(200), startDate: localDt, calendarId: uuid, deadline: localDt.optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), portfolioId: uuid.optional(),
}).strict();
export const ProjectPatch = z.object({ name: z.string().min(1).max(200).optional(), status: z.enum(['DRAFT', 'ACTIVE', 'ON_HOLD', 'CLOSED']).optional() }).strict();

export const ResourceCreate = z.object({
  name: z.string().min(1).max(200), kind: z.enum(['WORK', 'MATERIAL', 'COST']).optional(),
  maxUnits: z.number().positive().max(10_000).optional(), calendarId: uuid.optional(), userId: uuid.optional(),
  rates: z.array(z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), stdPerHour: z.number().min(0).max(1e9), perUse: z.number().min(0).max(1e9).optional() }).strict()).max(50).optional(),
}).strict();

export const LevelRequest = z.object({
  apply: z.boolean().optional(), withinFloatOnly: z.boolean().optional(), order: z.enum(['PRIORITY_FLOAT', 'START', 'ID']).optional(),
  clientOpId: uuid.optional(), expectedPlanVersion: z.number().int().min(0).optional(),
}).strict();
export const RiskRequest = z.object({ iterations: z.number().int().min(100).max(20_000).optional(), seed: z.number().int().min(0).max(2 ** 31).optional() }).strict();
export const BaselineCreate = z.object({ number: z.number().int().min(0).max(10).optional(), label: z.string().max(120).optional() }).strict();
export const ScenarioCreate = z.object({ name: z.string().min(1).max(120), commands: z.array(Command).min(1).max(1000) }).strict();
export const TicketRequest = z.object({ projectId: uuid }).strict();
export const MemberRole = z.object({ role: z.enum(['ORG_ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER', 'SCHEDULER', 'TEAM_MEMBER', 'VIEWER']) }).strict();

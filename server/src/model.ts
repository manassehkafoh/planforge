import { randomUUID } from 'node:crypto';
import { effort, type AssignmentIn, type DepType, type Edit, type LagBasis, type ProjectIn, type TaskIn, type CalendarDef, type ResourceIn } from '../../engine/src/index.ts';
import { Problem } from './errors.ts';
import type { Cmd } from './schemas.ts';

export const toMs = (s: string): number => Date.parse(s.length === 16 ? `${s}:00Z` : `${s}Z`);
export const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 19);

export interface TaskRec extends TaskIn { notes?: string; sortKey: string; custom?: Record<string, unknown> }
export interface LinkRec { id: string; pred: string; succ: string; type: DepType; lagMin: number; lagBasis: LagBasis }
export type RowOp =
  | { t: 'task.insert'; rec: TaskRec }
  | { t: 'task.update'; id: string; rec: TaskRec }
  | { t: 'task.delete'; id: string }
  | { t: 'link.insert'; rec: LinkRec } | { t: 'link.update'; rec: LinkRec } | { t: 'link.delete'; id: string }
  | { t: 'asg.insert'; rec: AssignmentIn } | { t: 'asg.update'; rec: AssignmentIn } | { t: 'asg.delete'; id: string }
  | { t: 'project.update' };

export interface ProjectRec { id: string; startDate: number; deadline?: number; statusDate?: number; nearCriticalMin: number; calendarId: string }

const ALPHA = '0123456789abcdefghijklmnopqrstuvwxyz';
/** fractional index key strictly between a and b (b === null = unbounded) */
export function keyBetween(a: string | null, b: string | null): string {
  const A = a ?? '';
  let res = '', upper = b;
  for (let i = 0; ; i++) {
    const da = i < A.length ? ALPHA.indexOf(A[i]) : 0;
    const db = upper !== null && i < upper.length ? ALPHA.indexOf(upper[i]) : upper !== null && i >= upper.length ? 0 : ALPHA.length;
    if (upper !== null && da === db) { res += ALPHA[da]; continue; }
    if (db - da > 1) return res + ALPHA[(da + db) >> 1];
    res += ALPHA[da];
    upper = null;
  }
}

/**
 * The entered plan (what users typed), kept separately from the engine's derived effective durations.
 * apply() validates a command against the model, mutates it, and returns the engine edits and row operations that
 * realise it. Nothing here touches the database, so scenario/preview runs can use a cloned model.
 */
export class PlanModel {
  project: ProjectRec;
  tasks = new Map<string, TaskRec>();
  links = new Map<string, LinkRec>();
  asg = new Map<string, AssignmentIn>();
  calendars: CalendarDef[] = [];
  resourceIds = new Set<string>();

  constructor(project: ProjectRec) { this.project = project; }

  clone(): PlanModel {
    const m = new PlanModel({ ...this.project });
    for (const [k, v] of this.tasks) m.tasks.set(k, { ...v });
    for (const [k, v] of this.links) m.links.set(k, { ...v });
    for (const [k, v] of this.asg) m.asg.set(k, { ...v });
    m.calendars = this.calendars; m.resourceIds = this.resourceIds;
    return m;
  }

  isSummary(id: string): boolean { for (const t of this.tasks.values()) if (t.parentId === id) return true; return false; }
  childrenOf(id: string | null): TaskRec[] { return [...this.tasks.values()].filter((t) => (t.parentId ?? null) === id).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)); }
  asgOfTask(taskId: string): AssignmentIn[] { return [...this.asg.values()].filter((a) => a.taskId === taskId); }

  /** engine-facing task: entered values with the duration derived from the resource rules */
  effectiveTask(id: string): TaskIn {
    const t = this.tasks.get(id)!;
    const { notes: _n, sortKey: _s, custom: _c, ...rest } = t; void _n; void _s; void _c;
    const asg = this.asgOfTask(id);
    return asg.length ? { ...rest, durationMin: effort(t, asg).durationMin } : rest;
  }

  engineProject(resources: ResourceIn[] = [], withAssignments = false): ProjectIn {
    const cal = this.calendars.find((c) => c.id === this.project.calendarId);
    if (!cal) throw new Problem('INTERNAL', 'project calendar missing');
    return {
      startDate: this.project.startDate,
      ...(this.project.deadline !== undefined ? { deadline: this.project.deadline } : {}),
      ...(this.project.statusDate !== undefined ? { statusDate: this.project.statusDate } : {}),
      nearCriticalMin: this.project.nearCriticalMin,
      calendar: cal, calendars: this.calendars.filter((c) => c.id !== cal.id),
      tasks: [...this.tasks.keys()].map((id) => this.effectiveTask(id)),
      links: [...this.links.values()].map((l) => ({ pred: l.pred, succ: l.succ, type: l.type, lagMin: l.lagMin, lagBasis: l.lagBasis })),
      ...(withAssignments ? { resources, assignments: [...this.asg.values()] } : {}),
    };
  }

  private patchToTask(base: TaskRec | null, p: Record<string, unknown>): TaskRec {
    const t: Record<string, unknown> = { ...(base ?? {}) };
    for (const [k, v] of Object.entries(p)) {
      if (k === 'constraint') { const c = v as { type: string; date?: string } | undefined; if (c) t.constraint = c.date ? { type: c.type, date: toMs(c.date) } : { type: c.type }; else delete t.constraint; continue; }
      if (k === 'estimate') { const e = v as { optimisticMin: number; likelyMin: number; pessimisticMin: number } | null; if (e) t.estimate = { optimistic: e.optimisticMin, mostLikely: e.likelyMin, pessimistic: e.pessimisticMin }; else delete t.estimate; continue; }
      if (['actualStart', 'actualFinish', 'manualStart', 'manualFinish'].includes(k)) { if (v === null || v === undefined) delete t[k]; else t[k] = toMs(v as string); continue; }
      if (v === null || v === undefined) { delete t[k]; continue; }
      t[k] = v;
    }
    return t as unknown as TaskRec;
  }

  /** returns engine edits; pushes row ops */
  apply(cmd: Cmd, rows: RowOp[]): Edit[] {
    const edits: Edit[] = [];
    const bad = (m: string) => new Problem('VALIDATION_FAILED', m);
    const durationEdit = (id: string) => {
      const eff = this.effectiveTask(id).durationMin;
      edits.push({ op: 'setTask', id, patch: { durationMin: eff } });
    };
    switch (cmd.op) {
      case 'addTask': {
        const { id, ...rest } = cmd.task;
        if (this.tasks.has(id)) throw new Problem('DUPLICATE_ID', `task ${id} already exists`);
        if (rest.parentId && !this.tasks.has(rest.parentId)) throw new Problem('UNKNOWN_TASK', `unknown parent ${rest.parentId}`);
        if (rest.parentId && this.asgOfTask(rest.parentId).length) throw bad('a task with assignments cannot become a summary');
        const siblings = this.childrenOf(rest.parentId ?? null);
        let prev: string | null = null, next: string | null = null;
        if (cmd.afterId) {
          const i = siblings.findIndex((s) => s.id === cmd.afterId);
          if (i < 0) throw bad('afterId is not a sibling under the target parent');
          prev = siblings[i].sortKey; next = siblings[i + 1]?.sortKey ?? null;
        } else if (siblings.length) prev = siblings[siblings.length - 1].sortKey;
        const rec = this.patchToTask({ id, durationMin: 0, sortKey: keyBetween(prev, next) } as TaskRec, rest);
        rec.id = id; rec.parentId = rest.parentId ?? null;
        edits.push({ op: 'addTask', task: this.stripped(rec) });
        this.tasks.set(id, rec);
        rows.push({ t: 'task.insert', rec });
        if (rest.parentId) { const par = this.tasks.get(rest.parentId)!; rows.push({ t: 'task.update', id: par.id, rec: par }); }
        return edits;
      }
      case 'updateTask': {
        const cur = this.tasks.get(cmd.id);
        if (!cur) throw new Problem('UNKNOWN_TASK', `unknown task ${cmd.id}`);
        const merged = this.patchToTask(cur, cmd.patch);
        merged.id = cmd.id;
        const summary = this.isSummary(cmd.id);
        const patch: Record<string, unknown> = {};
        for (const k of Object.keys(cmd.patch)) { patch[k] = (merged as unknown as Record<string, unknown>)[k]; }
        this.tasks.set(cmd.id, merged);
        rows.push({ t: 'task.update', id: cmd.id, rec: merged });
        if (summary) { if (Object.keys(cmd.patch).some((k) => k !== 'name' && k !== 'notes' && k !== 'custom')) throw bad('summary tasks only accept name, notes and custom'); return edits; }
        const engineKeys = { ...patch };
        delete engineKeys.notes; delete engineKeys.custom;
        const e: Record<string, unknown> = {};
        for (const k of Object.keys(cmd.patch)) if (k !== 'notes' && k !== 'custom') e[k] = (merged as unknown as Record<string, unknown>)[k];
        if ('durationMin' in e || 'kind' in e || 'effortDriven' in e || 'workMin' in e) e.durationMin = this.effectiveTask(cmd.id).durationMin;
        if (Object.keys(e).length) edits.push({ op: 'setTask', id: cmd.id, patch: e as Partial<TaskIn> });
        return edits;
      }
      case 'moveTask': {
        const cur = this.tasks.get(cmd.id);
        if (!cur) throw new Problem('UNKNOWN_TASK', `unknown task ${cmd.id}`);
        const np = cmd.newParentId === undefined ? (cur.parentId ?? null) : cmd.newParentId;
        if (np && !this.tasks.has(np)) throw new Problem('UNKNOWN_TASK', `unknown parent ${np}`);
        if (np && this.asgOfTask(np).length) throw bad('a task with assignments cannot become a summary');
        const sibs = this.childrenOf(np).filter((s) => s.id !== cmd.id);
        let prev: string | null = null, next: string | null = null;
        if (cmd.afterId) {
          const i = sibs.findIndex((s) => s.id === cmd.afterId);
          if (i < 0) throw bad('afterId is not a sibling under the target parent');
          prev = sibs[i].sortKey; next = sibs[i + 1]?.sortKey ?? null;
        } else if (sibs.length) prev = sibs[sibs.length - 1].sortKey;
        if ((cur.parentId ?? null) !== np) edits.push({ op: 'moveTask', id: cmd.id, newParentId: np });
        const oldParent = cur.parentId ?? null;
        cur.parentId = np; cur.sortKey = keyBetween(prev, next);
        rows.push({ t: 'task.update', id: cmd.id, rec: cur });
        for (const pid of [oldParent, np]) if (pid) rows.push({ t: 'task.update', id: pid, rec: this.tasks.get(pid)! });
        return edits;
      }
      case 'deleteTask': {
        if (!this.tasks.has(cmd.id)) throw new Problem('UNKNOWN_TASK', `unknown task ${cmd.id}`);
        const sub: string[] = [];
        const walk = (id: string) => { for (const c of this.childrenOf(id)) walk(c.id); sub.push(id); }; // post-order: leaves first
        walk(cmd.id);
        for (const id of sub) {
          for (const l of [...this.links.values()]) if (l.pred === id || l.succ === id) { this.links.delete(l.id); rows.push({ t: 'link.delete', id: l.id }); }
          for (const a of this.asgOfTask(id)) { this.asg.delete(a.id); rows.push({ t: 'asg.delete', id: a.id }); }
          edits.push({ op: 'removeTask', id });
          this.tasks.delete(id);
        }
        rows.push({ t: 'task.delete', id: cmd.id }); // FK ON DELETE CASCADE removes descendants in the database
        return edits;
      }
      case 'addLink': {
        const l = cmd.link;
        if (this.links.has(l.id)) throw new Problem('DUPLICATE_ID', `link ${l.id} already exists`);
        const rec: LinkRec = { id: l.id, pred: l.predId, succ: l.succId, type: l.type ?? 'FS', lagMin: l.lagMin ?? 0, lagBasis: l.lagBasis ?? 'PROJECT' };
        for (const e of [rec.pred, rec.succ]) {
          if (!this.tasks.has(e)) throw new Problem('UNKNOWN_TASK', `unknown task ${e}`);
          if (this.isSummary(e)) throw new Problem('LINK_TO_SUMMARY', `${e} is a summary task`);
        }
        for (const o of this.links.values()) if (o.pred === rec.pred && o.succ === rec.succ && o.type === rec.type) throw new Problem('DUPLICATE_ID', 'an identical link already exists');
        edits.push({ op: 'addLink', link: { pred: rec.pred, succ: rec.succ, type: rec.type, lagMin: rec.lagMin, lagBasis: rec.lagBasis } });
        this.links.set(rec.id, rec);
        rows.push({ t: 'link.insert', rec });
        return edits;
      }
      case 'updateLink': {
        const l = this.links.get(cmd.id);
        if (!l) throw new Problem('NOT_FOUND', `unknown link ${cmd.id}`);
        edits.push({ op: 'setLink', pred: l.pred, succ: l.succ, type: l.type, patch: { type: cmd.patch.type, lagMin: cmd.patch.lagMin, lagBasis: cmd.patch.lagBasis } });
        const next: LinkRec = { ...l, ...Object.fromEntries(Object.entries(cmd.patch).filter(([, v]) => v !== undefined)) } as LinkRec;
        for (const o of this.links.values()) if (o.id !== l.id && o.pred === next.pred && o.succ === next.succ && o.type === next.type) throw new Problem('DUPLICATE_ID', 'an identical link already exists');
        this.links.set(l.id, next);
        rows.push({ t: 'link.update', rec: next });
        return edits;
      }
      case 'removeLink': {
        const l = this.links.get(cmd.id);
        if (!l) throw new Problem('NOT_FOUND', `unknown link ${cmd.id}`);
        edits.push({ op: 'removeLink', pred: l.pred, succ: l.succ, type: l.type });
        this.links.delete(l.id);
        rows.push({ t: 'link.delete', id: l.id });
        return edits;
      }
      case 'addAssignment': {
        const a = cmd.assignment;
        if (this.asg.has(a.id)) throw new Problem('DUPLICATE_ID', `assignment ${a.id} already exists`);
        if (!this.tasks.has(a.taskId)) throw new Problem('UNKNOWN_TASK', `unknown task ${a.taskId}`);
        if (this.isSummary(a.taskId)) throw bad('assignments go on leaf tasks');
        if (!this.resourceIds.has(a.resourceId)) throw bad(`unknown resource ${a.resourceId}`);
        if (this.asgOfTask(a.taskId).some((x) => x.resourceId === a.resourceId)) throw new Problem('DUPLICATE_ID', 'resource already assigned to this task');
        const rec: AssignmentIn = { id: a.id, taskId: a.taskId, resourceId: a.resourceId, units: a.units ?? 1 };
        this.asg.set(rec.id, rec);
        rows.push({ t: 'asg.insert', rec });
        durationEdit(a.taskId);
        return edits;
      }
      case 'updateAssignment': {
        const a = this.asg.get(cmd.id);
        if (!a) throw new Problem('NOT_FOUND', `unknown assignment ${cmd.id}`);
        const rec = { ...a, units: cmd.patch.units };
        this.asg.set(a.id, rec);
        rows.push({ t: 'asg.update', rec });
        durationEdit(a.taskId);
        return edits;
      }
      case 'removeAssignment': {
        const a = this.asg.get(cmd.id);
        if (!a) throw new Problem('NOT_FOUND', `unknown assignment ${cmd.id}`);
        this.asg.delete(a.id);
        rows.push({ t: 'asg.delete', id: a.id });
        durationEdit(a.taskId);
        return edits;
      }
      case 'setProject': {
        const p = cmd.patch, pr = this.project;
        if (p.startDate !== undefined) pr.startDate = toMs(p.startDate);
        if (p.deadline !== undefined) { if (p.deadline === null) delete pr.deadline; else pr.deadline = toMs(p.deadline); }
        if (p.statusDate !== undefined) { if (p.statusDate === null) delete pr.statusDate; else pr.statusDate = toMs(p.statusDate); }
        if (p.nearCriticalMin !== undefined) pr.nearCriticalMin = p.nearCriticalMin;
        rows.push({ t: 'project.update' });
        edits.push({ op: 'setProject', patch: { startDate: pr.startDate, deadline: pr.deadline ?? null, statusDate: pr.statusDate ?? null } });
        return edits;
      }
    }
  }

  private stripped(t: TaskRec): TaskIn {
    const { notes: _n, sortKey: _s, custom: _c, ...rest } = t; void _n; void _s; void _c;
    return rest;
  }
}

export const newId = (): string => randomUUID();

import { WorkCalendar, resolveCalendars } from './calendar.ts';
import {
  ScheduleError,
  type Conflict, type DepType, type Driver, type LagBasis, type LinkIn, type ProjectIn,
  type ScheduleResult, type TaskIn, type TaskOut, type ConstraintType,
} from './types.ts';

/** One precedence link. A single object is shared by the predecessor's `succs` and the successor's `preds` lists. */
interface Edge { from: string; to: string; type: DepType; lag: number; basis: LagBasis; lagCal: WorkCalendar }

interface Node {
  t: TaskIn;
  cal: WorkCalendar;
  pos: number;
  preds: Edge[]; succs: Edge[];
  es: number; ef: number; ls: number; lf: number;
  driver: Driver;
  conflicts: Conflict[];
}

export type Edit =
  | { op: 'setTask'; id: string; patch: Partial<Omit<TaskIn, 'id' | 'parentId'>> }
  | { op: 'addTask'; task: TaskIn }
  | { op: 'removeTask'; id: string }
  | { op: 'moveTask'; id: string; newParentId: string | null }
  | { op: 'addLink'; link: LinkIn }
  | { op: 'removeLink'; pred: string; succ: string; type?: DepType }
  | { op: 'setLink'; pred: string; succ: string; type?: DepType; patch: { type?: DepType; lagMin?: number; lagBasis?: LagBasis } }
  | { op: 'setProject'; patch: { startDate?: number; deadline?: number | null; statusDate?: number | null; nearCriticalMin?: number } };

export interface RecomputeStats {
  forwardVisited: number;
  backwardVisited: number;
  /** true when the project finish moved, so every late date had to be re-derived */
  fullBackward: boolean;
  /** leaf ids whose es/ef/ls/lf changed in this apply() */
  changed: string[];
}

const NEG = -Infinity;

/**
 * The scheduling network: a mutable precedence graph with cached early/late dates.
 *
 * Construction runs the full CPM (forward pass, backward pass). `apply()` then re-derives only what an edit can
 * affect: forward dirty-propagation in topological order with early cut-off, and a backward pass limited to the
 * affected cone unless the project finish (or deadline) moved. A dynamic topological order (Pearce-Kelly) keeps
 * link insertion proportional to the affected region and reports cycles with an explicit path.
 *
 * Correctness contract (tested as an oracle): after any sequence of edits, result() deep-equals a fresh
 * `new Network(toProject())` built from scratch.
 */
export class Network {
  private p: ProjectIn;
  private nodes = new Map<string, Node>();
  private children = new Map<string, string[]>();
  private slots: string[] = [];            // slots[pos] = leaf id (a permutation, may contain holes after removals -> rebuilt)
  private cals: Map<string, WorkCalendar>;
  private projCal: WorkCalendar;
  private limit = 0;
  private projectFinish = 0;
  private projectStart = 0;

  constructor(p: ProjectIn) {
    this.p = { ...p, tasks: [], links: [] };
    const defs = [p.calendar, ...(p.calendars ?? [])];
    this.cals = resolveCalendars(defs);
    this.projCal = this.cals.get(p.calendar.id)!;

    const seen = new Set<string>();
    for (const t of p.tasks) {
      if (seen.has(t.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate task id ${t.id}`);
      seen.add(t.id);
    }
    for (const t of p.tasks) {
      this.validateTask(t);
      if (t.parentId) {
        if (!seen.has(t.parentId)) throw new ScheduleError('UNKNOWN_TASK', `task ${t.id}: unknown parent ${t.parentId}`);
        (this.children.get(t.parentId) ?? this.children.set(t.parentId, []).get(t.parentId)!).push(t.id);
      }
    }
    for (const t of p.tasks) {
      this.p.tasks.push(t);
      if (!this.children.has(t.id)) this.nodes.set(t.id, this.newNode(t));
    }
    for (const l of p.links) this.insertEdge(l);
    this.rebuildOrder();
    this.propagate(new Set(), new Set(), true);
  }

  // ------------------------------------------------------------------ public API

  /** Apply one or more edits atomically per edit; stops at the first invalid edit (earlier ones stay applied). */
  apply(edits: Edit | Edit[]): RecomputeStats {
    const list = Array.isArray(edits) ? edits : [edits];
    const fwd = new Set<string>(), bwd = new Set<string>();
    let rebuild = false, all = false;
    for (const e of list) {
      const r = this.applyOne(e, fwd, bwd);
      rebuild ||= r.rebuild; all ||= r.all;
    }
    if (rebuild) this.rebuildOrder();
    return this.propagate(fwd, bwd, all);
  }

  /** The current inputs (always reflects every applied edit). */
  toProject(): ProjectIn {
    const links: LinkIn[] = [];
    for (const n of this.nodes.values())
      for (const e of n.preds) links.push({ pred: e.from, succ: e.to, type: e.type, lagMin: e.lag, ...(e.basis !== 'PROJECT' ? { lagBasis: e.basis } : {}) });
    return { ...this.p, tasks: this.p.tasks.map((t) => this.nodes.get(t.id)?.t ?? t), links };
  }

  result(): ScheduleResult {
    const out: Record<string, TaskOut> = {};
    const drivers: Record<string, Driver> = {};
    const conflicts: Conflict[] = [];
    for (const [id, n] of this.nodes) {
      out[id] = this.taskOut(n);
      drivers[id] = n.driver;
      conflicts.push(...n.conflicts);
    }
    if (this.p.deadline !== undefined)
      for (const [id, n] of this.nodes)
        if (n.ef > this.p.deadline && this.state(n.t) !== 'DONE') conflicts.push({ taskId: id, code: 'DEADLINE_MISSED', detail: 'finishes after project deadline' });
    const rollup = (id: string): TaskOut => {
      const kids = this.children.get(id);
      if (!kids) return out[id];
      const ks = kids.map(rollup);
      const states = ks.map((k) => k.state);
      out[id] = {
        id, isSummary: true,
        es: Math.min(...ks.map((k) => k.es)), ef: Math.max(...ks.map((k) => k.ef)),
        ls: Math.min(...ks.map((k) => k.ls)), lf: Math.max(...ks.map((k) => k.lf)),
        totalFloatMin: Math.min(...ks.map((k) => k.totalFloatMin)),
        freeFloatMin: Math.min(...ks.map((k) => k.freeFloatMin)),
        critical: ks.some((k) => k.critical),
        nearCritical: ks.some((k) => k.nearCritical),
        state: states.every((s) => s === 'DONE') ? 'DONE' : states.every((s) => s === 'OPEN') ? 'OPEN' : 'PROGRESS',
      };
      return out[id];
    };
    for (const t of this.p.tasks) rollup(t.id);
    conflicts.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    const criticalPath = [...this.nodes.keys()]
      .filter((id) => out[id].critical)
      .sort((x, y) => out[x].es - out[y].es || out[x].ef - out[y].ef || (x < y ? -1 : 1));
    return { start: this.projectStart, finish: this.projectFinish, tasks: out, criticalPath, conflicts, drivers };
  }

  /** true when `b` is reachable from `a` through links (a precedes b, directly or transitively) */
  reaches(a: string, b: string): boolean {
    if (a === b) return true;
    const pb = this.nodeOrThrow(b).pos, seen = new Set<string>([a]), stack = [a];
    while (stack.length) {
      for (const e of this.nodes.get(stack.pop()!)!.succs) {
        if (e.to === b) return true;
        if (!seen.has(e.to) && this.nodes.get(e.to)!.pos < pb) { seen.add(e.to); stack.push(e.to); }
      }
    }
    return false;
  }

  /** one leaf's output row without materialising the whole result */
  taskRow(id: string): TaskOut { return this.taskOut(this.nodeOrThrow(id)); }

  /** leaf ids in the current topological order */
  topoOrder(): string[] { return this.slots.filter((id) => this.nodes.has(id)); }
  leafIds(): string[] { return [...this.nodes.keys()]; }
  node(id: string): { es: number; ef: number; ls: number; lf: number; driver: Driver } {
    const n = this.nodes.get(id);
    if (!n) throw new ScheduleError('UNKNOWN_TASK', `unknown or non-leaf task ${id}`);
    return n;
  }
  calendarOf(id: string): WorkCalendar { return this.nodeOrThrow(id).cal; }
  projectCalendar(): WorkCalendar { return this.projCal; }
  calendarById(id: string): WorkCalendar | undefined { return this.cals.get(id); }

  // ------------------------------------------------------------------ construction helpers

  private nodeOrThrow(id: string): Node {
    const n = this.nodes.get(id);
    if (!n) {
      if (this.children.has(id)) throw new ScheduleError('LINK_TO_SUMMARY', `${id} is a summary task`);
      throw new ScheduleError('UNKNOWN_TASK', `unknown task ${id}`);
    }
    return n;
  }

  private validateTask(t: TaskIn) {
    if (!t.id) throw new ScheduleError('BAD_INPUT', 'task id required');
    if (!Number.isInteger(t.durationMin) || t.durationMin < 0)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: durationMin must be a non-negative integer`);
    const c = t.constraint;
    if (c && c.type !== 'ASAP' && c.type !== 'ALAP' && c.date === undefined)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: constraint ${c.type} requires a date`);
    if (t.calendarId && !this.cals.has(t.calendarId))
      throw new ScheduleError('BAD_INPUT', `unknown calendar ${t.calendarId} on task ${t.id}`);
    if (t.percentComplete !== undefined && !(t.percentComplete >= 0 && t.percentComplete <= 1))
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: percentComplete must be within 0..1`);
    if ((t.percentComplete ?? 0) >= 1 && t.actualFinish === undefined)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: percentComplete = 1 requires actualFinish`);
    if (t.actualFinish !== undefined && t.actualStart !== undefined && t.actualFinish < t.actualStart)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: actualFinish precedes actualStart`);
    if (t.mode === 'MANUAL' && t.manualStart === undefined)
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: manual mode requires manualStart`);
    if (t.levelingDelayMin !== undefined && (!Number.isInteger(t.levelingDelayMin) || t.levelingDelayMin < 0))
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: levelingDelayMin must be a non-negative integer`);
    if (t.priority !== undefined && !(t.priority >= 0 && t.priority <= 1000))
      throw new ScheduleError('BAD_INPUT', `task ${t.id}: priority must be within 0..1000`);
  }

  private newNode(t: TaskIn): Node {
    const cal = t.calendarId ? this.cals.get(t.calendarId)! : this.projCal;
    return { t, cal, pos: -1, preds: [], succs: [], es: 0, ef: 0, ls: 0, lf: 0, driver: { kind: 'PROJECT_START' }, conflicts: [] };
  }

  private makeEdge(l: LinkIn): Edge {
    for (const end of [l.pred, l.succ]) {
      if (!this.nodes.has(end)) {
        if (this.children.has(end)) throw new ScheduleError('LINK_TO_SUMMARY', `link end ${end} is a summary task`);
        throw new ScheduleError('UNKNOWN_TASK', `link references unknown task ${end}`);
      }
    }
    const basis = l.lagBasis ?? 'PROJECT';
    const lagCal = basis === 'PRED' ? this.nodes.get(l.pred)!.cal : basis === 'SUCC' ? this.nodes.get(l.succ)!.cal : this.projCal;
    if (l.lagMin !== undefined && !Number.isInteger(l.lagMin)) throw new ScheduleError('BAD_INPUT', 'lagMin must be an integer');
    return { from: l.pred, to: l.succ, type: l.type ?? 'FS', lag: l.lagMin ?? 0, basis, lagCal };
  }

  private insertEdge(l: LinkIn): Edge {
    const e = this.makeEdge(l);
    this.nodes.get(e.from)!.succs.push(e);
    this.nodes.get(e.to)!.preds.push(e);
    return e;
  }

  /** Kahn ordering of all leaves; throws CYCLE with a path. */
  private rebuildOrder() {
    const ids = [...this.nodes.keys()];
    const indeg = new Map(ids.map((id) => [id, this.nodes.get(id)!.preds.length]));
    const queue = ids.filter((id) => indeg.get(id) === 0);
    for (let i = 0; i < queue.length; i++) {
      for (const e of this.nodes.get(queue[i])!.succs) {
        const k = indeg.get(e.to)! - 1;
        indeg.set(e.to, k);
        if (k === 0) queue.push(e.to);
      }
    }
    if (queue.length !== ids.length) {
      const stuck = new Set(ids.filter((id) => indeg.get(id)! > 0));
      throw new ScheduleError('CYCLE', 'dependency cycle detected', { path: this.findCycle(stuck) });
    }
    this.slots = queue;
    queue.forEach((id, i) => { this.nodes.get(id)!.pos = i; });
  }

  private findCycle(stuck: Set<string>): string[] {
    const state = new Map<string, 1 | 2>();
    const stack: string[] = [];
    const dfs = (u: string): string[] | null => {
      state.set(u, 1); stack.push(u);
      for (const e of this.nodes.get(u)!.succs) {
        if (!stuck.has(e.to)) continue;
        if (state.get(e.to) === 1) return [...stack.slice(stack.indexOf(e.to)), e.to];
        if (!state.has(e.to)) { const r = dfs(e.to); if (r) return r; }
      }
      stack.pop(); state.set(u, 2);
      return null;
    };
    for (const s of stuck) if (!state.has(s)) { const r = dfs(s); if (r) return r; }
    return [];
  }

  /**
   * Pearce-Kelly dynamic topological order. Called BEFORE the edge is inserted. Only nodes whose position lies
   * between succ and pred are touched, so a link that already respects the order costs O(1).
   */
  private ensureOrder(pred: string, succ: string) {
    const P = this.nodes.get(pred)!, S = this.nodes.get(succ)!;
    if (pred === succ) throw new ScheduleError('CYCLE', 'dependency cycle detected', { path: [pred, pred] });
    if (P.pos < S.pos) return;
    const lb = S.pos, ub = P.pos;
    const parent = new Map<string, string>();
    const F: string[] = [];
    const seenF = new Set<string>([succ]);
    const stack = [succ];
    while (stack.length) {
      const u = stack.pop()!;
      F.push(u);
      for (const e of this.nodes.get(u)!.succs) {
        const w = e.to;
        if (w === pred) {
          const path = [pred, u];
          for (let x = u; x !== succ;) { x = parent.get(x)!; path.push(x); }
          path.reverse(); // succ ... u pred
          throw new ScheduleError('CYCLE', 'dependency cycle detected', { path: [...path, succ] });
        }
        if (!seenF.has(w) && this.nodes.get(w)!.pos < ub) { seenF.add(w); parent.set(w, u); stack.push(w); }
      }
    }
    const B: string[] = [];
    const seenB = new Set<string>([pred]);
    const stack2 = [pred];
    while (stack2.length) {
      const u = stack2.pop()!;
      B.push(u);
      for (const e of this.nodes.get(u)!.preds) {
        const w = e.from;
        if (!seenB.has(w) && this.nodes.get(w)!.pos > lb) { seenB.add(w); stack2.push(w); }
      }
    }
    const byPos = (a: string, b: string) => this.nodes.get(a)!.pos - this.nodes.get(b)!.pos;
    B.sort(byPos); F.sort(byPos);
    const seq = [...B, ...F];
    const pool = seq.map((id) => this.nodes.get(id)!.pos).sort((a, b) => a - b);
    seq.forEach((id, i) => { this.nodes.get(id)!.pos = pool[i]; this.slots[pool[i]] = id; });
  }

  // ------------------------------------------------------------------ edits

  private applyOne(e: Edit, fwd: Set<string>, bwd: Set<string>): { rebuild: boolean; all: boolean } {
    switch (e.op) {
      case 'setTask': {
        if (this.children.has(e.id)) {
          const t = this.p.tasks.find((x) => x.id === e.id)!;
          const keys = Object.keys(e.patch);
          if (keys.some((k) => k !== 'name')) throw new ScheduleError('BAD_INPUT', `summary task ${e.id}: only name is editable`);
          Object.assign(t, e.patch);
          return { rebuild: false, all: false };
        }
        const n = this.nodeOrThrow(e.id);
        const merged: TaskIn = { ...n.t, ...e.patch };
        for (const k of Object.keys(e.patch) as (keyof TaskIn)[]) if (e.patch[k as never] === undefined) delete merged[k];
        this.validateTask(merged);
        n.t = merged;
        this.replaceTaskObject(merged);
        const calChanged = (merged.calendarId ? this.cals.get(merged.calendarId)! : this.projCal) !== n.cal;
        if (calChanged) {
          n.cal = merged.calendarId ? this.cals.get(merged.calendarId)! : this.projCal;
          for (const ed of [...n.preds, ...n.succs]) { // lag calendars that follow this task must follow its new calendar
            if (ed.basis === 'PRED' && ed.from === n.t.id) ed.lagCal = n.cal;
            if (ed.basis === 'SUCC' && ed.to === n.t.id) ed.lagCal = n.cal;
            fwd.add(ed.to); bwd.add(ed.from);
          }
        }
        fwd.add(e.id); bwd.add(e.id);
        return { rebuild: false, all: false };
      }
      case 'addTask': {
        const t = e.task;
        if (this.nodes.has(t.id) || this.children.has(t.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate task id ${t.id}`);
        if (this.p.tasks.some((x) => x.id === t.id)) throw new ScheduleError('DUPLICATE_ID', `duplicate task id ${t.id}`);
        this.validateTask(t);
        let converted = false;
        if (t.parentId) converted = this.attach(t.id, t.parentId);
        this.p.tasks.push(t);
        const n = this.newNode(t);
        n.pos = this.slots.length;
        this.slots.push(t.id);
        this.nodes.set(t.id, n);
        fwd.add(t.id); bwd.add(t.id);
        return { rebuild: converted, all: converted };
      }
      case 'removeTask': {
        const n = this.nodeOrThrow(e.id);
        for (const ed of [...n.preds, ...n.succs]) this.deleteEdge(ed, fwd, bwd);
        this.nodes.delete(e.id);
        this.p.tasks = this.p.tasks.filter((x) => x.id !== e.id);
        fwd.delete(e.id); bwd.delete(e.id);
        if (n.t.parentId) this.detach(e.id, n.t.parentId, fwd, bwd);
        return { rebuild: true, all: true }; // holes in the order; the project limit may move
      }
      case 'moveTask': {
        const t = this.p.tasks.find((x) => x.id === e.id);
        if (!t) throw new ScheduleError('UNKNOWN_TASK', `unknown task ${e.id}`);
        const np = e.newParentId ?? null;
        if (np !== null) {
          if (!this.p.tasks.some((x) => x.id === np)) throw new ScheduleError('UNKNOWN_TASK', `unknown parent ${np}`);
          for (let a: string | null | undefined = np; a; a = this.p.tasks.find((x) => x.id === a)?.parentId)
            if (a === e.id) throw new ScheduleError('BAD_INPUT', 'a task cannot be moved under itself or its own descendant');
        }
        if ((t.parentId ?? null) === np) return { rebuild: false, all: false };
        if (np !== null) this.attach(e.id, np); // may throw LINK_TO_SUMMARY before anything else changed
        if (t.parentId) this.detach(e.id, t.parentId, fwd, bwd);
        t.parentId = np;
        const nd = this.nodes.get(e.id);
        if (nd) nd.t = t;
        return { rebuild: true, all: true };
      }
      case 'addLink': {
        const edge = this.makeEdge(e.link);
        this.ensureOrder(edge.from, edge.to); // throws on cycle BEFORE any mutation
        this.nodes.get(edge.from)!.succs.push(edge);
        this.nodes.get(edge.to)!.preds.push(edge);
        fwd.add(edge.to); bwd.add(edge.from);
        return { rebuild: false, all: false };
      }
      case 'removeLink': {
        const ed = this.findEdge(e.pred, e.succ, e.type);
        this.deleteEdge(ed, fwd, bwd);
        return { rebuild: false, all: false };
      }
      case 'setLink': {
        const ed = this.findEdge(e.pred, e.succ, e.type);
        if (e.patch.type) ed.type = e.patch.type;
        if (e.patch.lagMin !== undefined) {
          if (!Number.isInteger(e.patch.lagMin)) throw new ScheduleError('BAD_INPUT', 'lagMin must be an integer');
          ed.lag = e.patch.lagMin;
        }
        if (e.patch.lagBasis) {
          ed.basis = e.patch.lagBasis;
          ed.lagCal = ed.basis === 'PRED' ? this.nodes.get(ed.from)!.cal : ed.basis === 'SUCC' ? this.nodes.get(ed.to)!.cal : this.projCal;
        }
        fwd.add(ed.to); bwd.add(ed.from);
        return { rebuild: false, all: false };
      }
      case 'setProject': {
        const q = e.patch;
        if (q.startDate !== undefined) this.p.startDate = q.startDate;
        if (q.deadline !== undefined) { if (q.deadline === null) delete this.p.deadline; else this.p.deadline = q.deadline; }
        if (q.statusDate !== undefined) { if (q.statusDate === null) delete this.p.statusDate; else this.p.statusDate = q.statusDate; }
        if (q.nearCriticalMin !== undefined) this.p.nearCriticalMin = q.nearCriticalMin;
        return { rebuild: false, all: true };
      }
    }
  }

  /** add `id` under `parentId`; a leaf parent becomes a summary (refused when it carries links). Returns true when converted. */
  private attach(id: string, parentId: string): boolean {
    if (!this.p.tasks.some((x) => x.id === parentId)) throw new ScheduleError('UNKNOWN_TASK', `task ${id}: unknown parent ${parentId}`);
    const kids = this.children.get(parentId);
    if (kids) { kids.push(id); return false; }
    const pn = this.nodes.get(parentId)!;
    if (pn.preds.length || pn.succs.length) throw new ScheduleError('LINK_TO_SUMMARY', `${parentId} has links and cannot become a summary`);
    this.nodes.delete(parentId);
    this.children.set(parentId, [id]);
    return true;
  }

  /** remove `id` from `parentId`'s children; an emptied summary becomes a leaf again */
  private detach(id: string, parentId: string, fwd: Set<string>, bwd: Set<string>) {
    const sib = this.children.get(parentId)!.filter((x) => x !== id);
    if (sib.length) { this.children.set(parentId, sib); return; }
    this.children.delete(parentId);
    const t = this.p.tasks.find((x) => x.id === parentId)!;
    const pn = this.newNode(t); pn.pos = this.slots.length; this.slots.push(t.id);
    this.nodes.set(t.id, pn); fwd.add(t.id); bwd.add(t.id);
  }

  private replaceTaskObject(t: TaskIn) {
    const i = this.p.tasks.findIndex((x) => x.id === t.id);
    this.p.tasks[i] = t;
  }

  private findEdge(pred: string, succ: string, type?: DepType): Edge {
    const n = this.nodes.get(succ);
    const ed = n?.preds.find((x) => x.from === pred && (type === undefined || x.type === type));
    if (!ed) throw new ScheduleError('UNKNOWN_TASK', `no link ${pred} -> ${succ}`);
    return ed;
  }

  private deleteEdge(ed: Edge, fwd: Set<string>, bwd: Set<string>) {
    const a = this.nodes.get(ed.from), b = this.nodes.get(ed.to);
    if (a) a.succs = a.succs.filter((x) => x !== ed);
    if (b) b.preds = b.preds.filter((x) => x !== ed);
    fwd.add(ed.to); bwd.add(ed.from);
  }

  // ------------------------------------------------------------------ passes

  private state(t: TaskIn): 'OPEN' | 'PROGRESS' | 'DONE' {
    if (t.actualFinish !== undefined || (t.percentComplete ?? 0) >= 1) return 'DONE';
    if ((t.percentComplete ?? 0) > 0 || t.actualStart !== undefined) return 'PROGRESS';
    return 'OPEN';
  }
  private remaining(t: TaskIn): number {
    const s = this.state(t);
    if (s === 'DONE') return 0;
    if (s === 'PROGRESS') return Math.ceil(t.durationMin * (1 - (t.percentComplete ?? 0)));
    return t.durationMin;
  }

  private computeFwd(n: Node): { es: number; ef: number; driver: Driver; conflicts: Conflict[] } {
    const t = n.t, id = t.id, cal = n.cal, d = t.durationMin, c = t.constraint;
    const conflicts: Conflict[] = [];
    let start = this.p.startDate;
    let driver: Driver = { kind: 'PROJECT_START' };
    const st = this.state(t);
    const consider = (v: number, drv: Driver) => { if (v > start) { start = v; driver = drv; } };

    if (this.p.statusDate !== undefined && st === 'OPEN') consider(this.p.statusDate, { kind: 'STATUS_DATE' });
    let reqFinish = NEG, reqDrv: Driver = { kind: 'PROJECT_START' };
    for (const e of n.preds) {
      const pn = this.nodes.get(e.from)!;
      const link = (kind: DepType): Driver => ({ kind: 'LINK', predId: e.from, linkType: kind });
      switch (e.type) {
        case 'FS': consider(e.lagCal.shift(pn.ef, e.lag), link('FS')); break;
        case 'SS': consider(e.lagCal.shift(pn.es, e.lag), link('SS')); break;
        case 'FF': { const v = e.lagCal.shift(pn.ef, e.lag); if (v > reqFinish) { reqFinish = v; reqDrv = link('FF'); } break; }
        case 'SF': { const v = e.lagCal.shift(pn.es, e.lag); if (v > reqFinish) { reqFinish = v; reqDrv = link('SF'); } break; }
      }
    }
    if (reqFinish > NEG) {
      const s = d > 0 ? cal.subWork(cal.prevWorkEnd(reqFinish), d) : cal.prevWorkEnd(reqFinish);
      consider(s, reqDrv);
    }
    const depStart = start;
    const delay = t.levelingDelayMin ?? 0;
    if (delay > 0) { const s = this.projCal.shift(start, delay); if (s > start) { start = s; driver = { kind: 'LEVELING' }; } }
    if (c?.type === 'SNET' || c?.type === 'MSO') consider(c.date!, { kind: 'CONSTRAINT' });
    if (c?.type === 'FNET' || c?.type === 'MFO') {
      const s = d > 0 ? cal.subWork(cal.prevWorkEnd(c.date!), d) : cal.prevWorkEnd(c.date!);
      consider(s, { kind: 'CONSTRAINT' });
    }
    start = snapStart(cal, start, d);

    // ---- completed / in-progress / manual overrides
    if (st === 'DONE') {
      const es = t.actualStart ?? start;
      return { es, ef: t.actualFinish ?? es, driver: { kind: 'ACTUAL' }, conflicts };
    }
    if (st === 'PROGRESS') {
      const es = t.actualStart ?? start;
      const rem = this.remaining(t);
      const doneMin = d - rem;
      let resume = doneMin > 0 ? cal.addWork(snapStart(cal, es, d), doneMin) : snapStart(cal, es, d);
      if (this.p.statusDate !== undefined && this.p.statusDate > resume) resume = cal.nextWorkStart(this.p.statusDate);
      const ef = rem > 0 ? cal.addWork(resume, rem) : resume;
      return { es, ef, driver: { kind: 'ACTUAL' }, conflicts };
    }
    if (t.mode === 'MANUAL') {
      const es = snapStart(cal, t.manualStart!, d);
      const ef = t.manualFinish !== undefined ? t.manualFinish : d > 0 ? cal.addWork(es, d) : es;
      if (depStart > es) conflicts.push({ taskId: id, code: 'MANUAL_DATE_CONFLICT', detail: 'predecessor logic would schedule this task later than its manual start' });
      return { es, ef, driver: { kind: 'MANUAL' }, conflicts };
    }

    if (c?.type === 'MSO') {
      if (start > c.date!) conflicts.push({ taskId: id, code: 'MSO_VIOLATED', detail: 'predecessors push start past the fixed date' });
      start = snapStart(cal, c.date!, d);
    }
    let fin = d > 0 ? cal.addWork(start, d) : start;
    if (c?.type === 'MFO') {
      if (fin > c.date!) conflicts.push({ taskId: id, code: 'MFO_VIOLATED', detail: 'predecessors push finish past the fixed date' });
      fin = cal.prevWorkEnd(c.date!);
      start = d > 0 ? cal.subWork(fin, d) : fin;
    }
    if (c?.type === 'SNLT' && start > c.date!) conflicts.push({ taskId: id, code: 'SNLT_VIOLATED', detail: 'start later than limit' });
    if (c?.type === 'FNLT' && fin > c.date!) conflicts.push({ taskId: id, code: 'FNLT_VIOLATED', detail: 'finish later than limit' });
    return { es: start, ef: fin, driver, conflicts };
  }

  private computeBwd(n: Node): { ls: number; lf: number } {
    const t = n.t, cal = n.cal, c = t.constraint;
    if (this.state(t) === 'DONE') return { ls: n.es, lf: n.ef };
    const rem = this.remaining(t);
    let capF = this.limit;
    for (const e of n.succs) {
      const s = this.nodes.get(e.to)!;
      switch (e.type) {
        case 'FS': capF = Math.min(capF, e.lagCal.prevWorkEnd(e.lagCal.shift(s.ls, -e.lag))); break;
        case 'FF': capF = Math.min(capF, e.lagCal.prevWorkEnd(e.lagCal.shift(s.lf, -e.lag))); break;
        case 'SS': capF = Math.min(capF, finishForLatestStart(cal, e.lagCal.shift(s.ls, -e.lag), rem)); break;
        case 'SF': capF = Math.min(capF, finishForLatestStart(cal, e.lagCal.shift(s.lf, -e.lag), rem)); break;
      }
    }
    if (c?.type === 'FNLT' || c?.type === 'MFO') capF = Math.min(capF, c.date!);
    if (c?.type === 'SNLT') capF = Math.min(capF, finishForLatestStart(cal, c.date!, rem));
    if (c?.type === 'MSO' || c?.type === 'MFO') return { ls: n.es, lf: n.ef };
    const late = cal.prevWorkEnd(capF);
    return { ls: rem > 0 ? cal.subWork(late, rem) : late, lf: late };
  }

  /**
   * Re-derive dates. `all` forces a full pass. Otherwise: forward dirty-propagation seeded by `fwdSeeds`, then a
   * backward pass seeded by `bwdSeeds` plus every task whose early dates moved - unless the project limit moved,
   * in which case every late date is stale and a full backward pass runs.
   */
  private propagate(fwdSeeds: Set<string>, bwdSeeds: Set<string>, all: boolean): RecomputeStats {
    const stats: RecomputeStats = { forwardVisited: 0, backwardVisited: 0, fullBackward: false, changed: [] };
    const changed = new Set<string>();
    const movedEarly = new Set<string>();
    const visit = (n: Node): boolean => {
      const r = this.computeFwd(n);
      const moved = r.es !== n.es || r.ef !== n.ef;
      if (moved) changed.add(n.t.id);
      n.es = r.es; n.ef = r.ef; n.driver = r.driver; n.conflicts = r.conflicts;
      stats.forwardVisited++;
      return moved;
    };

    if (all) {
      for (const id of this.slots) { const n = this.nodes.get(id); if (n) visit(n); }
    } else {
      const heap = new Heap<string>((a, b) => this.nodes.get(a)!.pos - this.nodes.get(b)!.pos);
      const queued = new Set<string>();
      const push = (id: string) => { if (this.nodes.has(id) && !queued.has(id)) { queued.add(id); heap.push(id); } };
      fwdSeeds.forEach(push);
      while (heap.size) {
        const id = heap.pop()!; queued.delete(id);
        const n = this.nodes.get(id)!;
        if (visit(n)) { movedEarly.add(id); for (const e of n.succs) push(e.to); }
      }
    }

    // project envelope
    let fin = NEG, sta = Infinity;
    for (const n of this.nodes.values()) { if (n.ef > fin) fin = n.ef; if (n.es < sta) sta = n.es; }
    if (!this.nodes.size) { fin = this.p.startDate; sta = this.p.startDate; }
    this.projectFinish = fin; this.projectStart = sta;
    const limit = this.p.deadline !== undefined ? Math.min(fin, this.p.deadline) : fin;
    const limitMoved = limit !== this.limit;
    this.limit = limit;

    const bwdVisit = (n: Node): boolean => {
      const r = this.computeBwd(n);
      const moved = r.ls !== n.ls || r.lf !== n.lf;
      if (moved) changed.add(n.t.id);
      n.ls = r.ls; n.lf = r.lf;
      stats.backwardVisited++;
      return moved;
    };
    if (all || limitMoved) {
      stats.fullBackward = true;
      for (let i = this.slots.length - 1; i >= 0; i--) { const n = this.nodes.get(this.slots[i]); if (n) bwdVisit(n); }
    } else {
      const heap = new Heap<string>((a, b) => this.nodes.get(b)!.pos - this.nodes.get(a)!.pos);
      const queued = new Set<string>();
      const push = (id: string) => { if (this.nodes.has(id) && !queued.has(id)) { queued.add(id); heap.push(id); } };
      bwdSeeds.forEach(push); movedEarly.forEach(push);
      fwdSeeds.forEach(push); // a changed task may be pinned (MSO/MFO/DONE): its late dates follow its early dates
      while (heap.size) {
        const id = heap.pop()!; queued.delete(id);
        const n = this.nodes.get(id)!;
        if (bwdVisit(n)) for (const e of n.preds) push(e.from);
      }
    }
    stats.changed = [...changed];
    return stats;
  }

  private taskOut(n: Node): TaskOut {
    const t = n.t, cal = n.cal;
    const st = this.state(t);
    let ls = n.ls, lf = n.lf;
    const rem = this.remaining(t);
    let tf = st === 'PROGRESS' ? cal.workBetween(n.ef, lf) : cal.workBetween(n.es, ls);
    if (st === 'DONE') tf = 0;
    // Canonicalise: Fri 17:00 and the following Mon 08:00 are the same point on the working-time axis.
    // With zero float the late dates ARE the early dates (matters for milestones).
    if (tf === 0) { ls = n.es; lf = n.ef; }
    let ff = n.succs.length === 0 ? this.projCal.workBetween(n.ef, this.projectFinish) : Infinity;
    for (const e of n.succs) {
      const s = this.nodes.get(e.to)!;
      const lc = e.lagCal;
      const slack =
        e.type === 'FS' ? lc.workBetween(lc.shift(n.ef, e.lag), s.es) :
        e.type === 'SS' ? lc.workBetween(lc.shift(n.es, e.lag), s.es) :
        e.type === 'FF' ? lc.workBetween(lc.shift(n.ef, e.lag), s.ef) :
                          lc.workBetween(lc.shift(n.es, e.lag), s.ef);
      ff = Math.min(ff, slack);
    }
    ff = Math.min(Math.max(ff, Math.min(0, tf)), tf);
    let a = n.es, b = n.ef;
    if (t.constraint?.type === 'ALAP' && st === 'OPEN') { a = ls; b = lf; ff = 0; } // placed late: no slack left to give
    const nearMax = this.p.nearCriticalMin ?? 960;
    const critical = st !== 'DONE' && tf <= 0;
    void rem;
    return {
      id: t.id, isSummary: false, es: a, ef: b, ls, lf,
      totalFloatMin: tf, freeFloatMin: ff, critical,
      nearCritical: st !== 'DONE' && tf > 0 && tf <= nearMax,
      state: st,
    };
  }
}

export function snapStart(cal: WorkCalendar, t: number, d: number): number {
  if (d > 0) return cal.nextWorkStart(t);
  return cal.prevWorkEnd(t) === t ? t : cal.nextWorkStart(t); // milestone may sit on a range end
}

export function finishForLatestStart(cal: WorkCalendar, latestStart: number, d: number): number {
  if (d === 0) return cal.prevWorkEnd(latestStart);
  return cal.addWork(cal.latestStartAtOrBefore(latestStart), d);
}

/** minimal binary heap */
class Heap<T> {
  private a: T[] = [];
  private cmp: (x: T, y: T) => number;
  constructor(cmp: (x: T, y: T) => number) { this.cmp = cmp; }
  get size() { return this.a.length; }
  push(v: T) {
    const a = this.a; a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]]; i = p;
    }
  }
  pop(): T | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && this.cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && this.cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]]; i = m;
      }
    }
    return top;
  }
}

export type { ConstraintType };

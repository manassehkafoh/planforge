/** Role -> permission matrix (docs/10 section 4). Deny by default; the matrix is also the data table the e2e suite iterates. */
export type Role = 'ORG_ADMIN' | 'PORTFOLIO_MANAGER' | 'PROJECT_MANAGER' | 'SCHEDULER' | 'TEAM_MEMBER' | 'VIEWER';
export const ROLES: Role[] = ['ORG_ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER', 'SCHEDULER', 'TEAM_MEMBER', 'VIEWER'];
export type Perm = 'plan.read' | 'cost.read' | 'plan.structure' | 'plan.progress' | 'plan.baseline' | 'plan.level_risk' | 'export' | 'members.manage' | 'audit.read' | 'project.archive' | 'resource.write';

export const MATRIX: Record<Perm, readonly Role[]> = {
  'plan.read':       ['ORG_ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER', 'SCHEDULER', 'TEAM_MEMBER', 'VIEWER'],
  'cost.read':       ['ORG_ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER'],
  'plan.structure':  ['ORG_ADMIN', 'PROJECT_MANAGER', 'SCHEDULER'],
  'plan.progress':   ['ORG_ADMIN', 'PROJECT_MANAGER', 'SCHEDULER', 'TEAM_MEMBER'],   // TEAM_MEMBER: assigned tasks only (checked separately)
  'plan.baseline':   ['ORG_ADMIN', 'PROJECT_MANAGER'],
  'plan.level_risk': ['ORG_ADMIN', 'PROJECT_MANAGER', 'SCHEDULER'],
  'export':          ['ORG_ADMIN', 'PORTFOLIO_MANAGER', 'PROJECT_MANAGER', 'SCHEDULER'],
  'members.manage':  ['ORG_ADMIN', 'PROJECT_MANAGER'],
  'audit.read':      ['ORG_ADMIN'],
  'project.archive': ['ORG_ADMIN', 'PROJECT_MANAGER'],
  'resource.write':  ['ORG_ADMIN', 'PROJECT_MANAGER'],
};
export const can = (role: Role | null | undefined, perm: Perm): boolean => !!role && MATRIX[perm].includes(role);
/** fields a TEAM_MEMBER may change on an assigned task */
export const PROGRESS_FIELDS = ['percentComplete', 'actualStart', 'actualFinish'] as const;

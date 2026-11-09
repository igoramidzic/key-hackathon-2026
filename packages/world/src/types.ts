export type PersonRole =
  | 'bot'
  | 'engineer'
  | 'support'
  | 'manager'
  | 'infra'
  | 'noc'
  | 'service_desk'
  | 'incident_manager'
  | 'branch'
  | 'executive';

export interface Person {
  /** Stable id, e.g. `usr_0042`. */
  id: string;
  /** ServiceNow sys_id style id (32 hex). */
  sysId: string;
  /** Cross-system key: the same username is used in ServiceNow, GitLab and Teams. */
  username: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  title: string;
  department: string;
  location: string;
  phone: string;
  role: PersonRole;
  managerUsername: string | null;
  timezone: string;
}

export type GroupType =
  | 'app_support'
  | 'noc'
  | 'service_desk'
  | 'incident_management'
  | 'infrastructure';

export interface SupportGroup {
  /** Stable id, e.g. `grp_cif_support`. */
  id: string;
  sysId: string;
  name: string;
  type: GroupType;
  description: string;
  email: string;
  managerUsername: string;
  memberUsernames: string[];
  onCall: { primary: string; secondary: string };
  /** TLAs this group supports (empty for shared groups). */
  appTlas: string[];
}

export type Stack = 'java-spring' | 'node-ts' | 'python' | 'react-web' | 'terraform';
export type RepoKind = 'service' | 'web' | 'batch' | 'infra';

export interface Repo {
  /** GitLab numeric project id. */
  id: number;
  /** Full path, e.g. `keybank/PAY00/payments-api`. */
  path: string;
  /** Group path, e.g. `keybank/PAY00`. */
  groupPath: string;
  name: string;
  tla: string;
  kind: RepoKind;
  stack: Stack;
  description: string;
  defaultBranch: 'main';
  /** Days before "now" the project was created. */
  createdDaysAgo: number;
}

export type Criticality =
  | 'Mission Critical'
  | 'Business Critical'
  | 'Business Operational'
  | 'Administrative';

export interface App {
  sysId: string;
  /** Three-letter acronym, unique, uppercase. */
  tla: string;
  name: string;
  description: string;
  tier: 1 | 2 | 3;
  criticality: Criticality;
  businessUnit: string;
  lifecycle: 'Production';
  /** Primary runtime stack of the app's main service. */
  stack: Stack;
  ownerUsername: string;
  supportGroupId: string;
  developerUsernames: string[];
  /** TLAs this app calls (its dependencies). */
  upstream: string[];
  /** TLAs that call this app (computed). */
  downstream: string[];
  /** Repo paths under `keybank/<TLA>00/`. */
  repoPaths: string[];
  /** Hand-written core banking app used by scenarios. */
  hero: boolean;
  /** True when the simulator emits live log traffic for this app. */
  emitsLogs: boolean;
  runtime: AppRuntime;
}

export interface AppRuntime {
  /** Primary service name; also the k8s container name in logs. */
  service: string;
  gcpProject: string;
  namespace: string;
  cluster: string;
  region: string;
}

export interface World {
  org: typeof import('./constants').ORG;
  seed: number;
  people: Person[];
  groups: SupportGroup[];
  apps: App[];
  repos: Repo[];
  peopleByUsername: Map<string, Person>;
  groupsById: Map<string, SupportGroup>;
  appsByTla: Map<string, App>;
  reposByPath: Map<string, Repo>;
  reposById: Map<number, Repo>;
}

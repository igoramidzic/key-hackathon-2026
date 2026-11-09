import { badRequest, notFound } from '@sim/api-kit';
import { URLS } from '@sim/contracts';
import {
  type AppDetail,
  type AppRef,
  type AppSummary,
  type Contact,
  type DependencyDirection,
  type DependencyEdge,
  type DependencyGraph,
  type DependencyNode,
  type GroupDetail,
  type GroupRef,
  type GroupSummary,
  serviceNowWebUrl,
  type UserDetail,
  type UserGroupMembership,
  type UserRef,
  type UserSummary,
} from '@sim/contracts/servicenow';
import { type App, getWorld, groupPathForTla, type Person, type SupportGroup } from '@sim/world';

/** Pseudo-user for automatic changes (e.g. auto-close), like ServiceNow's "system". */
export const SYSTEM_USER = 'system';
const SYSTEM_REF: UserRef = { username: SYSTEM_USER, name: 'System', email: '', web_url: '' };

const norm = (value: string) => value.trim().toLowerCase();

/** True when every whitespace-separated token of `q` appears in one of the fields. */
export function matchesQuery(
  q: string | undefined,
  fields: (string | null | undefined)[],
): boolean {
  if (!q?.trim()) return true;
  const haystack = fields.filter(Boolean).join(' \u0001 ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/**
 * Read-only view of the world as ServiceNow sees it: sys_user, sys_user_group and the
 * application CIs in the CMDB. Built once from `@sim/world`.
 */
export class Directory {
  readonly world = getWorld();
  private readonly usersByKey = new Map<string, Person>();
  private readonly groupsByKey = new Map<string, SupportGroup>();
  private readonly appsBySysId = new Map<string, App>();
  /** username → groups where the user is a member or the manager. */
  private readonly groupsByUser = new Map<string, SupportGroup[]>();
  readonly peopleSorted: Person[];
  readonly appsSorted: App[];

  constructor() {
    for (const person of this.world.people) {
      this.usersByKey.set(norm(person.username), person);
      this.usersByKey.set(norm(person.email), person);
      this.usersByKey.set(norm(person.sysId), person);
    }
    for (const group of this.world.groups) {
      this.groupsByKey.set(norm(group.id), group);
      this.groupsByKey.set(norm(group.sysId), group);
      this.groupsByKey.set(norm(group.name), group);
      for (const username of new Set([...group.memberUsernames, group.managerUsername])) {
        const list = this.groupsByUser.get(username) ?? [];
        list.push(group);
        this.groupsByUser.set(username, list);
      }
    }
    for (const app of this.world.apps) this.appsBySysId.set(app.sysId, app);
    this.peopleSorted = [...this.world.people].sort((a, b) => a.name.localeCompare(b.name));
    this.appsSorted = [...this.world.apps].sort((a, b) => a.tla.localeCompare(b.tla));
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** By username, email or sys_id (case-insensitive). */
  findUser(key: string): Person | undefined {
    return this.usersByKey.get(norm(key));
  }

  requireUser(key: string, field = 'user'): Person {
    const person = this.findUser(key);
    if (!person) {
      const hints = this.world.people
        .filter((p) => matchesQuery(key, [p.username, p.name, p.email]))
        .slice(0, 5)
        .map((p) => `${p.username} (${p.name})`);
      throw badRequest(
        `Unknown ${field} '${key}'. Use a username (e.g. dwhitfield), email or sys_id.` +
          (hints.length ? ` Did you mean: ${hints.join(', ')}?` : ''),
      );
    }
    return person;
  }

  /** By group id, sys_id or exact name (case-insensitive). */
  findGroup(key: string): SupportGroup | undefined {
    return this.groupsByKey.get(norm(key));
  }

  requireGroup(key: string, field = 'group'): SupportGroup {
    const group = this.findGroup(key);
    if (!group) {
      const hints = this.world.groups
        .filter((g) => matchesQuery(key.replace(/[_-]/g, ' '), [g.id.replace(/_/g, ' '), g.name]))
        .slice(0, 5)
        .map((g) => `${g.id} (${g.name})`);
      throw badRequest(
        `Unknown ${field} '${key}'. Use a group id (e.g. grp_pay_support) or exact group name.` +
          (hints.length ? ` Did you mean: ${hints.join(', ')}?` : ''),
      );
    }
    return group;
  }

  /** By TLA (case-insensitive) or sys_id. */
  findApp(key: string): App | undefined {
    return this.world.appsByTla.get(key.trim().toUpperCase()) ?? this.appsBySysId.get(norm(key));
  }

  requireApp(key: string, field = 'app_tla'): App {
    const app = this.findApp(key);
    if (!app) {
      throw badRequest(
        `Unknown ${field} '${key}'. Use a 3-letter application TLA (e.g. PAY); search_apps finds them.`,
      );
    }
    return app;
  }

  groupsOf(username: string): SupportGroup[] {
    return this.groupsByUser.get(username) ?? [];
  }

  // -------------------------------------------------------------------------
  // References
  // -------------------------------------------------------------------------

  userRef(username: string): UserRef {
    if (username === SYSTEM_USER) return SYSTEM_REF;
    const p = this.world.peopleByUsername.get(username);
    if (!p) return { username, name: username, email: '', web_url: '' };
    return {
      username: p.username,
      name: p.name,
      email: p.email,
      web_url: serviceNowWebUrl.user(p.username),
    };
  }

  contact(username: string): Contact {
    const p = this.world.peopleByUsername.get(username);
    return { ...this.userRef(username), title: p?.title ?? '', phone: p?.phone ?? '' };
  }

  groupRef(id: string): GroupRef {
    const g = this.world.groupsById.get(id);
    return { id, name: g?.name ?? id, web_url: serviceNowWebUrl.group(id) };
  }

  appRef(tla: string): AppRef {
    const a = this.world.appsByTla.get(tla);
    return { tla, name: a?.name ?? tla, tier: a?.tier ?? 3, web_url: serviceNowWebUrl.app(tla) };
  }

  /** "PAY - Payments Hub" style display value for journal entries. */
  appDisplay(tla: string): string {
    return `${tla} - ${this.world.appsByTla.get(tla)?.name ?? tla}`;
  }

  // -------------------------------------------------------------------------
  // Serializers
  // -------------------------------------------------------------------------

  userSummary(p: Person): UserSummary {
    return {
      ...this.contact(p.username),
      sys_id: p.sysId,
      department: p.department,
      location: p.location,
      role: p.role,
    };
  }

  userDetail(p: Person, openAssigned: number): UserDetail {
    const groups: UserGroupMembership[] = this.groupsOf(p.username).map((g) => ({
      ...this.groupRef(g.id),
      type: g.type,
      is_manager: g.managerUsername === p.username,
      is_member: g.memberUsernames.includes(p.username),
      on_call:
        g.onCall.primary === p.username
          ? 'primary'
          : g.onCall.secondary === p.username
            ? 'secondary'
            : null,
    }));
    const supported = new Set<string>();
    for (const g of this.groupsOf(p.username)) {
      if (g.memberUsernames.includes(p.username)) for (const tla of g.appTlas) supported.add(tla);
    }
    return {
      ...this.userSummary(p),
      timezone: p.timezone,
      manager: p.managerUsername ? this.userRef(p.managerUsername) : null,
      groups,
      supported_apps: [...supported].sort().map((tla) => this.appRef(tla)),
      owned_apps: this.appsSorted
        .filter((a) => a.ownerUsername === p.username)
        .map((a) => this.appRef(a.tla)),
      open_assigned_incident_count: openAssigned,
    };
  }

  groupSummary(g: SupportGroup): GroupSummary {
    return {
      ...this.groupRef(g.id),
      sys_id: g.sysId,
      type: g.type,
      description: g.description,
      email: g.email,
      manager: this.userRef(g.managerUsername),
      on_call: {
        primary: this.userRef(g.onCall.primary),
        secondary: this.userRef(g.onCall.secondary),
      },
      member_count: g.memberUsernames.length,
      app_count: g.appTlas.length,
    };
  }

  groupDetail(g: SupportGroup, openIncidents: number): GroupDetail {
    return {
      ...this.groupSummary(g),
      manager: this.contact(g.managerUsername),
      on_call: {
        primary: this.contact(g.onCall.primary),
        secondary: this.contact(g.onCall.secondary),
      },
      members: g.memberUsernames.map((u) => this.contact(u)),
      apps: [...g.appTlas].sort().map((tla) => this.appRef(tla)),
      open_incident_count: openIncidents,
    };
  }

  appSummary(a: App): AppSummary {
    return {
      ...this.appRef(a.tla),
      sys_id: a.sysId,
      description: a.description,
      criticality: a.criticality,
      business_unit: a.businessUnit,
      support_group: this.groupRef(a.supportGroupId),
      owner: this.userRef(a.ownerUsername),
      upstream_count: a.upstream.length,
      downstream_count: a.downstream.length,
    };
  }

  appDetail(a: App, openIncidents: number): AppDetail {
    const g = this.world.groupsById.get(a.supportGroupId)!;
    const byTier = (x: AppRef, y: AppRef) => x.tier - y.tier || x.tla.localeCompare(y.tla);
    return {
      ...this.appSummary(a),
      lifecycle: a.lifecycle,
      stack: a.stack,
      owner: this.contact(a.ownerUsername),
      support_group: {
        ...this.groupRef(g.id),
        email: g.email,
        manager: this.contact(g.managerUsername),
        on_call: {
          primary: this.contact(g.onCall.primary),
          secondary: this.contact(g.onCall.secondary),
        },
        members: g.memberUsernames.map((u) => this.contact(u)),
      },
      upstream: a.upstream.map((t) => this.appRef(t)).sort(byTier),
      downstream: a.downstream.map((t) => this.appRef(t)).sort(byTier),
      runtime: {
        service: a.runtime.service,
        gcp_project: a.runtime.gcpProject,
        namespace: a.runtime.namespace,
        cluster: a.runtime.cluster,
        region: a.runtime.region,
      },
      repos: a.repoPaths.map((path) => ({
        path,
        name: path.split('/').pop()!,
        web_url: `${URLS.gitlab.web}/${path}`,
      })),
      gitlab_group_url: `${URLS.gitlab.web}/${groupPathForTla(a.tla)}`,
      open_incident_count: openIncidents,
    };
  }

  dependencies(a: App, direction: DependencyDirection, depth: number): DependencyGraph {
    const nodes = new Map<string, DependencyNode>();
    const walk = (dir: 'up' | 'down') => {
      let frontier = [a.tla];
      for (let d = 1; d <= depth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const tla of frontier) {
          const app = this.world.appsByTla.get(tla);
          if (!app) continue;
          for (const neighbor of dir === 'up' ? app.upstream : app.downstream) {
            if (neighbor === a.tla || nodes.has(neighbor)) continue;
            const n = this.world.appsByTla.get(neighbor);
            if (!n) continue;
            nodes.set(neighbor, {
              ...this.appRef(neighbor),
              criticality: n.criticality,
              depth: d,
              direction: dir,
              support_group: this.groupRef(n.supportGroupId),
            });
            next.push(neighbor);
          }
        }
        frontier = next;
      }
    };
    if (direction !== 'down') walk('up');
    if (direction !== 'up') walk('down');

    const included = new Set([a.tla, ...nodes.keys()]);
    const edges: DependencyEdge[] = [];
    for (const tla of included) {
      const app = this.world.appsByTla.get(tla)!;
      for (const up of app.upstream) if (included.has(up)) edges.push({ from: tla, to: up });
    }
    const list = [...nodes.values()].sort(
      (x, y) =>
        x.direction.localeCompare(y.direction) ||
        x.depth - y.depth ||
        x.tier - y.tier ||
        x.tla.localeCompare(y.tla),
    );
    return { root: this.appRef(a.tla), direction, depth, nodes: list, edges };
  }
}

export function requireFound<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw notFound(message);
  return value;
}

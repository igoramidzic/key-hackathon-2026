import type {
  AppDetail,
  AppRef,
  AppSummary,
  ChangeRequest,
  ChangeRequestSummary,
  Communication,
  CommunicationSummary,
  Contact,
  DependencyGraph,
  GroupDetail,
  GroupRef,
  GroupSummary,
  Incident,
  IncidentSummary,
  JournalEntry,
  Problem,
  ProblemSummary,
  UserDetail,
  UserRef,
  UserSummary,
} from '@sim/contracts/servicenow';

/**
 * Compact, agent-friendly shapes. The REST API returns full objects (emails, web_urls on every
 * reference); tools trim them to what an agent needs to reason and act.
 */

const user = (u: UserRef | null) => (u ? { username: u.username, name: u.name } : null);
const group = (g: GroupRef | null) => (g ? { id: g.id, name: g.name } : null);
const app = (a: AppRef | null) => (a ? { tla: a.tla, name: a.name, tier: a.tier } : null);
const contact = (c: Contact) => ({
  username: c.username,
  name: c.name,
  title: c.title,
  email: c.email,
  phone: c.phone,
});

export function incidentRow(i: IncidentSummary) {
  return {
    number: i.number,
    priority: i.priority,
    state: i.state,
    short_description: i.short_description,
    app_tla: i.app?.tla ?? null,
    contact_type: i.contact_type,
    caller: user(i.caller),
    assignment_group: group(i.assignment_group),
    assigned_to: user(i.assigned_to),
    parent_incident: i.parent_incident,
    child_count: i.child_count,
    opened_at: i.opened_at,
    updated_at: i.updated_at,
  };
}

const childRow = (i: IncidentSummary) => ({
  number: i.number,
  state: i.state,
  short_description: i.short_description,
  contact_type: i.contact_type,
  caller: user(i.caller),
  opened_at: i.opened_at,
});

export function journalRow(j: JournalEntry) {
  return { at: j.created_at, type: j.type, author: j.author.username, text: j.text };
}

export function communicationRow(c: CommunicationSummary) {
  return {
    number: c.number,
    incident: c.incident,
    kind: c.kind,
    state: c.state,
    subject: c.subject,
    to: c.to,
    priority: c.priority,
    drafted_at: c.drafted_at,
    sent_at: c.sent_at,
    web_url: c.web_url,
  };
}

export function incidentFull(i: Incident) {
  return {
    number: i.number,
    sys_id: i.sys_id,
    web_url: i.web_url,
    short_description: i.short_description,
    description: i.description,
    state: i.state,
    priority: i.priority,
    impact: i.impact,
    urgency: i.urgency,
    category: i.category,
    subcategory: i.subcategory,
    contact_type: i.contact_type,
    app: app(i.app),
    caller: user(i.caller),
    opened_by: i.opened_by.username,
    assignment_group: group(i.assignment_group),
    assigned_to: user(i.assigned_to),
    opened_at: i.opened_at,
    updated_at: i.updated_at,
    resolved_at: i.resolved_at,
    resolved_by: i.resolved_by?.username ?? null,
    closed_at: i.closed_at,
    close_code: i.close_code,
    close_notes: i.close_notes,
    affected_cis: i.affected_cis.map((a) => a.tla),
    outage_start: i.outage_start,
    service_restored_at: i.service_restored_at,
    outage_duration_minutes: i.outage_duration_minutes,
    cause_code: i.cause_code,
    caused_by_change: i.caused_by_change,
    resolved_by_change: i.resolved_by_change,
    root_cause: i.root_cause,
    client_impact: i.client_impact,
    employee_impact: i.employee_impact,
    problem: i.problem,
    communications: i.communications.map(communicationRow),
    reassignment_count: i.reassignment_count,
    links: i.links.map((l) => ({ type: l.type, title: l.title, url: l.url })),
    parent_incident: i.parent_incident,
    child_incidents: i.child_incidents.map(childRow),
    journal: i.journal.map(journalRow),
  };
}

export function appRow(a: AppSummary) {
  return {
    tla: a.tla,
    name: a.name,
    tier: a.tier,
    criticality: a.criticality,
    business_unit: a.business_unit,
    support_group: group(a.support_group),
  };
}

const DOWNSTREAM_LIMIT = 25;

export function appFull(a: AppDetail) {
  const sg = a.support_group;
  return {
    tla: a.tla,
    name: a.name,
    description: a.description,
    tier: a.tier,
    criticality: a.criticality,
    business_unit: a.business_unit,
    stack: a.stack,
    web_url: a.web_url,
    owner: contact(a.owner),
    support_group: {
      id: sg.id,
      name: sg.name,
      email: sg.email,
      manager: contact(sg.manager),
      on_call: { primary: contact(sg.on_call.primary), secondary: contact(sg.on_call.secondary) },
      members: sg.members.map((m) => ({ username: m.username, name: m.name, title: m.title })),
    },
    upstream: a.upstream.map(app),
    downstream_count: a.downstream.length,
    downstream: a.downstream.slice(0, DOWNSTREAM_LIMIT).map(app),
    ...(a.downstream.length > DOWNSTREAM_LIMIT
      ? {
          downstream_note: `Showing the ${DOWNSTREAM_LIMIT} most critical of ${a.downstream.length} callers; use get_app_dependencies for all.`,
        }
      : {}),
    runtime: a.runtime,
    repos: a.repos.map((r) => r.path),
    gitlab_group_url: a.gitlab_group_url,
    open_incident_count: a.open_incident_count,
  };
}

export function dependencyGraph(g: DependencyGraph) {
  return {
    root: app(g.root),
    direction: g.direction,
    depth: g.depth,
    node_count: g.nodes.length,
    nodes: g.nodes.map((n) => ({
      tla: n.tla,
      name: n.name,
      tier: n.tier,
      depth: n.depth,
      direction: n.direction,
      support_group: n.support_group.id,
    })),
    edges: g.edges.map((e) => `${e.from}->${e.to}`),
  };
}

export function groupRow(g: GroupSummary) {
  return {
    id: g.id,
    name: g.name,
    type: g.type,
    app_count: g.app_count,
    member_count: g.member_count,
    manager: user(g.manager),
    on_call: { primary: user(g.on_call.primary), secondary: user(g.on_call.secondary) },
  };
}

export function groupFull(g: GroupDetail) {
  return {
    id: g.id,
    name: g.name,
    type: g.type,
    description: g.description,
    email: g.email,
    web_url: g.web_url,
    manager: contact(g.manager),
    on_call: { primary: contact(g.on_call.primary), secondary: contact(g.on_call.secondary) },
    members: g.members.map(contact),
    apps: g.apps.map(app),
    open_incident_count: g.open_incident_count,
  };
}

export function userRow(u: UserSummary) {
  return {
    username: u.username,
    name: u.name,
    title: u.title,
    department: u.department,
    email: u.email,
  };
}

export function userFull(u: UserDetail) {
  return {
    username: u.username,
    name: u.name,
    title: u.title,
    department: u.department,
    role: u.role,
    location: u.location,
    timezone: u.timezone,
    email: u.email,
    phone: u.phone,
    web_url: u.web_url,
    manager: user(u.manager),
    groups: u.groups.map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      is_manager: g.is_manager,
      is_member: g.is_member,
      on_call: g.on_call,
    })),
    supported_apps: u.supported_apps.map((a) => a.tla),
    owned_apps: u.owned_apps.map((a) => a.tla),
    open_assigned_incident_count: u.open_assigned_incident_count,
  };
}

export function changeRow(c: ChangeRequestSummary) {
  return {
    number: c.number,
    state: c.state,
    type: c.type,
    short_description: c.short_description,
    app_tla: c.app.tla,
    projects: c.projects,
    merge_request_count: c.merge_request_count,
    requested_by: user(c.requested_by),
    planned_start: c.planned_start,
    implemented_at: c.implemented_at,
    release: c.release.id ? `${c.release.id} (${c.release.status})` : c.release.status,
    related_incidents: c.related_incidents,
    web_url: c.web_url,
  };
}

export function changeFull(c: ChangeRequest) {
  return {
    number: c.number,
    sys_id: c.sys_id,
    web_url: c.web_url,
    short_description: c.short_description,
    description: c.description,
    state: c.state,
    type: c.type,
    risk: c.risk,
    app: app(c.app),
    requested_by: user(c.requested_by),
    assignment_group: group(c.assignment_group),
    planned_start: c.planned_start,
    implemented_at: c.implemented_at,
    close_code: c.close_code,
    close_notes: c.close_notes,
    release: c.release,
    merge_requests: c.merge_requests.map((m) => ({
      reference: m.reference,
      title: m.title,
      state: m.state,
      merge_commit_sha: m.merge_commit_sha,
      web_url: m.web_url,
    })),
    deployments: c.deployments,
    related_incidents: c.related_incidents,
    backout_plan: c.backout_plan,
    opened_at: c.opened_at,
    updated_at: c.updated_at,
    journal: c.journal.map(journalRow),
  };
}

export function communicationFull(c: Communication) {
  return {
    number: c.number,
    web_url: c.web_url,
    incident: c.incident,
    kind: c.kind,
    state: c.state,
    subject: c.subject,
    from: c.from,
    to: c.to,
    priority: c.priority,
    title: c.title,
    start: c.start,
    resolved: c.resolved,
    duration_minutes: c.duration_minutes,
    systems_impacted: c.systems_impacted.map((a) => a.tla),
    description: c.description,
    client_impact: c.client_impact,
    employee_impact: c.employee_impact,
    cause: c.cause,
    resolution_activities: c.resolution_activities,
    incident_manager: user(c.incident_manager),
    communication_specialist: user(c.communication_specialist),
    technology_owners: c.technology_owners.map(user),
    drafted_by: c.drafted_by.username,
    drafted_at: c.drafted_at,
    updated_at: c.updated_at,
    sent_by: c.sent_by?.username ?? null,
    sent_at: c.sent_at,
  };
}

export function problemRow(p: ProblemSummary) {
  return {
    number: p.number,
    state: p.state,
    priority: p.priority,
    incident_priority: p.incident_priority,
    short_description: p.short_description,
    app_tla: p.app?.tla ?? null,
    cause_code: p.cause_code,
    chronic: p.chronic,
    proactive: p.proactive,
    assignment_group: group(p.assignment_group),
    assigned_to: user(p.assigned_to),
    problem_coordinator: user(p.problem_coordinator),
    incidents: p.incidents,
    standup_date: p.standup_date,
    opened_at: p.opened_at,
    updated_at: p.updated_at,
    web_url: p.web_url,
  };
}

export function problemFull(p: Problem) {
  return {
    number: p.number,
    sys_id: p.sys_id,
    web_url: p.web_url,
    short_description: p.short_description,
    description: p.description,
    state: p.state,
    priority: p.priority,
    incident_priority: p.incident_priority,
    app: app(p.app),
    cause_code: p.cause_code,
    chronic: p.chronic,
    proactive: p.proactive,
    assignment_group: group(p.assignment_group),
    assigned_to: user(p.assigned_to),
    problem_coordinator: user(p.problem_coordinator),
    standup_date: p.standup_date,
    root_cause: p.root_cause,
    workaround: p.workaround,
    mitigation_plan: p.mitigation_plan,
    action_items: p.action_items,
    change_request: p.change_request,
    caused_by_change: p.caused_by_change,
    vendor: p.vendor,
    client_impact: p.client_impact,
    employee_impact: p.employee_impact,
    incidents: p.incidents,
    related_incidents: p.related_incidents.map((i) => ({
      number: i.number,
      priority: i.priority,
      state: i.state,
      short_description: i.short_description,
      app_tla: i.app?.tla ?? null,
      opened_at: i.opened_at,
      resolved_at: i.resolved_at,
    })),
    opened_by: p.opened_by.username,
    opened_at: p.opened_at,
    updated_at: p.updated_at,
    journal: p.journal.map(journalRow),
  };
}

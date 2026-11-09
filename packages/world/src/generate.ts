import { BRANCHES, ORG, PERSONAS, SHARED_GROUP_IDS, TECH_LOCATIONS, WORLD_SEED } from './constants';
import { HERO_APPS, HERO_TLAS } from './hero';
import { NAMES } from './names.generated';
import { Rng, slugify, sysId } from './random';
import type {
  App,
  AppRuntime,
  Criticality,
  GroupType,
  Person,
  PersonRole,
  Repo,
  Stack,
  SupportGroup,
  World,
} from './types';
import {
  DOMAINS,
  type DomainSpec,
  SUFFIXES,
  type SuffixSpec,
  TITLES,
  TLA_BLOCKLIST,
} from './vocab';

const GENERATED_APP_COUNT = 385;
const GENERATED_LOGGING_APPS = 45;

const ROLE_PLAN: { role: PersonRole; count: number; department: string | string[] }[] = [
  {
    role: 'engineer',
    count: 640,
    department: [
      'Digital Technology',
      'Payments Technology',
      'Core Banking Technology',
      'Enterprise Platforms',
      'Risk Technology',
      'Commercial Technology',
      'Data & Analytics',
    ],
  },
  { role: 'support', count: 200, department: 'Production Support' },
  {
    role: 'manager',
    count: 110,
    department: [
      'Digital Technology',
      'Payments Technology',
      'Core Banking Technology',
      'Enterprise Platforms',
    ],
  },
  { role: 'infra', count: 70, department: 'Infrastructure Services' },
  { role: 'noc', count: 12, department: 'Technology Operations' },
  { role: 'service_desk', count: 17, department: 'IT Service Desk' },
  { role: 'incident_manager', count: 7, department: 'Technology Operations' },
  { role: 'branch', count: 128, department: 'Branch Banking' },
  { role: 'executive', count: 8, department: 'Office of the CIO' },
];

interface PersonaSpec {
  username: string;
  firstName: string;
  lastName: string;
  title: string;
  role: PersonRole;
  department: string;
  location: string;
  email?: string;
}

const PERSONA_SPECS: PersonaSpec[] = [
  {
    username: PERSONAS.incidentBot,
    firstName: 'Incident',
    lastName: 'Automation',
    title: 'Service Account',
    role: 'bot',
    department: 'Technology Operations',
    location: 'Cleveland, OH',
    email: `incident-automation@${ORG.emailDomain}`,
  },
  {
    username: PERSONAS.nocLead,
    firstName: 'Dana',
    lastName: 'Whitfield',
    title: 'NOC Shift Lead',
    role: 'noc',
    department: 'Technology Operations',
    location: 'Cleveland, OH',
  },
  {
    username: PERSONAS.nocAnalyst,
    firstName: 'Marcus',
    lastName: 'Bell',
    title: 'Senior NOC Analyst',
    role: 'noc',
    department: 'Technology Operations',
    location: 'Cleveland, OH',
  },
  {
    username: PERSONAS.serviceDeskAnalyst,
    firstName: 'Priya',
    lastName: 'Natarajan',
    title: 'Service Desk Analyst',
    role: 'service_desk',
    department: 'IT Service Desk',
    location: 'Brooklyn, OH',
  },
  {
    username: PERSONAS.majorIncidentManager,
    firstName: 'Tom',
    lastName: 'Okafor',
    title: 'Major Incident Manager',
    role: 'incident_manager',
    department: 'Technology Operations',
    location: 'Cleveland, OH',
  },
  {
    username: PERSONAS.branchManager,
    firstName: 'Maria',
    lastName: 'Lopez',
    title: 'Branch Manager',
    role: 'branch',
    department: 'Branch Banking',
    location: 'Cleveland Main Branch',
  },
  {
    username: PERSONAS.headTeller,
    firstName: 'Kevin',
    lastName: 'Brandt',
    title: 'Head Teller',
    role: 'branch',
    department: 'Branch Banking',
    location: 'Buffalo Elmwood Branch',
  },
];

const AREA_CODES: Record<string, string> = {
  OH: '216',
  NY: '716',
  WA: '253',
  CO: '303',
  ID: '208',
  AK: '907',
  OR: '503',
};

function stateOf(location: string): string {
  const match = location.match(/,\s*([A-Z]{2})$/);
  if (match) return match[1]!;
  if (/Cleveland|Lakewood|Akron/.test(location)) return 'OH';
  if (/Buffalo|Albany|Syracuse/.test(location)) return 'NY';
  if (/Seattle|Tacoma/.test(location)) return 'WA';
  if (/Denver/.test(location)) return 'CO';
  if (/Boise/.test(location)) return 'ID';
  if (/Anchorage/.test(location)) return 'AK';
  if (/Portland/.test(location)) return 'OR';
  return 'OH';
}

function timezoneOf(location: string): string {
  switch (stateOf(location)) {
    case 'WA':
    case 'OR':
      return 'America/Los_Angeles';
    case 'CO':
      return 'America/Denver';
    case 'ID':
      return 'America/Boise';
    case 'AK':
      return 'America/Anchorage';
    default:
      return 'America/New_York';
  }
}

function buildPeople(rng: Rng): Person[] {
  const people: Person[] = [];
  const taken = new Set<string>();
  let counter = 0;

  const add = (spec: PersonaSpec) => {
    counter++;
    const state = stateOf(spec.location);
    const person: Person = {
      id: `usr_${String(counter).padStart(4, '0')}`,
      sysId: sysId(`person:${spec.username}`),
      username: spec.username,
      firstName: spec.firstName,
      lastName: spec.lastName,
      name: `${spec.firstName} ${spec.lastName}`,
      email:
        spec.email ??
        `${`${spec.firstName}.${spec.lastName}`.toLowerCase().replace(/[^a-z.]/g, '')}@${ORG.emailDomain}`,
      title: spec.title,
      department: spec.department,
      location: spec.location,
      phone: `(${AREA_CODES[state] ?? '216'}) 555-${String(rng.int(100, 9999)).padStart(4, '0')}`,
      role: spec.role,
      managerUsername: null,
      timezone: timezoneOf(spec.location),
    };
    taken.add(spec.username);
    people.push(person);
    return person;
  };

  for (const persona of PERSONA_SPECS) add(persona);

  const emails = new Set(people.map((p) => p.email));
  let drawn = 0;
  for (const plan of ROLE_PLAN) {
    for (let i = 0; i < plan.count; i++) {
      const [firstName, lastName] = NAMES[drawn++]!;
      const base = `${firstName[0]}${lastName}`.toLowerCase().replace(/[^a-z]/g, '');
      let username = base;
      let n = 2;
      while (taken.has(username)) username = `${base}${n++}`;
      let email = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '');
      let emailCandidate = `${email}@${ORG.emailDomain}`;
      let m = 2;
      while (emails.has(emailCandidate)) emailCandidate = `${email}${m++}@${ORG.emailDomain}`;
      email = emailCandidate;
      emails.add(email);
      const location =
        plan.role === 'branch' ? rng.pick(BRANCHES) : rng.pick(TECH_LOCATIONS as readonly string[]);
      const department = Array.isArray(plan.department)
        ? rng.pick(plan.department)
        : plan.department;
      const spec: PersonaSpec = {
        username,
        firstName,
        lastName,
        title: rng.pick(TITLES[plan.role]!),
        role: plan.role,
        department,
        location,
        email,
      };
      add(spec);
    }
  }

  // Reporting lines.
  const byRole = (role: PersonRole) => people.filter((p) => p.role === role);
  const managers = byRole('manager');
  const executives = byRole('executive');
  const opsExec = executives.find((e) => e.title.includes('Operations')) ?? executives[0]!;
  const branchManagers = people.filter((p) => p.role === 'branch' && p.title === 'Branch Manager');
  for (const person of people) {
    switch (person.role) {
      case 'engineer':
      case 'support':
      case 'infra':
        person.managerUsername = rng.pick(managers).username;
        break;
      case 'manager':
        person.managerUsername = rng.pick(executives).username;
        break;
      case 'noc':
        person.managerUsername =
          person.username === PERSONAS.nocLead ? opsExec.username : PERSONAS.nocLead;
        break;
      case 'service_desk':
      case 'incident_manager':
        person.managerUsername = opsExec.username;
        break;
      case 'branch': {
        if (person.title === 'Branch Manager') break;
        const local = branchManagers.find((m) => m.location === person.location);
        person.managerUsername = local?.username ?? null;
        break;
      }
      default:
        break;
    }
  }
  return people;
}

function tlaCandidates(name: string, rng: Rng): string[] {
  const words = name
    .replace(/&/g, ' ')
    .split(/[\s-]+/)
    .map((w) => w.toUpperCase().replace(/[^A-Z]/g, ''))
    .filter(Boolean);
  const out: string[] = [];
  const w = words;
  if (w.length >= 3) out.push(w[0]![0]! + w[1]![0]! + w[2]![0]!);
  if (w.length >= 4) out.push(w[0]![0]! + w[2]![0]! + w[3]![0]!, w[0]![0]! + w[1]![0]! + w[3]![0]!);
  if (w.length >= 2) {
    const last = w[w.length - 1]!;
    out.push(
      w[0]![0]! + w[1]![0]! + (w[1]![1] ?? 'X'),
      w[0]![0]! + (w[0]![1] ?? 'X') + w[1]![0]!,
      w[0]![0]! + w[1]![0]! + last[last.length - 1]!,
      w[0]!.slice(0, 2) + last[0]!,
    );
  }
  if (w[0]!.length >= 3) out.push(w[0]!.slice(0, 3));
  const letters = w.join('');
  for (let i = 0; i < 12; i++) {
    out.push(
      w[0]![0]! +
        letters[rng.int(1, letters.length - 1)]! +
        letters[rng.int(1, letters.length - 1)]!,
    );
  }
  return out.filter((c) => /^[A-Z]{3}$/.test(c));
}

function criticalityFor(tier: 1 | 2 | 3, rng: Rng): Criticality {
  if (tier === 1) return 'Mission Critical';
  if (tier === 2) return 'Business Critical';
  return rng.chance(0.75) ? 'Business Operational' : 'Administrative';
}

function runtimeFor(tla: string, service: string, businessUnit: string): AppRuntime {
  const lower = tla.toLowerCase();
  const west = ['Wealth Management', 'Cards'].includes(businessUnit);
  const clusterIndex = (lower.charCodeAt(0) % 3) + 1;
  return {
    service,
    gcpProject: `${ORG.gcpProjectPrefix}-${lower}00`,
    namespace: `${lower}00`,
    cluster: west ? `gke-prod-usw1-0${clusterIndex}` : `gke-prod-use4-0${clusterIndex}`,
    region: west ? 'us-west1' : 'us-east4',
  };
}

const BU_DEPENDENCIES: Record<string, [string, number][]> = {
  Payments: [
    ['PAY', 0.35],
    ['ACH', 0.25],
    ['ABA', 0.25],
    ['WIR', 0.15],
  ],
  Cards: [
    ['CRD', 0.6],
    ['FRD', 0.4],
  ],
  'Branch Banking': [
    ['TLR', 0.4],
    ['DEP', 0.4],
  ],
  'Consumer Banking': [['DEP', 0.4]],
  'Consumer Lending': [
    ['DEP', 0.3],
    ['GLD', 0.2],
  ],
  'Commercial Banking': [
    ['PAY', 0.25],
    ['ACH', 0.2],
    ['WIR', 0.2],
  ],
  'Risk & Compliance': [['FRD', 0.25]],
  'Finance Technology': [['GLD', 0.5]],
  'Digital Banking': [
    ['NTF', 0.3],
    ['DEP', 0.3],
  ],
};

const CORE_DEPENDENCIES: [string, number][] = [
  ['ATH', 0.7],
  ['CIF', 0.45],
  ['DEP', 0.12],
  ['NTF', 0.12],
  ['GLD', 0.1],
];

interface GeneratedAppDraft {
  name: string;
  tla: string;
  domain: DomainSpec;
  suffix: SuffixSpec;
}

function draftGeneratedApps(rng: Rng): GeneratedAppDraft[] {
  const combos: { domain: DomainSpec; suffix: SuffixSpec }[] = [];
  for (const domain of DOMAINS) for (const suffix of SUFFIXES) combos.push({ domain, suffix });
  const shuffled = rng.shuffle(combos);
  const used = new Set<string>(HERO_TLAS);
  const drafts: GeneratedAppDraft[] = [];
  for (const combo of shuffled) {
    if (drafts.length >= GENERATED_APP_COUNT) break;
    const name = `${combo.domain.domain} ${combo.suffix.suffix}`;
    const tla = tlaCandidates(name, rng).find((c) => !used.has(c) && !TLA_BLOCKLIST.has(c));
    if (!tla) continue;
    used.add(tla);
    drafts.push({ name, tla, ...combo });
  }
  return drafts;
}

export function buildWorld(): World {
  const rng = new Rng(`world:${WORLD_SEED}`);
  const people = buildPeople(new Rng(`people:${WORLD_SEED}`));
  const pool = (role: PersonRole) => people.filter((p) => p.role === role);
  const managers = pool('manager');
  const supportPool = rng.shuffle(pool('support'));
  const engineerPool = rng.shuffle(pool('engineer'));

  // ----- Apps (drafts first so groups and teams can be sized) -----
  const drafts = draftGeneratedApps(new Rng(`apps:${WORLD_SEED}`));

  // ----- Support groups -----
  const groups: SupportGroup[] = [];
  let supportCursor = 0;
  const takeSupport = (count: number) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(supportPool[supportCursor % supportPool.length]!.username);
      supportCursor++;
    }
    return [...new Set(out)];
  };

  const makeGroup = (
    id: string,
    name: string,
    type: GroupType,
    description: string,
    members: string[],
    managerUsername: string,
    appTlas: string[] = [],
  ): SupportGroup => {
    const preferred = members.filter((u) => {
      const p = people.find((x) => x.username === u);
      return p && (p.role === 'support' || p.role === 'noc' || p.role === 'infra');
    });
    const onCallPool = preferred.length >= 2 ? preferred : members;
    const [primary, secondary] = rng.pickN(onCallPool, 2);
    const group: SupportGroup = {
      id,
      sysId: sysId(`group:${id}`),
      name,
      type,
      description,
      email: `${slugify(name)}@${ORG.emailDomain}`,
      managerUsername,
      memberUsernames: members,
      onCall: { primary: primary ?? members[0]!, secondary: secondary ?? primary ?? members[0]! },
      appTlas,
    };
    groups.push(group);
    return group;
  };

  const infra = pool('infra');
  const infraBy = (re: RegExp) => infra.filter((p) => re.test(p.title)).map((p) => p.username);
  const execOps =
    pool('executive').find((p) => p.title.includes('Operations')) ?? pool('executive')[0]!;
  makeGroup(
    SHARED_GROUP_IDS.noc,
    'Enterprise Command Center (NOC)',
    'noc',
    '24x7 network operations center. Owns incident triage, bridges and stakeholder communication.',
    pool('noc').map((p) => p.username),
    PERSONAS.nocLead,
  );
  makeGroup(
    SHARED_GROUP_IDS.serviceDesk,
    'IT Service Desk',
    'service_desk',
    'First line support for associates and branches. Takes calls and opens incidents.',
    pool('service_desk').map((p) => p.username),
    execOps.username,
  );
  makeGroup(
    SHARED_GROUP_IDS.majorIncident,
    'Major Incident Management',
    'incident_management',
    'Coordinates P1/P2 incidents, executive communication and post-incident reviews.',
    pool('incident_manager').map((p) => p.username),
    execOps.username,
  );
  makeGroup(
    SHARED_GROUP_IDS.dba,
    'Database Administration',
    'infrastructure',
    'Oracle, PostgreSQL and Db2 database support.',
    infraBy(/Database/),
    rng.pick(managers).username,
  );
  makeGroup(
    SHARED_GROUP_IDS.network,
    'Network Engineering',
    'infrastructure',
    'WAN, LAN, load balancers and firewalls.',
    infraBy(/Network/),
    rng.pick(managers).username,
  );
  makeGroup(
    SHARED_GROUP_IDS.cloud,
    'Cloud Platform Engineering',
    'infrastructure',
    'GCP landing zones, GKE clusters and CI/CD runners.',
    infraBy(/Cloud/),
    rng.pick(managers).username,
  );
  makeGroup(
    SHARED_GROUP_IDS.middleware,
    'Middleware & Integration',
    'infrastructure',
    'MQ, Kafka, API gateway and ESB support.',
    infraBy(/Middleware/),
    rng.pick(managers).username,
  );
  makeGroup(
    SHARED_GROUP_IDS.secops,
    'Security Operations',
    'infrastructure',
    'Security monitoring and incident response.',
    infraBy(/Security/),
    rng.pick(managers).username,
  );

  // ----- Engineering teams: hero apps get dedicated devs, domains share a team -----
  let engCursor = 0;
  const takeEngineers = (count: number) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(engineerPool[engCursor % engineerPool.length]!.username);
      engCursor++;
    }
    return out;
  };

  const heroDevs = new Map<string, string[]>();
  for (const hero of HERO_APPS) heroDevs.set(hero.tla, takeEngineers(rng.int(5, 8)));

  const domainGroupNames = [...new Set(drafts.map((d) => d.domain.group))];
  const domainTeams = new Map<string, string[]>();
  const perTeam = Math.floor((engineerPool.length - engCursor) / domainGroupNames.length);
  for (const groupName of domainGroupNames) domainTeams.set(groupName, takeEngineers(perTeam));

  // Hero support groups.
  for (const hero of HERO_APPS) {
    const devs = heroDevs.get(hero.tla)!;
    const members = [...takeSupport(rng.int(3, 5)), ...rng.pickN(devs, 2)];
    makeGroup(
      `grp_${hero.tla.toLowerCase()}_support`,
      `${hero.tla} Application Support`,
      'app_support',
      `L2 support for ${hero.name} (${hero.tla}).`,
      [...new Set(members)],
      rng.pick(managers).username,
      [hero.tla],
    );
  }
  // Domain support groups.
  const domainGroupIds = new Map<string, string>();
  for (const groupName of domainGroupNames) {
    const team = domainTeams.get(groupName)!;
    const members = [...takeSupport(rng.int(3, 6)), ...rng.pickN(team, rng.int(1, 2))];
    const id = `grp_${slugify(groupName).replace(/-/g, '_')}`;
    domainGroupIds.set(groupName, id);
    makeGroup(
      id,
      groupName,
      'app_support',
      `L2 application support for the ${groupName.replace(/ (Support|Technology)$/, '')} portfolio.`,
      [...new Set(members)],
      rng.pick(managers).username,
    );
  }
  const groupsById = new Map(groups.map((g) => [g.id, g]));

  // ----- Apps -----
  const apps: App[] = [];
  for (const hero of HERO_APPS) {
    const service = hero.repos[0]!.name;
    apps.push({
      sysId: sysId(`app:${hero.tla}`),
      tla: hero.tla,
      name: hero.name,
      description: hero.description,
      tier: hero.tier,
      criticality: criticalityFor(hero.tier, rng),
      businessUnit: hero.businessUnit,
      lifecycle: 'Production',
      stack: hero.stack,
      ownerUsername: rng.pick(managers).username,
      supportGroupId: `grp_${hero.tla.toLowerCase()}_support`,
      developerUsernames: heroDevs.get(hero.tla)!,
      upstream: [...hero.upstream],
      downstream: [],
      repoPaths: hero.repos.map((r) => `${ORG.slug}/${hero.tla}00/${r.name}`),
      hero: true,
      emitsLogs: true,
      runtime: runtimeFor(hero.tla, service, hero.businessUnit),
    });
  }

  const generatedTlas: string[] = [];
  const appRng = new Rng(`app-details:${WORLD_SEED}`);
  for (const draft of drafts) {
    const tier = appRng.weighted<1 | 2 | 3>([
      [1, 10],
      [2, 35],
      [3, 55],
    ]);
    const stack = appRng.weighted<Stack>([
      ['java-spring', 50],
      ['node-ts', 35],
      ['python', 15],
    ]);
    const upstream = new Set<string>();
    for (const [tla, p] of CORE_DEPENDENCIES) if (appRng.chance(p)) upstream.add(tla);
    for (const [tla, p] of BU_DEPENDENCIES[draft.domain.businessUnit] ?? []) {
      if (appRng.chance(p)) upstream.add(tla);
    }
    const peers = generatedTlas.filter((t) => {
      const a = apps.find((x) => x.tla === t);
      return a?.businessUnit === draft.domain.businessUnit;
    });
    if (peers.length > 0) {
      for (const peer of appRng.pickN(peers, appRng.int(0, 2))) upstream.add(peer);
    }
    if (upstream.size === 0) upstream.add('ATH');

    const slug = slugify(draft.name);
    const hasWeb = draft.suffix.web === true || appRng.chance(0.12);
    const primary = hasWeb && !slug.endsWith('-api') ? `${slug}-api` : slug;
    const repoNames = [primary];
    if (hasWeb) repoNames.push(`${slug}-web`);
    if ((draft.suffix.batch === true || appRng.chance(0.2)) && !slug.includes('batch')) {
      repoNames.push(`${slug}-batch`);
    }
    if (appRng.chance(0.35)) repoNames.push(`${slug}-infra`);
    const team = domainTeams.get(draft.domain.group)!;
    const description = draft.suffix.description.replace('{d}', draft.domain.domain.toLowerCase());
    apps.push({
      sysId: sysId(`app:${draft.tla}`),
      tla: draft.tla,
      name: draft.name,
      description,
      tier,
      criticality: criticalityFor(tier, appRng),
      businessUnit: draft.domain.businessUnit,
      lifecycle: 'Production',
      stack,
      ownerUsername: appRng.pick(managers).username,
      supportGroupId: domainGroupIds.get(draft.domain.group)!,
      developerUsernames: appRng.pickN(team, appRng.int(3, 6)),
      upstream: [...upstream].sort(),
      downstream: [],
      repoPaths: repoNames.map((r) => `${ORG.slug}/${draft.tla}00/${r}`),
      hero: false,
      emitsLogs: false,
      runtime: runtimeFor(draft.tla, primary, draft.domain.businessUnit),
    });
    generatedTlas.push(draft.tla);
  }

  const appsByTla = new Map(apps.map((a) => [a.tla, a]));
  for (const app of apps) {
    for (const up of app.upstream) appsByTla.get(up)?.downstream.push(app.tla);
  }
  for (const app of apps) app.downstream.sort();
  for (const group of groups) {
    if (group.type === 'app_support' && group.appTlas.length === 0) {
      group.appTlas = apps.filter((a) => a.supportGroupId === group.id).map((a) => a.tla);
    }
  }

  // Generated apps that emit live logs: mostly tier 1/2 consumers of CIF or ATH.
  const logRng = new Rng(`logging:${WORLD_SEED}`);
  const generated = apps.filter((a) => !a.hero);
  const cascadeCandidates = logRng.shuffle(
    generated.filter(
      (a) => a.tier <= 2 && (a.upstream.includes('CIF') || a.upstream.includes('ATH')),
    ),
  );
  const chosen = new Set(cascadeCandidates.slice(0, 30).map((a) => a.tla));
  for (const app of logRng.shuffle(generated)) {
    if (chosen.size >= GENERATED_LOGGING_APPS) break;
    chosen.add(app.tla);
  }
  for (const app of generated) app.emitsLogs = chosen.has(app.tla);

  // ----- Repos -----
  const repos: Repo[] = [];
  const repoRng = new Rng(`repos:${WORLD_SEED}`);
  let repoId = 1001;
  for (const app of apps) {
    const heroSpec = HERO_APPS.find((h) => h.tla === app.tla);
    for (const path of app.repoPaths) {
      const name = path.split('/').pop()!;
      const spec = heroSpec?.repos.find((r) => r.name === name);
      let kind: Repo['kind'] = 'service';
      let stack: Stack = app.stack;
      let description = app.description;
      if (spec) {
        kind = spec.kind;
        stack = spec.stack;
        description = spec.description;
      } else if (name.endsWith('-web')) {
        kind = 'web';
        stack = 'react-web';
        description = `Web front end for ${app.name}.`;
      } else if (name.endsWith('-batch')) {
        kind = 'batch';
        description = `Scheduled batch jobs for ${app.name}.`;
      } else if (name.endsWith('-infra')) {
        kind = 'infra';
        stack = 'terraform';
        description = `Terraform for ${app.name} GCP infrastructure.`;
      }
      repos.push({
        id: repoId++,
        path,
        groupPath: `${ORG.slug}/${app.tla}00`,
        name,
        tla: app.tla,
        kind,
        stack,
        description,
        defaultBranch: 'main',
        createdDaysAgo: repoRng.int(240, 2400),
      });
    }
  }

  return {
    org: ORG,
    seed: WORLD_SEED,
    people,
    groups,
    apps,
    repos,
    peopleByUsername: new Map(people.map((p) => [p.username, p])),
    groupsById,
    appsByTla,
    reposByPath: new Map(repos.map((r) => [r.path, r])),
    reposById: new Map(repos.map((r) => [r.id, r])),
  };
}

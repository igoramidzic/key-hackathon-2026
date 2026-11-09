import { notFound } from '@sim/api-kit';
import { URLS } from '@sim/contracts';
import type { Presence, TeamsUser } from '@sim/contracts/teams';
import { getWorld, hashString, PERSONAS, type Person } from '@sim/world';

/** Persona usernames in demo order; listed first when browsing users. */
const PERSONA_ORDER: string[] = [
  PERSONAS.nocLead,
  PERSONAS.nocAnalyst,
  PERSONAS.majorIncidentManager,
  PERSONAS.serviceDeskAnalyst,
  PERSONAS.branchManager,
  PERSONAS.headTeller,
  PERSONAS.incidentBot,
];

const ALWAYS_AVAILABLE = new Set<string>([
  PERSONAS.incidentBot,
  PERSONAS.nocLead,
  PERSONAS.nocAnalyst,
]);

function presenceFor(person: Person): Presence {
  if (ALWAYS_AVAILABLE.has(person.username)) return 'available';
  const roll = hashString(`presence:${person.username}`) % 100;
  if (roll < 52) return 'available';
  if (roll < 72) return 'busy';
  if (roll < 86) return 'away';
  return 'offline';
}

export function activityUrl(username: string): string {
  return `${URLS.teams.web}/activity?user=${encodeURIComponent(username)}`;
}

export function toTeamsUser(person: Person): TeamsUser {
  return {
    username: person.username,
    name: person.name,
    email: person.email,
    title: person.title,
    department: person.department,
    location: person.location,
    presence: presenceFor(person),
    is_bot: person.role === 'bot',
    web_url: activityUrl(person.username),
  };
}

let byEmail: Map<string, Person> | null = null;
let byName: Map<string, Person[]> | null = null;

function indexes() {
  if (!byEmail || !byName) {
    byEmail = new Map();
    byName = new Map();
    for (const person of getWorld().people) {
      byEmail.set(person.email.toLowerCase(), person);
      const key = person.name.toLowerCase();
      byName.set(key, [...(byName.get(key) ?? []), person]);
    }
  }
  return { byEmail, byName };
}

/** Resolves a username, email or unique full name. Returns undefined when unknown. */
export function findPerson(input: string): Person | undefined {
  const key = input.trim().replace(/^@/, '');
  if (!key) return undefined;
  const world = getWorld();
  const direct = world.peopleByUsername.get(key) ?? world.peopleByUsername.get(key.toLowerCase());
  if (direct) return direct;
  const { byEmail, byName } = indexes();
  if (key.includes('@')) return byEmail.get(key.toLowerCase());
  const named = byName.get(key.toLowerCase());
  return named?.length === 1 ? named[0] : undefined;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = temp;
    }
  }
  return prev[b.length]!;
}

/** Close matches for an unknown user reference, best first. */
export function suggestPeople(input: string, max = 5): Person[] {
  const q = input.trim().replace(/^@/, '').toLowerCase();
  if (!q) return [];
  const local = q.includes('@') ? q.split('@')[0]! : q;
  const scored: { person: Person; score: number }[] = [];
  for (const person of getWorld().people) {
    const username = person.username;
    const name = person.name.toLowerCase();
    const emailLocal = person.email.split('@')[0]!.toLowerCase();
    let score = Number.POSITIVE_INFINITY;
    if (username.startsWith(local) || emailLocal.startsWith(local)) score = 1;
    else if (name.includes(local) || username.includes(local) || emailLocal.includes(local))
      score = 2;
    else {
      const distance = Math.min(levenshtein(local, username), levenshtein(local, emailLocal));
      if (distance <= 2) score = 2 + distance;
      else if (local.split(/[\s.]+/).every((part) => part.length > 1 && name.includes(part)))
        score = 3;
    }
    if (Number.isFinite(score)) scored.push({ person, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.person.username.localeCompare(b.person.username))
    .slice(0, max)
    .map((s) => s.person);
}

/** Resolves a user reference or throws a 404 that suggests close matches. */
export function requirePerson(input: string, what = 'user'): Person {
  const person = findPerson(input);
  if (person) return person;
  const suggestions = suggestPeople(input);
  const hint = suggestions.length
    ? ` Did you mean: ${suggestions.map((p) => `${p.username} (${p.name}, ${p.title})`).join('; ')}?`
    : '';
  throw notFound(
    `Unknown ${what} '${input}'. Reference people by username (e.g. dwhitfield) or email (e.g. dana.whitfield@keybank.example) — the same keys ServiceNow uses.${hint}`,
  );
}

/** Users matching a free-text query; personas first when the query is empty. */
export function searchUsers(q: string | undefined): TeamsUser[] {
  const people = getWorld().people;
  if (!q?.trim()) {
    const personas = PERSONA_ORDER.map((u) => getWorld().peopleByUsername.get(u)!).filter(Boolean);
    const rest = people
      .filter((p) => !PERSONA_ORDER.includes(p.username))
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...personas, ...rest].map(toTeamsUser);
  }
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = people.filter((p) => {
    const hay = `${p.username} ${p.name} ${p.email} ${p.title} ${p.department}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
  const first = terms[0]!;
  const rank = (p: Person) => {
    if (p.username === first) return 0;
    if (p.username.startsWith(first) || p.name.toLowerCase().startsWith(first)) return 1;
    if (PERSONA_ORDER.includes(p.username)) return 2;
    return 3;
  };
  return matches.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).map(toTeamsUser);
}

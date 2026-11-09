export const ORG = {
  slug: 'keybank',
  name: 'KeyBank',
  emailDomain: 'keybank.example',
  gcpProjectPrefix: 'kb-prod',
} as const;

/** Fixed seed: every run of every service produces the same world. */
export const WORLD_SEED = 2026;

export const TECH_LOCATIONS = [
  'Cleveland, OH',
  'Cleveland, OH',
  'Brooklyn, OH',
  'Buffalo, NY',
  'Albany, NY',
  'Tacoma, WA',
  'Denver, CO',
  'Remote (US)',
] as const;

export const BRANCHES = [
  'Cleveland Main Branch',
  'Lakewood Branch',
  'Akron Highland Square Branch',
  'Buffalo Elmwood Branch',
  'Albany Western Ave Branch',
  'Syracuse Erie Blvd Branch',
  'Seattle Capitol Hill Branch',
  'Tacoma Proctor Branch',
  'Boise Downtown Branch',
  'Denver Tech Center Branch',
  'Anchorage Midtown Branch',
  'Portland Pearl District Branch',
] as const;

export const SHARED_GROUP_IDS = {
  noc: 'grp_noc',
  serviceDesk: 'grp_service_desk',
  majorIncident: 'grp_mim',
  dba: 'grp_dba',
  network: 'grp_network',
  cloud: 'grp_cloud',
  middleware: 'grp_middleware',
  secops: 'grp_secops',
} as const;

/** Fixed people that scenarios and demos refer to by username. */
export const PERSONAS = {
  incidentBot: 'svc_incident_auto',
  nocLead: 'dwhitfield',
  nocAnalyst: 'mbell',
  serviceDeskAnalyst: 'pnatarajan',
  majorIncidentManager: 'tokafor',
  branchManager: 'mlopez',
  headTeller: 'kbrandt',
} as const;

/** People generated with Faker (personas are hand-written); must equal the role plan total. */
export const GENERATED_PEOPLE = 1192;

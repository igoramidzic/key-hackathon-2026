/** Vocabulary for generated (non-hero) apps. */

export interface DomainSpec {
  domain: string;
  businessUnit: string;
  /** Support group name for apps in this domain. */
  group: string;
}

export const DOMAINS: DomainSpec[] = [
  {
    domain: 'Mortgage Origination',
    businessUnit: 'Consumer Lending',
    group: 'Mortgage Technology Support',
  },
  {
    domain: 'Mortgage Servicing',
    businessUnit: 'Consumer Lending',
    group: 'Mortgage Technology Support',
  },
  { domain: 'Home Equity', businessUnit: 'Consumer Lending', group: 'Consumer Lending Support' },
  { domain: 'Auto Loan', businessUnit: 'Consumer Lending', group: 'Consumer Lending Support' },
  {
    domain: 'Student Lending',
    businessUnit: 'Consumer Lending',
    group: 'Consumer Lending Support',
  },
  { domain: 'Personal Loan', businessUnit: 'Consumer Lending', group: 'Consumer Lending Support' },
  {
    domain: 'Credit Decisioning',
    businessUnit: 'Risk & Compliance',
    group: 'Credit Risk Technology',
  },
  {
    domain: 'Collections',
    businessUnit: 'Consumer Lending',
    group: 'Collections & Recovery Support',
  },
  { domain: 'Loan Servicing', businessUnit: 'Consumer Lending', group: 'Loan Servicing Support' },
  {
    domain: 'Commercial Lending',
    businessUnit: 'Commercial Banking',
    group: 'Commercial Lending Technology',
  },
  {
    domain: 'Syndicated Loans',
    businessUnit: 'Commercial Banking',
    group: 'Commercial Lending Technology',
  },
  {
    domain: 'Treasury Management',
    businessUnit: 'Commercial Banking',
    group: 'Treasury Services Support',
  },
  { domain: 'Lockbox', businessUnit: 'Commercial Banking', group: 'Treasury Services Support' },
  {
    domain: 'Positive Pay',
    businessUnit: 'Commercial Banking',
    group: 'Treasury Services Support',
  },
  {
    domain: 'Cash Concentration',
    businessUnit: 'Commercial Banking',
    group: 'Treasury Services Support',
  },
  { domain: 'Merchant Services', businessUnit: 'Payments', group: 'Merchant Services Support' },
  { domain: 'Real-Time Payments', businessUnit: 'Payments', group: 'Payments Platform Support' },
  { domain: 'Zelle', businessUnit: 'Payments', group: 'Payments Platform Support' },
  { domain: 'Check Imaging', businessUnit: 'Payments', group: 'Item Processing Support' },
  { domain: 'Item Processing', businessUnit: 'Payments', group: 'Item Processing Support' },
  { domain: 'Remote Deposit', businessUnit: 'Digital Banking', group: 'Item Processing Support' },
  { domain: 'Card Rewards', businessUnit: 'Cards', group: 'Card Platform Support' },
  { domain: 'Card Disputes', businessUnit: 'Cards', group: 'Card Platform Support' },
  { domain: 'Card Authorization', businessUnit: 'Cards', group: 'Card Platform Support' },
  { domain: 'Prepaid Card', businessUnit: 'Cards', group: 'Card Platform Support' },
  {
    domain: 'Wealth Advisory',
    businessUnit: 'Wealth Management',
    group: 'Wealth Technology Support',
  },
  {
    domain: 'Trust Accounting',
    businessUnit: 'Wealth Management',
    group: 'Wealth Technology Support',
  },
  { domain: 'Brokerage', businessUnit: 'Wealth Management', group: 'Wealth Technology Support' },
  {
    domain: 'Retirement Plan',
    businessUnit: 'Wealth Management',
    group: 'Wealth Technology Support',
  },
  {
    domain: 'Portfolio Analytics',
    businessUnit: 'Wealth Management',
    group: 'Wealth Technology Support',
  },
  {
    domain: 'AML Monitoring',
    businessUnit: 'Risk & Compliance',
    group: 'Financial Crimes Technology',
  },
  { domain: 'KYC', businessUnit: 'Risk & Compliance', group: 'Financial Crimes Technology' },
  {
    domain: 'Sanctions Screening',
    businessUnit: 'Risk & Compliance',
    group: 'Financial Crimes Technology',
  },
  {
    domain: 'Regulatory Reporting',
    businessUnit: 'Risk & Compliance',
    group: 'Regulatory Reporting Support',
  },
  { domain: 'Market Risk', businessUnit: 'Risk & Compliance', group: 'Enterprise Risk Technology' },
  {
    domain: 'Operational Risk',
    businessUnit: 'Risk & Compliance',
    group: 'Enterprise Risk Technology',
  },
  {
    domain: 'Stress Testing',
    businessUnit: 'Risk & Compliance',
    group: 'Enterprise Risk Technology',
  },
  {
    domain: 'Branch Operations',
    businessUnit: 'Branch Banking',
    group: 'Branch Technology Support',
  },
  {
    domain: 'Branch Appointment',
    businessUnit: 'Branch Banking',
    group: 'Branch Technology Support',
  },
  { domain: 'ATM Network', businessUnit: 'Branch Banking', group: 'ATM & Self-Service Support' },
  { domain: 'Cash Logistics', businessUnit: 'Branch Banking', group: 'ATM & Self-Service Support' },
  {
    domain: 'Contact Center',
    businessUnit: 'Consumer Banking',
    group: 'Contact Center Technology',
  },
  { domain: 'IVR', businessUnit: 'Consumer Banking', group: 'Contact Center Technology' },
  { domain: 'Account Opening', businessUnit: 'Consumer Banking', group: 'Account Opening Support' },
  { domain: 'Overdraft', businessUnit: 'Consumer Banking', group: 'Deposit Products Support' },
  { domain: 'Statement', businessUnit: 'Consumer Banking', group: 'Deposit Products Support' },
  {
    domain: 'Customer Onboarding',
    businessUnit: 'Digital Banking',
    group: 'Digital Channels Support',
  },
  {
    domain: 'Digital Identity',
    businessUnit: 'Digital Banking',
    group: 'Digital Channels Support',
  },
  {
    domain: 'Secure Messaging',
    businessUnit: 'Digital Banking',
    group: 'Digital Channels Support',
  },
  {
    domain: 'Small Business Banking',
    businessUnit: 'Commercial Banking',
    group: 'Business Banking Support',
  },
  {
    domain: 'Payroll Services',
    businessUnit: 'Commercial Banking',
    group: 'Business Banking Support',
  },
  {
    domain: 'Human Resources',
    businessUnit: 'Corporate Functions',
    group: 'Corporate Systems Support',
  },
  {
    domain: 'Procurement',
    businessUnit: 'Corporate Functions',
    group: 'Corporate Systems Support',
  },
  {
    domain: 'Expense Management',
    businessUnit: 'Corporate Functions',
    group: 'Corporate Systems Support',
  },
  {
    domain: 'Corporate Treasury',
    businessUnit: 'Finance Technology',
    group: 'Finance Systems Support',
  },
  {
    domain: 'Financial Planning',
    businessUnit: 'Finance Technology',
    group: 'Finance Systems Support',
  },
  {
    domain: 'Accounts Payable',
    businessUnit: 'Finance Technology',
    group: 'Finance Systems Support',
  },
  {
    domain: 'Enterprise Data',
    businessUnit: 'Enterprise Technology',
    group: 'Data Platform Support',
  },
  {
    domain: 'Customer Analytics',
    businessUnit: 'Enterprise Technology',
    group: 'Data Platform Support',
  },
  {
    domain: 'Document Management',
    businessUnit: 'Enterprise Technology',
    group: 'Enterprise Content Support',
  },
  {
    domain: 'E-Signature',
    businessUnit: 'Enterprise Technology',
    group: 'Enterprise Content Support',
  },
  {
    domain: 'Marketing Campaign',
    businessUnit: 'Consumer Banking',
    group: 'Marketing Technology Support',
  },
  { domain: 'Pricing', businessUnit: 'Consumer Banking', group: 'Marketing Technology Support' },
  { domain: 'Vendor Risk', businessUnit: 'Risk & Compliance', group: 'Enterprise Risk Technology' },
  {
    domain: 'Access Governance',
    businessUnit: 'Enterprise Technology',
    group: 'Identity & Access Support',
  },
  {
    domain: 'Privileged Access',
    businessUnit: 'Enterprise Technology',
    group: 'Identity & Access Support',
  },
];

export interface SuffixSpec {
  suffix: string;
  /** Short description template. `{d}` is replaced with the lower-cased domain. */
  description: string;
  /** Apps of this kind usually have a web repo. */
  web?: boolean;
  /** Apps of this kind usually have a batch repo. */
  batch?: boolean;
}

export const SUFFIXES: SuffixSpec[] = [
  { suffix: 'Portal', description: 'Associate and customer portal for {d} workflows.', web: true },
  {
    suffix: 'Gateway',
    description: 'Integration gateway that brokers {d} traffic to partner systems.',
  },
  { suffix: 'Engine', description: 'Rules and calculation engine for {d}.' },
  { suffix: 'Service', description: 'Core API for {d} operations.' },
  { suffix: 'Hub', description: 'Central hub that routes {d} events between systems.' },
  {
    suffix: 'Reporting',
    description: 'Operational and regulatory reporting for {d}.',
    batch: true,
  },
  { suffix: 'Analytics', description: 'Analytics and dashboards for {d}.', batch: true, web: true },
  { suffix: 'Workbench', description: 'Associate workbench for {d} case handling.', web: true },
  { suffix: 'Scheduler', description: 'Job scheduling and orchestration for {d}.', batch: true },
  { suffix: 'Adapter', description: 'Adapter that connects {d} to the vendor platform.' },
  { suffix: 'Orchestrator', description: 'Workflow orchestration for {d} processes.' },
  { suffix: 'Ledger', description: 'Sub-ledger for {d} balances and postings.' },
  { suffix: 'Data Mart', description: 'Curated data mart for {d}.', batch: true },
  { suffix: 'Batch Processor', description: 'Nightly batch processing for {d}.', batch: true },
  { suffix: 'API', description: 'Public API for {d} capabilities.' },
  { suffix: 'Console', description: 'Operations console for {d}.', web: true },
  { suffix: 'Rules Service', description: 'Business rules management for {d}.' },
  { suffix: 'Document Service', description: 'Document generation and storage for {d}.' },
  {
    suffix: 'Reconciliation',
    description: 'Reconciliation and exception handling for {d}.',
    batch: true,
  },
  { suffix: 'Notifications', description: 'Event notifications for {d}.' },
  {
    suffix: 'Archive',
    description: 'Long-term archive and retrieval for {d} records.',
    batch: true,
  },
  { suffix: 'Exchange', description: 'File and message exchange for {d}.' },
  { suffix: 'Monitor', description: 'Monitoring and alerting for {d} activity.' },
  { suffix: 'Calculator', description: 'Calculation service for {d} quotes and schedules.' },
  { suffix: 'Feed Processor', description: 'Inbound feed processing for {d}.', batch: true },
];

export const TITLES: Record<string, string[]> = {
  engineer: [
    'Software Engineer I',
    'Software Engineer II',
    'Software Engineer II',
    'Senior Software Engineer',
    'Senior Software Engineer',
    'Staff Software Engineer',
    'Principal Engineer',
    'Site Reliability Engineer',
    'Senior Site Reliability Engineer',
    'DevOps Engineer',
    'QA Automation Engineer',
  ],
  support: [
    'Application Support Analyst',
    'Application Support Analyst',
    'Senior Application Support Analyst',
    'Production Support Engineer',
    'Application Support Lead',
  ],
  manager: [
    'Engineering Manager',
    'Engineering Manager',
    'Senior Engineering Manager',
    'Director, Application Development',
    'Application Owner',
    'IT Product Owner',
  ],
  infra: [
    'Database Administrator',
    'Senior Database Administrator',
    'Network Engineer',
    'Cloud Platform Engineer',
    'Middleware Engineer',
    'Security Operations Analyst',
  ],
  noc: ['NOC Analyst', 'NOC Analyst', 'Senior NOC Analyst'],
  service_desk: ['Service Desk Analyst', 'Service Desk Analyst', 'Senior Service Desk Analyst'],
  incident_manager: ['Major Incident Manager', 'Incident Manager'],
  branch: [
    'Branch Manager',
    'Assistant Branch Manager',
    'Relationship Banker',
    'Teller',
    'Teller',
    'Head Teller',
  ],
  executive: [
    'Chief Information Officer',
    'SVP, Digital Technology',
    'SVP, Enterprise Infrastructure',
    'VP, Application Development',
    'VP, Technology Operations',
  ],
};

/** Letters combos we never use as TLAs. */
export const TLA_BLOCKLIST = new Set([
  'ASS',
  'FUK',
  'FUC',
  'SEX',
  'XXX',
  'KKK',
  'NIG',
  'FAG',
  'GAY',
  'CUM',
  'DIE',
  'KIL',
  'WTF',
  'POO',
  'PEE',
  'TIT',
  'NAZ',
  'SUX',
  'DMN',
  'HEL',
]);

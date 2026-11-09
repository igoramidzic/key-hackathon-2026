import type { RepoKind, Stack } from './types';

export interface HeroRepoSpec {
  name: string;
  kind: RepoKind;
  stack: Stack;
  description: string;
}

export interface HeroAppSpec {
  tla: string;
  name: string;
  description: string;
  businessUnit: string;
  tier: 1 | 2;
  stack: Stack;
  upstream: string[];
  repos: HeroRepoSpec[];
}

/**
 * Hand-written core banking apps. Scenarios are built around these, so their TLAs,
 * repo names and dependency graph are fixed. The first repo of each app is its primary
 * service (its name is the service name in logs).
 */
export const HERO_APPS: HeroAppSpec[] = [
  {
    tla: 'ATH',
    name: 'Authentication & Token Service',
    description:
      'Issues and validates OAuth2 access tokens for customer sessions and service-to-service calls.',
    businessUnit: 'Enterprise Technology',
    tier: 1,
    stack: 'node-ts',
    upstream: [],
    repos: [
      {
        name: 'auth-token-service',
        kind: 'service',
        stack: 'node-ts',
        description: 'OAuth2 token issuer and JWKS endpoint.',
      },
      {
        name: 'auth-admin-web',
        kind: 'web',
        stack: 'react-web',
        description: 'Admin console for OAuth clients and scopes.',
      },
    ],
  },
  {
    tla: 'GLD',
    name: 'General Ledger',
    description: 'Posts financial transactions to the general ledger and runs end-of-day close.',
    businessUnit: 'Finance Technology',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH'],
    repos: [
      {
        name: 'gl-posting-service',
        kind: 'service',
        stack: 'java-spring',
        description: 'Real-time GL posting API.',
      },
      {
        name: 'gl-eod-batch',
        kind: 'batch',
        stack: 'java-spring',
        description: 'End-of-day ledger close and reconciliation batch.',
      },
    ],
  },
  {
    tla: 'CIF',
    name: 'Customer Information File',
    description:
      'System of record for customer profiles, contact details and customer-to-account relationships.',
    businessUnit: 'Enterprise Technology',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH'],
    repos: [
      {
        name: 'customer-profile-api',
        kind: 'service',
        stack: 'java-spring',
        description: 'REST API for customer profiles and relationships.',
      },
      {
        name: 'cif-batch',
        kind: 'batch',
        stack: 'java-spring',
        description: 'Nightly CIF data quality and sync jobs.',
      },
    ],
  },
  {
    tla: 'DEP',
    name: 'Deposit Accounts Core',
    description: 'Core system for checking and savings accounts, balances and holds.',
    businessUnit: 'Consumer Banking',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH', 'CIF', 'GLD'],
    repos: [
      {
        name: 'deposit-accounts-api',
        kind: 'service',
        stack: 'java-spring',
        description: 'Accounts, balances and holds API.',
      },
    ],
  },
  {
    tla: 'NTF',
    name: 'Customer Notifications',
    description: 'Sends email, SMS and push notifications to customers.',
    businessUnit: 'Digital Banking',
    tier: 2,
    stack: 'node-ts',
    upstream: ['ATH', 'CIF'],
    repos: [
      {
        name: 'notification-service',
        kind: 'service',
        stack: 'node-ts',
        description: 'Notification fan-out (email, SMS, push).',
      },
    ],
  },
  {
    tla: 'FRD',
    name: 'Fraud Scoring Engine',
    description: 'Scores payments and card transactions for fraud risk in real time.',
    businessUnit: 'Risk & Compliance',
    tier: 1,
    stack: 'python',
    upstream: ['CIF'],
    repos: [
      {
        name: 'fraud-scoring-engine',
        kind: 'service',
        stack: 'python',
        description: 'Real-time fraud scoring API.',
      },
    ],
  },
  {
    tla: 'ABA',
    name: 'ABA Routing Directory',
    description: 'Validates ABA routing numbers and resolves receiving financial institutions.',
    businessUnit: 'Payments',
    tier: 2,
    stack: 'node-ts',
    upstream: [],
    repos: [
      {
        name: 'routing-directory-service',
        kind: 'service',
        stack: 'node-ts',
        description: 'Routing number validation and FI lookup.',
      },
    ],
  },
  {
    tla: 'ACH',
    name: 'ACH Origination',
    description: 'Builds, validates and transmits outbound ACH batches to the Federal Reserve.',
    businessUnit: 'Payments',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH', 'ABA', 'GLD', 'FRD'],
    repos: [
      {
        name: 'ach-origination',
        kind: 'service',
        stack: 'java-spring',
        description: 'ACH entry validation, batching and NACHA file generation.',
      },
    ],
  },
  {
    tla: 'WIR',
    name: 'Wire Transfer Service',
    description: 'Originates and tracks domestic and international wire transfers.',
    businessUnit: 'Payments',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH', 'ABA', 'FRD', 'GLD'],
    repos: [
      {
        name: 'wire-transfer-service',
        kind: 'service',
        stack: 'java-spring',
        description: 'Fedwire and SWIFT wire origination.',
      },
    ],
  },
  {
    tla: 'PAY',
    name: 'Payments Hub',
    description: 'Orchestrates customer payments across ACH, wire and internal transfer rails.',
    businessUnit: 'Payments',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH', 'CIF', 'DEP', 'FRD', 'ACH', 'WIR', 'NTF'],
    repos: [
      {
        name: 'payments-api',
        kind: 'service',
        stack: 'java-spring',
        description: 'Payment orchestration API.',
      },
      {
        name: 'payments-ops-web',
        kind: 'web',
        stack: 'react-web',
        description: 'Operations console for payment exceptions.',
      },
    ],
  },
  {
    tla: 'BPY',
    name: 'Bill Pay',
    description: 'Online bill payment: payees, schedules and remittance.',
    businessUnit: 'Digital Banking',
    tier: 2,
    stack: 'node-ts',
    upstream: ['ATH', 'PAY', 'ABA', 'CIF'],
    repos: [
      {
        name: 'billpay-service',
        kind: 'service',
        stack: 'node-ts',
        description: 'Payee management and bill payment scheduling.',
      },
    ],
  },
  {
    tla: 'CRD',
    name: 'Card Management',
    description: 'Debit and credit card lifecycle: issuance, controls, limits and status.',
    businessUnit: 'Cards',
    tier: 2,
    stack: 'java-spring',
    upstream: ['ATH', 'CIF', 'FRD', 'NTF'],
    repos: [
      {
        name: 'card-management-api',
        kind: 'service',
        stack: 'java-spring',
        description: 'Card controls, limits and lifecycle API.',
      },
    ],
  },
  {
    tla: 'TLR',
    name: 'Teller Platform',
    description: 'Branch teller workstation backend: transactions, cash drawers and balancing.',
    businessUnit: 'Branch Banking',
    tier: 1,
    stack: 'java-spring',
    upstream: ['ATH', 'CIF', 'DEP', 'GLD'],
    repos: [
      {
        name: 'teller-workstation-api',
        kind: 'service',
        stack: 'java-spring',
        description: 'Teller transactions, drawers and end-of-day balancing.',
      },
    ],
  },
  {
    tla: 'OLB',
    name: 'Online Banking',
    description: 'Customer web banking: accounts, transfers, bill pay and profile.',
    businessUnit: 'Digital Banking',
    tier: 1,
    stack: 'node-ts',
    upstream: ['ATH', 'CIF', 'DEP', 'PAY', 'BPY', 'NTF'],
    repos: [
      {
        name: 'online-banking-bff',
        kind: 'service',
        stack: 'node-ts',
        description: 'Backend-for-frontend for the online banking web app.',
      },
      {
        name: 'online-banking-web',
        kind: 'web',
        stack: 'react-web',
        description: 'Online banking single-page app.',
      },
    ],
  },
  {
    tla: 'MBL',
    name: 'Mobile Banking',
    description: 'API gateway for the iOS and Android mobile banking apps.',
    businessUnit: 'Digital Banking',
    tier: 1,
    stack: 'node-ts',
    upstream: ['ATH', 'CIF', 'DEP', 'PAY', 'CRD', 'NTF'],
    repos: [
      {
        name: 'mobile-gateway',
        kind: 'service',
        stack: 'node-ts',
        description: 'Mobile API gateway and session management.',
      },
      {
        name: 'mobile-app',
        kind: 'web',
        stack: 'react-web',
        description: 'React Native mobile banking app.',
      },
    ],
  },
];

export const HERO_TLAS = HERO_APPS.map((a) => a.tla);

import { getApp, PERSONAS } from '@sim/world';
import { internalUrl, javaLog, javaPackage, nodeLog, perStack, pyLog, pyPackage } from '../logs';
import { ATH_REPO } from '../repos/ath';
import {
  CIF_FIXTURE_CAMEL,
  CIF_FIXTURE_SNAKE,
  CIF_PATHS,
  CIF_REPO,
  CIF_SNAKE_KEYS,
  CIF_TEST_ASSERTIONS_CAMEL,
  CIF_TEST_ASSERTIONS_SNAKE,
} from '../repos/cif';
import { CRD_CONTROLLER, CRD_SERVICE } from '../repos/crd';
import { DEP_CONTROLLER, DEP_OWNERSHIP } from '../repos/dep';
import { FRD_CUSTOMER_FEATURES, FRD_PATHS } from '../repos/frd';
import { MBL_PATHS, MBL_PROFILE_CLIENT } from '../repos/mbl';
import { NTF_DISPATCHER, NTF_PATHS } from '../repos/ntf';
import {
  OLB_PATHS,
  OLB_PROFILE_CLIENT,
  OLB_PROFILE_COPY_LINE,
  OLB_PROFILE_ROUTES,
  OLB_REPO,
} from '../repos/olb';
import { PAY_CONTROLLER, PAY_PAYER_VERIFICATION, PAY_PROFILE_CLIENT } from '../repos/pay';
import { TLR_CONTROLLER, TLR_PROFILE_CLIENT } from '../repos/tlr';
import type { ScenarioDefinition } from '../types';
import {
  branchStaff,
  dev,
  javaFrame,
  javaStack,
  latency,
  lineOf,
  moogsoftAlert,
  NODE_TICKS,
  nodeFrame,
  paymentId,
  pos,
  pyTraceback,
  serviceDeskAnalyst,
  springMvcFrames,
  springProxyFrames,
  stripHashComments,
  tpl,
  uuid,
} from '../util';

// ---------------------------------------------------------------------------
// Bad change and fix
// ---------------------------------------------------------------------------

const CAMEL_LINE = '    property-naming-strategy: LOWER_CAMEL_CASE';
const SNAKE_LINE = '    property-naming-strategy: SNAKE_CASE';

/** Fixed when CIF serializes camelCase again (config or DTO-level pin). */
function cifIsFixed(files: Record<string, string | null>): boolean {
  const yml = stripHashComments(files[CIF_PATHS.applicationYml] ?? '');
  const dto = files[CIF_PATHS.profileDto] ?? '';
  const strategy = yml.match(/property-naming-strategy\s*:\s*["']?([\w.$]+)/)?.[1];
  const ymlCamel = strategy === undefined || /LOWER_CAMEL_CASE|LowerCamelCase/.test(strategy);
  const dtoPinnedCamel =
    /@JsonNaming\(\s*(?:PropertyNamingStrategies\.)?LowerCamelCaseStrategy\.class\s*\)/.test(dto);
  return ymlCamel || dtoPinnedCamel;
}

// ---------------------------------------------------------------------------
// Consumer stack traces (positions come from the overlay files)
// ---------------------------------------------------------------------------

const ZOD_ISSUES = ['customerId', 'firstName', 'lastName', 'kycStatus', 'customerSince'].map(
  (field) => ({
    code: 'invalid_type',
    expected: 'string',
    received: 'undefined',
    path: [field],
    message: 'Required',
  }),
);

const OLB_THROW = pos(
  OLB_PROFILE_CLIENT,
  'throw new UpstreamContractError(',
  'new UpstreamContractError(',
);
const OLB_ROUTES = [
  {
    path: '/bff/v1/profile',
    message: 'profile unavailable: upstream contract violation',
    at: pos(OLB_PROFILE_ROUTES, 'const profile = await cif.getProfile(', 'getProfile('),
  },
  {
    path: '/bff/v1/dashboard/header',
    message: 'dashboard header unavailable: upstream contract violation',
    at: pos(
      OLB_PROFILE_ROUTES,
      'const { firstName, segment } = await cif.getProfile(',
      'getProfile(',
    ),
  },
];

const MBL_THROW_AT = pos(
  MBL_PROFILE_CLIENT,
  "'customerId missing from profile response'",
  'new UpstreamContractError(',
);

const PAY_CLIENT = 'com.keybank.pay.client.CustomerProfileClient';
const PAY_KNOWN_PROPERTIES =
  '"customerSince", "lastName", "mailingAddress", "riskRating", "firstName", "primaryEmail", "contactPreferences", "kycStatus", "dateOfBirth", "segment", "mobilePhone", "lastUpdated", "customerId"';

function payStack(): string {
  const unrecognized =
    'Unrecognized field "customer_id" (class com.keybank.pay.client.CustomerProfile), not marked as ignorable';
  return javaStack(
    {
      type: 'org.springframework.web.client.RestClientException',
      message:
        'Error while extracting response for type [com.keybank.pay.client.CustomerProfile] and content type [application/json]',
      frames: [
        'org.springframework.web.client.DefaultRestClient.readWithMessageConverters(DefaultRestClient.java:265)',
        'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.readBody(DefaultRestClient.java:825)',
        'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.lambda$body$0(DefaultRestClient.java:756)',
        'org.springframework.web.client.DefaultRestClient$DefaultRequestBodyUriSpec.readResponse(DefaultRestClient.java:579)',
        'org.springframework.web.client.DefaultRestClient$DefaultRequestBodyUriSpec.exchangeInternal(DefaultRestClient.java:548)',
        'org.springframework.web.client.DefaultRestClient$DefaultResponseSpec.body(DefaultRestClient.java:756)',
        javaFrame(
          PAY_CLIENT,
          'getProfile',
          lineOf(PAY_PROFILE_CLIENT, '.body(CustomerProfile.class);'),
        ),
        javaFrame(
          'com.keybank.pay.service.PayerVerificationService',
          'verifyPayer',
          lineOf(PAY_PAYER_VERIFICATION, 'profiles.getProfile(customerId)'),
        ),
        javaFrame(
          'com.keybank.pay.api.PaymentController',
          'createPayment',
          lineOf(PAY_CONTROLLER, 'payers.verifyPayer(request.customerId())'),
        ),
        ...springMvcFrames('POST'),
      ],
    },
    {
      type: 'org.springframework.http.converter.HttpMessageNotReadableException',
      message: `JSON parse error: ${unrecognized}`,
      frames: [
        'org.springframework.http.converter.json.AbstractJackson2HttpMessageConverter.readJavaType(AbstractJackson2HttpMessageConverter.java:406)',
        'org.springframework.http.converter.json.AbstractJackson2HttpMessageConverter.read(AbstractJackson2HttpMessageConverter.java:354)',
        'org.springframework.web.client.DefaultRestClient.readWithMessageConverters(DefaultRestClient.java:236)',
      ],
      omitted: 48,
    },
    {
      type: 'com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException',
      message: `${unrecognized} (13 known properties: ${PAY_KNOWN_PROPERTIES}])\n at [Source: REDACTED (\`StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION\` disabled); line: 1, column: 17] (through reference chain: com.keybank.pay.client.CustomerProfile["customer_id"])`,
      frames: [
        'com.fasterxml.jackson.databind.exc.UnrecognizedPropertyException.from(UnrecognizedPropertyException.java:61)',
        'com.fasterxml.jackson.databind.DeserializationContext.handleUnknownProperty(DeserializationContext.java:1180)',
        'com.fasterxml.jackson.databind.deser.std.StdDeserializer.handleUnknownProperty(StdDeserializer.java:2244)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializerBase.handleUnknownProperty(BeanDeserializerBase.java:1823)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializerBase.handleUnknownVanilla(BeanDeserializerBase.java:1801)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializer._deserializeUsingPropertyBased(BeanDeserializer.java:516)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializerBase.deserializeFromObjectUsingNonDefault(BeanDeserializerBase.java:1493)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializer.deserializeFromObject(BeanDeserializer.java:348)',
        'com.fasterxml.jackson.databind.deser.BeanDeserializer.deserialize(BeanDeserializer.java:185)',
        'com.fasterxml.jackson.databind.deser.DefaultDeserializationContext.readRootValue(DefaultDeserializationContext.java:342)',
        'com.fasterxml.jackson.databind.ObjectReader._bindAndClose(ObjectReader.java:2131)',
        'com.fasterxml.jackson.databind.ObjectReader.readValue(ObjectReader.java:1501)',
        'org.springframework.http.converter.json.AbstractJackson2HttpMessageConverter.readJavaType(AbstractJackson2HttpMessageConverter.java:395)',
      ],
      omitted: 51,
    },
  );
}

const FRD_TRACEBACK = pyTraceback(
  [
    {
      path: FRD_PATHS.customerFeatures,
      content: FRD_CUSTOMER_FEATURES,
      needle: 'return _extract(profile)',
      fn: 'customer_features',
      highlight: { text: '_extract(profile)' },
    },
    {
      path: FRD_PATHS.customerFeatures,
      content: FRD_CUSTOMER_FEATURES,
      needle: 'customer_id = profile["customerId"]',
      fn: '_extract',
      highlight: { text: 'profile["customerId"]', subscript: true },
    },
  ],
  "KeyError: 'customerId'",
);

const NTF_RESOLVE = pos(
  NTF_DISPATCHER,
  'contact.contactPreferences.preferredChannel',
  'preferredChannel;',
);
const NTF_DISPATCH = pos(
  NTF_DISPATCHER,
  'const recipient = await resolveRecipient(',
  'resolveRecipient(',
);

function crdNpeStack(op: 'getCard' | 'updateControls'): string {
  const svc = 'com.keybank.crd.service.CardControlService';
  // The assertActiveCardholder(...) call is the line after the card lookup in both methods.
  const opLine =
    lineOf(
      CRD_SERVICE,
      op === 'getCard' ? 'cards.findById(cardId)' : 'cards.findByIdForUpdate(cardId)',
    ) + 1;
  return javaStack({
    type: 'java.lang.NullPointerException',
    message:
      'Cannot invoke "String.equals(Object)" because the return value of "com.keybank.crd.client.CustomerProfile.customerId()" is null',
    frames: [
      javaFrame(
        svc,
        'assertActiveCardholder',
        lineOf(CRD_SERVICE, 'if (!holder.customerId().equals('),
      ),
      javaFrame(svc, op, opLine),
      ...springProxyFrames(svc, op),
      javaFrame(
        'com.keybank.crd.api.CardController',
        op,
        lineOf(
          CRD_CONTROLLER,
          op === 'getCard' ? 'return cards.getCard(' : 'return cards.updateControls(',
        ),
      ),
      ...springMvcFrames(op === 'getCard' ? 'GET' : 'PUT'),
    ],
  });
}

/** Tomcat's logger for exceptions that escape Spring MVC (logback-abbreviated). */
const DISPATCHER_SERVLET = 'o.a.c.c.C.[.[.[/].[dispatcherServlet]';

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const olb = getApp('OLB');
const mbl = getApp('MBL');

// Bankers calling the service desk while monitoring fires: Teller Workstation's customer lookup
// (TLR) fails like everything else that reads customer data. The agent should group these calls
// under its own incident rather than work them one by one.
const denver = branchStaff('Denver Tech Center Branch', ['Teller', 'Head Teller']);
const seattle = branchStaff('Seattle Capitol Hill Branch', ['Relationship Banker']);
const buffalo = branchStaff('Buffalo Elmwood Branch', ['Assistant Branch Manager']);

export const cifSnakeCaseCascade: ScenarioDefinition = {
  id: 'cif-snake-case-cascade',
  title: 'Customer profile failures across digital banking',
  kind: 'cascade',
  summary:
    'Online and mobile banking stop loading customer profiles, payments start failing payer verification, and errors spread to every system that reads customer data.',
  answerKey: {
    rootCause:
      'customer-profile-api (CIF) MR "Adopt enterprise API naming standard (snake_case)" set spring.jackson.property-naming-strategy to SNAKE_CASE. CIF now returns customer_id/first_name/... instead of customerId/firstName/..., breaking every consumer that binds the camelCase contract. Fix: restore LOWER_CAMEL_CASE (or revert the MR).',
    culpritTla: 'CIF',
    affectedTlas: ['OLB', 'MBL', 'PAY', 'FRD', 'NTF', 'CRD', 'TLR', 'DEP', 'BPY'],
    whyItLooksGreen:
      'CIF still answers 200 OK with a complete body, so its error rate, latency and health checks are normal. Its own tests and fixtures were updated in the same MR, so CI passed.',
  },
  badMr: {
    project: CIF_REPO,
    title: 'Adopt enterprise API naming standard (snake_case)',
    description: `## Summary
Aligns customer-profile-api with **Enterprise API Standards v3.2, EAS-114** ("JSON property names SHALL use snake_case"). CIF was flagged in the Q3 API governance scorecard as one of the last tier-1 APIs still on camelCase.

## Changes
- \`spring.jackson.property-naming-strategy\`: \`LOWER_CAMEL_CASE\` -> \`SNAKE_CASE\`
- Updated \`CustomerProfileControllerTest\` assertions and the JSON fixture to the new field names

## Testing
- \`mvn verify\` green locally and in CI
- Smoke-tested \`GET /v1/customers/{customerId}/profile\` in dev

## Risk
Low. Configuration-only change, no code changes. Consumers use the published OpenAPI spec.

Refs: ARCH-2291, EAS-114`,
    author: dev('CIF', 4),
    approvers: [dev('CIF', 3)],
    mergedBy: dev('CIF', 4),
    sourceBranch: 'feature/ARCH-2291-snake-case-json',
    labels: ['api-standards', 'tech-debt'],
    openedMinutesAgo: 26 * 60,
    edits: [
      { path: CIF_PATHS.applicationYml, find: CAMEL_LINE, replace: SNAKE_LINE },
      {
        path: CIF_PATHS.controllerTest,
        find: CIF_TEST_ASSERTIONS_CAMEL,
        replace: CIF_TEST_ASSERTIONS_SNAKE,
      },
      { path: CIF_PATHS.profileFixture, content: CIF_FIXTURE_SNAKE },
    ],
  },
  fix: {
    title: 'Revert CIF JSON naming to camelCase',
    description: `## Why
The ARCH-2291 MR ("Adopt enterprise API naming standard") switched customer-profile-api to \`SNAKE_CASE\`. CIF kept returning 200s, but every consumer binds the camelCase contract: OLB/MBL fail schema validation (502), PAY fails deserialization (\`Unrecognized field "customer_id"\`), FRD/NTF/CRD/TLR/DEP hit missing \`customerId\`.

## Change
- Restore \`spring.jackson.property-naming-strategy: LOWER_CAMEL_CASE\`
- Restore camelCase test assertions and fixture

A snake_case migration needs a versioned \`/v2\` endpoint and consumer sign-off; tracking separately.`,
    edits: [
      { path: CIF_PATHS.applicationYml, find: SNAKE_LINE, replace: CAMEL_LINE },
      {
        path: CIF_PATHS.controllerTest,
        find: CIF_TEST_ASSERTIONS_SNAKE,
        replace: CIF_TEST_ASSERTIONS_CAMEL,
      },
      { path: CIF_PATHS.profileFixture, content: CIF_FIXTURE_CAMEL },
    ],
    files: [CIF_PATHS.applicationYml, CIF_PATHS.profileDto],
    isFixed: cifIsFixed,
  },
  faultOnsetSec: 30,
  culpritSignals: {
    ratePerSec: 2,
    templates: [
      tpl('INFO', (ctx) => {
        const id = ctx.customerId();
        const client = ctx.rng.pick([
          'olb-bff',
          'mobile-gateway',
          'pay-api',
          'fraud-engine',
          'ntf-service',
          'crd-api',
          'tlr-api',
          'dep-api',
        ]);
        const ms = ctx.rng.int(6, 28);
        return javaLog(ctx, {
          logger: 'com.keybank.cif.api.RequestLoggingFilter',
          message: `GET /v1/customers/${id}/profile 200 ${ms}ms client_id=${client}`,
          http: {
            method: 'GET',
            url: `https://cif.internal.keybank.example/v1/customers/${id}/profile`,
            status: 200,
            latencySec: ms / 1000,
          },
        });
      }),
    ],
  },
  impacts: [
    {
      tla: 'OLB',
      startAfterSec: 0,
      ratePerSec: 6,
      templates: [
        tpl(
          'ERROR',
          (ctx) =>
            nodeLog(ctx, {
              message: 'CIF profile response failed schema validation',
              fields: {
                customerId: ctx.customerId(),
                upstream: 'customer-profile-api',
                upstreamStatus: 200,
                receivedKeys: CIF_SNAKE_KEYS,
                issues: ZOD_ISSUES,
              },
            }),
          3,
        ),
        tpl(
          'ERROR',
          (ctx) => {
            const route = ctx.rng.pick(OLB_ROUTES);
            return nodeLog(ctx, {
              message: route.message,
              error: {
                type: 'UpstreamContractError',
                message: 'customer-profile-api response failed contract validation',
                stack_trace: [
                  'UpstreamContractError: customer-profile-api response failed contract validation',
                  nodeFrame('CustomerProfileClient.getProfile', OLB_PATHS.profileClient, OLB_THROW),
                  NODE_TICKS,
                  nodeFrame('async Object.<anonymous>', OLB_PATHS.profileRoutes, route.at),
                ].join('\n'),
              },
              http: {
                method: 'GET',
                url: `https://online.keybank.example${route.path}`,
                status: 502,
                latencySec: latency(ctx, 0.04, 0.32),
              },
              fields: { customerId: ctx.customerId(), upstream: 'customer-profile-api' },
            });
          },
          3,
        ),
      ],
    },
    {
      tla: 'MBL',
      startAfterSec: 5,
      ratePerSec: 4,
      templates: [
        tpl('ERROR', (ctx) => {
          const path = ctx.rng.pick(['/mobile/v2/me', '/mobile/v2/home', '/mobile/v2/home']);
          const platform = ctx.rng.pick(['ios', 'android']);
          return nodeLog(ctx, {
            message: 'customer-profile-api: customerId missing from profile response',
            error: {
              type: 'UpstreamContractError',
              message: 'customer-profile-api: customerId missing from profile response',
              stack_trace: [
                'UpstreamContractError: customer-profile-api: customerId missing from profile response',
                nodeFrame('fetchProfile', MBL_PATHS.profileClient, MBL_THROW_AT),
                NODE_TICKS,
                '    at async Promise.all (index 0)',
              ].join('\n'),
            },
            http: {
              method: 'GET',
              url: `https://mobile-api.keybank.example${path}`,
              status: 502,
              latencySec: latency(ctx, 0.03, 0.25),
            },
            fields: {
              customerId: ctx.customerId(),
              platform,
              appVersion: ctx.rng.pick(['7.41.2', '7.41.2', '7.40.0', '7.38.5']),
              upstream: 'customer-profile-api',
            },
          });
        }),
      ],
    },
    {
      tla: 'PAY',
      startAfterSec: 10,
      ratePerSec: 3,
      templates: [
        tpl(
          'ERROR',
          (ctx) => {
            const id = ctx.customerId();
            return javaLog(ctx, {
              logger: PAY_CLIENT,
              message: `Customer profile lookup failed for ${id}: Error while extracting response for type [com.keybank.pay.client.CustomerProfile] and content type [application/json]`,
              error: {
                type: 'org.springframework.web.client.RestClientException',
                message:
                  'Error while extracting response for type [com.keybank.pay.client.CustomerProfile] and content type [application/json]',
                stack_trace: payStack(),
              },
              fields: { customerId: id, paymentId: paymentId(ctx) },
            });
          },
          2,
        ),
        tpl('ERROR', (ctx) => {
          const id = ctx.customerId();
          return javaLog(ctx, {
            logger: 'com.keybank.pay.api.PaymentController',
            message: `Payment rejected: payer verification unavailable (CIF profile unavailable for ${id}) path=/v1/payments`,
            http: {
              method: 'POST',
              url: 'https://payments.internal.keybank.example/v1/payments',
              status: 502,
              latencySec: latency(ctx, 0.03, 0.2),
            },
            fields: { customerId: id, paymentId: paymentId(ctx), amount: ctx.amount() },
          });
        }),
      ],
    },
    {
      tla: 'FRD',
      startAfterSec: 8,
      ratePerSec: 2,
      templates: [
        tpl('ERROR', (ctx) =>
          pyLog(ctx, {
            logger: 'fraud_scoring_engine.features.customer',
            message: 'customer feature extraction failed',
            error: { type: 'KeyError', message: "'customerId'", stack_trace: FRD_TRACEBACK },
            fields: {
              customer_ref: ctx.customerId().slice(-4),
              received_keys: [...CIF_SNAKE_KEYS].sort(),
              score_request_id: ctx.requestId(),
            },
          }),
        ),
        tpl('WARNING', (ctx) =>
          pyLog(ctx, {
            logger: 'fraud_scoring_engine.scoring',
            message: 'customer features unavailable; scored with rules-only fallback model',
            fields: {
              score_request_id: ctx.requestId(),
              channel: ctx.rng.pick(['PAY', 'PAY', 'CRD', 'ACH', 'WIR']),
              model_version: 'rules-only-v3',
              decision: ctx.rng.pick(['REVIEW', 'REVIEW', 'APPROVE']),
            },
          }),
        ),
      ],
    },
    {
      tla: 'NTF',
      startAfterSec: 15,
      ratePerSec: 1.5,
      templates: [
        tpl('ERROR', (ctx) =>
          nodeLog(ctx, {
            message: 'notification dropped: recipient resolution failed',
            error: {
              type: 'TypeError',
              message: "Cannot read properties of undefined (reading 'preferredChannel')",
              stack_trace: [
                "TypeError: Cannot read properties of undefined (reading 'preferredChannel')",
                nodeFrame('resolveRecipient', NTF_PATHS.dispatcher, NTF_RESOLVE),
                NODE_TICKS,
                nodeFrame('async dispatch', NTF_PATHS.dispatcher, NTF_DISPATCH),
              ].join('\n'),
            },
            fields: {
              eventId: ctx.requestId(),
              notificationType: ctx.rng.pick([
                'PAYMENT_CONFIRMATION',
                'LOW_BALANCE_ALERT',
                'CARD_CONTROLS_CHANGED',
                'STATEMENT_READY',
                'DEPOSIT_RECEIVED',
              ]),
              customerId: ctx.customerId(),
            },
          }),
        ),
      ],
    },
    {
      tla: 'CRD',
      startAfterSec: 20,
      ratePerSec: 1.5,
      templates: [
        tpl('ERROR', (ctx) => {
          const op = ctx.rng.pick(['getCard', 'updateControls'] as const);
          const cardId = uuid(ctx);
          const path = op === 'getCard' ? `/v1/cards/${cardId}` : `/v1/cards/${cardId}/controls`;
          const method = op === 'getCard' ? 'GET' : 'PUT';
          return javaLog(ctx, {
            logger: 'com.keybank.crd.api.ApiExceptionHandler',
            message: `Unhandled exception on ${method} ${path}`,
            error: {
              type: 'java.lang.NullPointerException',
              message:
                'Cannot invoke "String.equals(Object)" because the return value of "com.keybank.crd.client.CustomerProfile.customerId()" is null',
              stack_trace: crdNpeStack(op),
            },
            http: {
              method,
              url: `https://cards.internal.keybank.example${path}`,
              status: 500,
              latencySec: latency(ctx, 0.02, 0.12),
            },
          });
        }),
      ],
    },
    {
      tla: 'TLR',
      startAfterSec: 25,
      ratePerSec: 1,
      templates: [
        tpl('ERROR', (ctx) => {
          const id = ctx.customerId();
          const message = `CIF returned profile for null when asked for ${id}`;
          return javaLog(ctx, {
            logger: DISPATCHER_SERVLET,
            message: `Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception [Request processing failed: java.lang.IllegalStateException: ${message}] with root cause`,
            error: {
              type: 'java.lang.IllegalStateException',
              message,
              stack_trace: javaStack({
                type: 'java.lang.IllegalStateException',
                message,
                frames: [
                  javaFrame(
                    'com.keybank.tlr.client.CustomerProfileClient',
                    'getVerifiedProfile',
                    lineOf(TLR_PROFILE_CLIENT, 'throw new IllegalStateException('),
                  ),
                  javaFrame(
                    'com.keybank.tlr.api.TellerController',
                    'lookupCustomer',
                    lineOf(TLR_CONTROLLER, 'return customers.getVerifiedProfile(customerId);'),
                  ),
                  ...springMvcFrames('GET'),
                ],
              }),
            },
            http: {
              method: 'GET',
              url: `https://teller.internal.keybank.example/v1/teller/customers/${id}`,
              status: 500,
              latencySec: latency(ctx, 0.02, 0.1),
            },
            fields: { userAgent: 'TellerWorkstation/12.4.1 (Windows NT 10.0)' },
          });
        }),
      ],
    },
    {
      tla: 'DEP',
      startAfterSec: 30,
      ratePerSec: 1.5,
      templates: [
        tpl('ERROR', (ctx) => {
          const account = ctx.account();
          return javaLog(ctx, {
            logger: DISPATCHER_SERVLET,
            message:
              'Servlet.service() for servlet [dispatcherServlet] in context with path [] threw exception [Request processing failed: java.lang.NullPointerException: CIF profile.customerId] with root cause',
            error: {
              type: 'java.lang.NullPointerException',
              message: 'CIF profile.customerId',
              stack_trace: javaStack({
                type: 'java.lang.NullPointerException',
                message: 'CIF profile.customerId',
                frames: [
                  'java.base/java.util.Objects.requireNonNull(Objects.java:259)',
                  javaFrame(
                    'com.keybank.dep.service.AccountOwnershipService',
                    'isOwner',
                    lineOf(DEP_OWNERSHIP, 'Objects.requireNonNull(profile.customerId()'),
                  ),
                  javaFrame(
                    'com.keybank.dep.api.AccountBalanceController',
                    'balances',
                    lineOf(DEP_CONTROLLER, 'if (!ownership.isOwner('),
                  ),
                  ...springMvcFrames('GET'),
                ],
              }),
            },
            http: {
              method: 'GET',
              url: `https://deposit-accounts-api.internal.keybank.example/v1/accounts/${account}/balances`,
              status: 500,
              latencySec: latency(ctx, 0.02, 0.09),
            },
            fields: { account },
          });
        }),
      ],
    },
    {
      tla: 'BPY',
      startAfterSec: 35,
      ratePerSec: 0.8,
      templates: [
        tpl('ERROR', (ctx) => {
          const id = ctx.customerId();
          return nodeLog(ctx, {
            message: `payee access denied: CIF customerId undefined does not match session customer ${id}`,
            http: {
              method: 'GET',
              url: 'https://billpay.internal.keybank.example/v1/payees',
              status: 403,
              latencySec: latency(ctx, 0.02, 0.15),
            },
            fields: { sessionCustomerId: id },
          });
        }),
      ],
    },
  ],
  fanout: [
    {
      upstreamTla: 'CIF',
      startAfterSec: 20,
      ratePerSec: 0.3,
      templates: perStack({
        java: (app) => [
          tpl('ERROR', (ctx) => {
            const id = ctx.customerId();
            const cls = `${javaPackage(app)}.integration.CifProfileClient`;
            const message = `CIF profile for ${id} has no customerId (customer-profile-api returned 200)`;
            return javaLog(ctx, {
              logger: cls,
              message,
              error: {
                type: 'java.lang.IllegalStateException',
                message,
                stack_trace: javaStack({
                  type: 'java.lang.IllegalStateException',
                  message,
                  frames: [
                    javaFrame(cls, 'fetchProfile', 58 + (app.tla.charCodeAt(0) % 20)),
                    javaFrame(`${javaPackage(app)}.service.CustomerContextService`, 'load', 41),
                    ...springMvcFrames('GET').slice(0, 12),
                  ],
                }),
              },
              http: {
                method: 'GET',
                url: internalUrl(app, `/v1/customers/${id}/summary`),
                status: 502,
                latencySec: latency(ctx, 0.02, 0.2),
              },
            });
          }),
        ],
        node: (app) => [
          tpl('ERROR', (ctx) =>
            nodeLog(ctx, {
              message: 'customer-profile-api response missing customerId',
              error: {
                type: 'TypeError',
                message: "Cannot read properties of undefined (reading 'length')",
                stack_trace: [
                  "TypeError: Cannot read properties of undefined (reading 'length')",
                  `    at toCustomerRef (/app/src/clients/cif.ts:${31 + (app.tla.charCodeAt(1) % 15)}:28)`,
                  NODE_TICKS,
                ].join('\n'),
              },
              http: {
                method: 'GET',
                url: internalUrl(app, `/v1/customers/${ctx.customerId()}`),
                status: 502,
                latencySec: latency(ctx, 0.02, 0.2),
              },
              fields: { upstream: 'customer-profile-api', upstreamStatus: 200 },
            }),
          ),
        ],
        python: (app) => [
          tpl('ERROR', (ctx) =>
            pyLog(ctx, {
              logger: `${pyPackage(app)}.clients.cif`,
              message: 'CIF profile lookup failed',
              error: {
                type: 'KeyError',
                message: "'customerId'",
                stack_trace: [
                  'Traceback (most recent call last):',
                  `  File "/app/src/${pyPackage(app)}/clients/cif.py", line ${44 + (app.tla.charCodeAt(2) % 10)}, in get_customer`,
                  '    return Customer(id=body["customerId"], name=body["firstName"])',
                  '                       ~~~~^^^^^^^^^^^^^^',
                  "KeyError: 'customerId'",
                ].join('\n'),
              },
              fields: { customer_ref: ctx.customerId().slice(-4) },
            }),
          ),
        ],
      }),
    },
  ],
  alerts: [
    moogsoftAlert({
      atSec: 55,
      repeatEverySec: 60,
      tla: 'OLB',
      severity: 'critical',
      manager: 'AppDynamics',
      check: 'http_5xx_rate',
      description: `HTTP 5xx error rate 38.4% on ${olb.runtime.service} (threshold 5%, 5m window)`,
      custom: {
        appd_application: 'OLB-Prod',
        appd_tier: olb.runtime.service,
        health_rule: 'BFF 5xx rate',
        observed_pct: 38.4,
        threshold_pct: 5,
      },
    }),
    moogsoftAlert({
      atSec: 65,
      repeatEverySec: 60,
      tla: 'MBL',
      severity: 'critical',
      manager: 'AppDynamics',
      check: 'http_5xx_rate',
      description: `HTTP 5xx error rate 27.9% on ${mbl.runtime.service} (threshold 5%, 5m window)`,
      custom: {
        appd_application: 'MBL-Prod',
        appd_tier: mbl.runtime.service,
        health_rule: 'Gateway 5xx rate',
        observed_pct: 27.9,
        threshold_pct: 5,
      },
    }),
    moogsoftAlert({
      atSec: 75,
      repeatEverySec: 90,
      tla: 'PAY',
      severity: 'major',
      manager: 'GCP Monitoring',
      check: 'failed_payment_rate',
      description: 'Failed payment rate 21.6% on payments-api (threshold 2%, 10m window)',
      custom: {
        metric: 'custom.googleapis.com/payments/failed_ratio',
        observed_pct: 21.6,
        threshold_pct: 2,
      },
    }),
    moogsoftAlert({
      atSec: 85,
      repeatEverySec: 120,
      tla: 'OLB',
      severity: 'major',
      manager: 'Synthetics',
      cls: 'Synthetic',
      check: 'synthetic_profile_journey',
      source: 'synthetics-us-east4, synthetics-us-central1, synthetics-us-west1',
      description:
        "Synthetic journey 'OLB login -> profile' failing from 3/3 locations (step 4: GET /bff/v1/profile returned 502)",
      custom: { journey: 'olb-login-profile', failed_locations: 3, step: 4 },
    }),
    moogsoftAlert({
      atSec: 90,
      repeatEverySec: 120,
      tla: 'FRD',
      severity: 'minor',
      manager: 'AppDynamics',
      check: 'error_rate',
      description: 'Error rate 14.2% on fraud-scoring-engine (baseline 0.3%)',
      custom: { appd_application: 'FRD-Prod', observed_pct: 14.2, baseline_pct: 0.3 },
    }),
  ],
  helpdesk: [
    {
      atSec: 100,
      incident: {
        short_description: 'Teller Workstation cannot look up customers - Denver Tech Center',
        description: `Caller: ${denver.name}, ${denver.title} - ${denver.location}
Callback: ${denver.phone}

Issue:
Customer lookup in Teller Workstation fails at every window with "Unable to retrieve customer. Please try again." Searching by account number or by name gives the same error. Tellers cannot verify customers for withdrawals.

Troubleshooting performed:
- Logged out and back in. Same error.
- Tried a different PC. Same error.

Customer impact:
- Line of customers waiting; branch is turning away withdrawals over the ID-only limit.`,
        caller: denver.username,
        opened_by: PERSONAS.serviceDeskAnalyst,
        contact_type: 'phone',
        category: 'application',
        subcategory: 'Branch systems',
        impact: 2,
        urgency: 1,
        assignment_group: 'IT Service Desk',
      },
    },
    {
      atSec: 140,
      incident: {
        short_description:
          "Customers say online and mobile banking won't load their profile - Seattle",
        description: `Caller: ${seattle.name}, ${seattle.title} - ${seattle.location}
Callback: ${seattle.phone}

Issue:
Three customers at the desk this hour said the mobile app and online banking show "Something went wrong loading your profile". When I try to pull them up in Teller Workstation I get an error as well.

Requested action:
Is there an outage? We need something to tell customers.`,
        caller: seattle.username,
        opened_by: serviceDeskAnalyst(2, PERSONAS.serviceDeskAnalyst),
        contact_type: 'phone',
        category: 'application',
        impact: 2,
        urgency: 2,
        assignment_group: 'IT Service Desk',
      },
    },
    {
      atSec: 185,
      incident: {
        short_description: 'Unable to verify customers at teller line - Buffalo Elmwood',
        description: `Chat from ${buffalo.name}, ${buffalo.title} - ${buffalo.location}

All tellers get an error on customer lookup since about 20 minutes ago. Card and cash transactions for customers we can't look up are on hold. Please advise.`,
        caller: buffalo.username,
        opened_by: serviceDeskAnalyst(3, PERSONAS.serviceDeskAnalyst),
        contact_type: 'chat',
        category: 'application',
        subcategory: 'Branch systems',
        impact: 2,
        urgency: 1,
        assignment_group: 'IT Service Desk',
      },
    },
  ],
  redHerrings: [
    {
      atSec: 12,
      kind: 'merge',
      project: OLB_REPO,
      title: 'Update profile error copy per Digital Content review (DCR-482)',
      description: 'Copy-only change from the Digital Content review. No logic changes.\n\nDCR-482',
      author: dev('OLB', 7),
      mergedBy: dev('OLB', 2),
      sourceBranch: 'content/DCR-482-profile-error-copy',
      labels: ['content'],
      edits: [
        {
          path: OLB_PATHS.profileRoutes,
          find: OLB_PROFILE_COPY_LINE,
          replace: "  'Something went wrong loading your profile. Please try again shortly.';",
        },
      ],
    },
    {
      atSec: 26,
      kind: 'merge',
      project: ATH_REPO,
      title: 'chore(deps): bump jose from 5.9.3 to 5.9.6',
      description:
        'Patch release bump. Changelog: fixes for JWE edge cases, no changes to JWS/JWT verification APIs we use.',
      author: dev('ATH', 4),
      mergedBy: dev('ATH', 1),
      sourceBranch: 'deps/jose-5.9.6',
      labels: ['dependencies'],
      edits: [{ path: 'package.json', find: '"jose": "5.9.3"', replace: '"jose": "5.9.6"' }],
    },
  ],
};

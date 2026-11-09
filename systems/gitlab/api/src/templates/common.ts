// biome-ignore-all lint/suspicious/noTemplateCurlyInString: generated source code contains literal ${...} placeholders
import { getWorld } from '@sim/world';
import { web } from '../urls';
import { BASE_IMAGES, FENCE, type Knobs, lines, type RepoContext } from './context';

const STACK_LABEL: Record<string, string> = {
  'java-spring': 'Java 21 / Spring Boot',
  'node-ts': 'Node.js 20 / TypeScript / Fastify',
  python: 'Python 3.12 / FastAPI',
  'react-web': 'React 18 / Vite',
  terraform: 'Terraform / Google Cloud',
};

function localDev(ctx: RepoContext): string {
  switch (ctx.stack) {
    case 'java-spring':
      return lines(
        FENCE + 'bash',
        './mvnw spring-boot:run -Dspring-boot.run.profiles=local',
        './mvnw verify            # unit + integration tests',
        FENCE,
      );
    case 'node-ts':
      return lines(FENCE + 'bash', 'npm ci', 'npm run dev', 'npm test', FENCE);
    case 'python':
      return lines(
        FENCE + 'bash',
        'python -m venv .venv && source .venv/bin/activate',
        'pip install -e ".[dev]"',
        `uvicorn ${ctx.pyPackage}.main:app --reload --port 8080`,
        'pytest',
        FENCE,
      );
    case 'react-web':
      return lines(FENCE + 'bash', 'npm ci', 'npm run dev    # http://localhost:5173', FENCE);
    case 'terraform':
      return lines(
        FENCE + 'bash',
        'terraform init -backend-config="bucket=kb-tfstate-prod"',
        'terraform plan -var-file=envs/prod.tfvars',
        FENCE,
      );
  }
}

const README_SECTIONS: Record<string, (ctx: RepoContext) => string> = {
  troubleshooting: (ctx) =>
    lines(
      '## Troubleshooting',
      '',
      `- **5xx from upstreams**: check the client timeouts in configuration and the upstream app's status in ServiceNow.`,
      `- **Pods restarting**: \`kubectl -n ${ctx.tlaLower}00 describe pod -l app=${ctx.repo.name}\`.`,
      `- **Logs**: Cloud Logging, \`resource.labels.container_name="${ctx.repo.name}"\`.`,
    ),
  oncall: (ctx) =>
    lines(
      '## On-call',
      '',
      `Production issues go to **${ctx.supportGroupName}** in ServiceNow (CI: \`${ctx.tla}\`).`,
      'Page the on-call engineer for P1/P2 incidents; everything else is a regular incident.',
    ),
  'release-process': () =>
    lines(
      '## Release process',
      '',
      '1. Merge to `main` (requires one approval and a green pipeline).',
      '2. Tag `vX.Y.Z` from `main`; the pipeline deploys the tag to production.',
      '3. Update `CHANGELOG.md` in the same MR as the version bump.',
    ),
  observability: (ctx) =>
    lines(
      '## Observability',
      '',
      `- Dashboard: Grafana → *${ctx.app.name}*`,
      '- Metrics: `/actuator/prometheus` (Java) or `/metrics` (Node/Python)',
      `- Alerts route to Moogsoft with the \`${ctx.tla}\` application tag.`,
    ),
};

export const README_SECTION_KEYS = Object.keys(README_SECTIONS);

export function readme(ctx: RepoContext, k: Knobs): string {
  const world = getWorld();
  const deps = ctx.app.upstream.map((tla) => {
    const app = world.appsByTla.get(tla);
    return `| ${tla} | ${app?.name ?? tla} | [${app?.repoPaths[0] ?? ''}](${web()}/${app?.repoPaths[0] ?? ''}) |`;
  });
  const env = ctx.upstreams.map(
    (u) => `| \`${u.envVar}\` | ${u.appName} base URL | \`${u.baseUrl}\` |`,
  );
  return lines(
    `# ${ctx.repo.name}`,
    '',
    ctx.repo.description,
    '',
    `Part of **${ctx.app.name}** (\`${ctx.tla}\`), ${ctx.app.businessUnit}. Tier ${ctx.app.tier}, ${ctx.app.criticality}.`,
    '',
    '| | |',
    '| --- | --- |',
    `| Application | ${ctx.app.name} (${ctx.tla}) |`,
    `| Owner | ${ctx.owner ? `${ctx.owner.name} (@${ctx.owner.username})` : '-'} |`,
    `| Support group | ${ctx.supportGroupName} |`,
    `| Stack | ${STACK_LABEL[ctx.stack]} |`,
    ctx.stack !== 'terraform'
      ? `| Runtime | GKE \`${ctx.app.runtime.cluster}\`, namespace \`${ctx.app.runtime.namespace}\` |`
      : `| GCP project | \`${ctx.app.runtime.gcpProject}\` |`,
    '',
    deps.length > 0 && '## Dependencies',
    deps.length > 0 && '',
    deps.length > 0 && 'Upstream applications this service calls:',
    deps.length > 0 && '',
    deps.length > 0 && '| TLA | Application | Repository |',
    deps.length > 0 && '| --- | --- | --- |',
    ...(deps.length > 0 ? [...deps, ''] : []),
    '## Local development',
    '',
    localDev(ctx),
    '',
    env.length > 0 && '## Configuration',
    env.length > 0 && '',
    env.length > 0 && '| Variable | Purpose | Default |',
    env.length > 0 && '| --- | --- | --- |',
    ...(env.length > 0 ? [...env, ''] : []),
    ...k.readmeSections.flatMap((key) => {
      const render = README_SECTIONS[key];
      return render ? [render(ctx), ''] : [];
    }),
    k.docs.length > 0 && '## Docs',
    k.docs.length > 0 && '',
    ...k.docs.map((d) => `- [${d.title}](${d.path})`),
    k.docs.length > 0 && '',
    '## Contributing',
    '',
    `Branch from \`main\`, open a merge request, and reference the Jira ticket (\`${ctx.tla}-1234\`) in the title.`,
    'CODEOWNERS approval is required.',
    '',
  );
}

export function changelog(k: Knobs): string {
  return lines(
    '# Changelog',
    '',
    'All notable changes to this project are documented here.',
    'The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).',
    '',
    '## [Unreleased]',
    '',
    ...k.changelog.unreleased.map((e) => `- ${e}`),
    k.changelog.unreleased.length > 0 && '',
    ...[...k.changelog.releases]
      .reverse()
      .flatMap((r) => [`## [${r.version}] - ${r.date}`, '', ...r.entries.map((e) => `- ${e}`), '']),
  );
}

export function dockerfile(ctx: RepoContext, k: Knobs): string {
  const base = `${BASE_IMAGES[ctx.stack].image}:${k.baseImage}`;
  switch (ctx.stack) {
    case 'java-spring':
      return lines(
        `FROM maven:3.9-eclipse-temurin-21 AS build`,
        'WORKDIR /src',
        'COPY pom.xml .',
        'RUN mvn -q -B dependency:go-offline',
        'COPY src ./src',
        'RUN mvn -q -B package -DskipTests',
        '',
        `FROM ${base}`,
        'RUN useradd --system --uid 10001 app',
        'WORKDIR /app',
        `COPY --from=build /src/target/${ctx.repo.name}-*.jar app.jar`,
        'USER 10001',
        'EXPOSE 8080',
        'ENV JAVA_TOOL_OPTIONS="-XX:MaxRAMPercentage=75 -XX:+ExitOnOutOfMemoryError"',
        'ENTRYPOINT ["java", "-jar", "/app/app.jar"]',
        '',
      );
    case 'node-ts':
      return lines(
        `FROM ${base} AS build`,
        'WORKDIR /app',
        'COPY package*.json tsconfig.json ./',
        'RUN npm ci',
        'COPY src ./src',
        'RUN npm run build && npm prune --omit=dev',
        '',
        `FROM ${base}`,
        'ENV NODE_ENV=production',
        'WORKDIR /app',
        'COPY --from=build /app/node_modules ./node_modules',
        'COPY --from=build /app/dist ./dist',
        'COPY package.json .',
        'USER node',
        'EXPOSE 8080',
        'CMD ["node", "dist/index.js"]',
        '',
      );
    case 'python':
      return lines(
        `FROM ${base}`,
        'ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1',
        'WORKDIR /app',
        'COPY pyproject.toml .',
        'COPY src ./src',
        'RUN pip install --no-cache-dir .',
        'RUN useradd --system --uid 10001 app',
        'USER 10001',
        'EXPOSE 8080',
        `CMD ["uvicorn", "${ctx.pyPackage}.main:app", "--host", "0.0.0.0", "--port", "8080"]`,
        '',
      );
    case 'react-web':
      return lines(
        'FROM node:20.18.1-alpine3.21 AS build',
        'WORKDIR /app',
        'COPY package*.json ./',
        'RUN npm ci',
        'COPY . .',
        'RUN npm run build',
        '',
        `FROM ${base}`,
        'COPY nginx.conf /etc/nginx/conf.d/default.conf',
        'COPY --from=build /app/dist /usr/share/nginx/html',
        'EXPOSE 8080',
        '',
      );
    case 'terraform':
      return '';
  }
}

export function gitlabCi(ctx: RepoContext, k: Knobs): string {
  const scans = lines(
    k.ci.sast && '  - template: Jobs/SAST.gitlab-ci.yml',
    k.ci.dependencyScanning && '  - template: Jobs/Dependency-Scanning.gitlab-ci.yml',
    '  - template: Jobs/Secret-Detection.gitlab-ci.yml',
  );
  const header = lines(
    'include:',
    `  - project: keybank/platform/ci-templates`,
    '    ref: v4',
    `    file: /templates/${ctx.stack}.yml`,
    scans,
    '',
    'variables:',
    `  APP_TLA: "${ctx.tla}"`,
    `  SERVICE_NAME: "${ctx.repo.name}"`,
    `  GCP_PROJECT: "${ctx.app.runtime.gcpProject}"`,
    '',
  );
  if (ctx.stack === 'terraform') {
    return lines(
      header,
      'stages: [validate, plan, apply]',
      '',
      'validate:',
      '  stage: validate',
      '  script:',
      '    - terraform init -backend=false',
      '    - terraform fmt -check -recursive',
      '    - terraform validate',
      '',
      'plan:prod:',
      '  stage: plan',
      '  script:',
      '    - terraform init',
      '    - terraform plan -var-file=envs/prod.tfvars -out=plan.tfplan',
      '  artifacts:',
      '    paths: [plan.tfplan]',
      '',
      'apply:prod:',
      '  stage: apply',
      '  when: manual',
      '  rules:',
      '    - if: $CI_COMMIT_BRANCH == "main"',
      '  script:',
      '    - terraform apply plan.tfplan',
      '',
    );
  }
  const build: Record<string, string[]> = {
    'java-spring': ['./mvnw -B verify'],
    'node-ts': ['npm ci', 'npm run lint', 'npm test -- --coverage', 'npm run build'],
    python: ['pip install -e ".[dev]"', 'pytest --cov --junitxml=report.xml'],
    'react-web': ['npm ci', 'npm test', 'npm run build'],
  };
  const cachePaths: Record<string, string> = {
    'java-spring': '.m2/repository',
    'node-ts': '.npm/',
    python: '.cache/pip',
    'react-web': '.npm/',
  };
  return lines(
    header,
    'stages: [build, test, package, deploy]',
    '',
    'build:',
    '  stage: build',
    '  script:',
    ...(build[ctx.stack] ?? []).map((s) => `    - ${s}`),
    k.ci.cache && '  cache:',
    k.ci.cache && '    key: ${CI_COMMIT_REF_SLUG}',
    k.ci.cache && `    paths: [${cachePaths[ctx.stack]}]`,
    k.ci.coverage && "  coverage: '/Total.*?([0-9]{1,3})%/'",
    k.ci.coverage && '  artifacts:',
    k.ci.coverage && '    reports:',
    k.ci.coverage && '      junit: "**/TEST-*.xml"',
    '',
    'package:',
    '  stage: package',
    '  extends: .kaniko-build',
    '  variables:',
    `    IMAGE: us-docker.pkg.dev/kb-artifacts/${ctx.tlaLower}00/${ctx.repo.name}`,
    '',
    'deploy:prod:',
    '  stage: deploy',
    '  extends: .gke-deploy',
    '  environment: production',
    '  rules:',
    '    - if: $CI_COMMIT_TAG =~ /^v\\d+\\.\\d+\\.\\d+$/',
    '  variables:',
    `    CLUSTER: ${ctx.app.runtime.cluster}`,
    `    NAMESPACE: ${ctx.app.runtime.namespace}`,
    '',
  );
}

export function gitignore(ctx: RepoContext, k: Knobs): string {
  const base: Record<string, string[]> = {
    'java-spring': [
      'target/',
      '.mvn/wrapper/maven-wrapper.jar',
      '*.iml',
      '.idea/',
      '.vscode/',
      '*.log',
    ],
    'node-ts': ['node_modules/', 'dist/', 'coverage/', '.env', '.env.*', '*.log'],
    python: [
      '__pycache__/',
      '*.pyc',
      '.venv/',
      '.pytest_cache/',
      '.coverage',
      'dist/',
      '*.egg-info/',
      '.env',
    ],
    'react-web': ['node_modules/', 'dist/', 'coverage/', '.env.local', '*.log'],
    terraform: [
      '.terraform/',
      '*.tfstate',
      '*.tfstate.backup',
      '*.tfplan',
      '.terraform.lock.hcl.bak',
      'crash.log',
    ],
  };
  return lines(...(base[ctx.stack] ?? []), '.DS_Store', ...k.gitignoreExtra, '');
}

export function codeowners(ctx: RepoContext): string {
  const devs = ctx.developers.slice(0, 4).map((d) => `@${d.username}`);
  const owner = ctx.owner ? `@${ctx.owner.username}` : '';
  return lines(
    `# ${ctx.app.name} (${ctx.tla})`,
    `* ${devs.join(' ')}`,
    '',
    '[Release]',
    `CHANGELOG.md ${owner} ${devs[0] ?? ''}`.trim(),
    '',
  );
}

/** Seeded history adds docs/runbooks and ADRs from this pool. */
export function docTemplates(ctx: RepoContext): {
  key: string;
  path: string;
  title: string;
  body: string;
}[] {
  const up = ctx.upstreams[0];
  const out = [
    {
      key: 'runbook',
      path: 'docs/runbook.md',
      title: `${ctx.repo.name} runbook`,
      body: lines(
        `# ${ctx.repo.name} runbook`,
        '',
        '## Health checks',
        '',
        `- Readiness: \`GET /health/ready\``,
        `- Liveness: \`GET /health/live\``,
        '',
        '## Common alerts',
        '',
        '| Alert | First steps |',
        '| --- | --- |',
        `| High 5xx rate | Check upstream dependencies (${ctx.app.upstream.join(', ') || 'none'}) and recent deployments. |`,
        '| Pod restarts | Look for OOMKilled in `kubectl describe pod`; compare memory limits. |',
        '| Latency p99 > 2s | Check upstream latency dashboards and connection pool saturation. |',
        '',
        '## Rollback',
        '',
        'Redeploy the previous tag from the pipeline (`deploy:prod`, *Retry* on the earlier tag).',
        '',
      ),
    },
    {
      key: 'adr-timeouts',
      path: 'docs/adr/0001-upstream-timeouts.md',
      title: 'ADR-0001: Upstream timeouts and retries',
      body: lines(
        '# ADR-0001: Upstream timeouts and retries',
        '',
        '## Status',
        '',
        'Accepted',
        '',
        '## Context',
        '',
        `Calls to ${up ? `${up.appName} (${up.tla})` : 'upstream services'} occasionally stall under load. Without explicit`,
        'timeouts, request threads pile up and the service stops responding to health checks.',
        '',
        '## Decision',
        '',
        '- Every upstream client has explicit connect and read timeouts, configured per upstream.',
        '- Only idempotent calls are retried, with exponential backoff and a small retry budget.',
        '- Timeouts are surfaced as `503` to our callers, never as `500`.',
        '',
        '## Consequences',
        '',
        'Callers see fast failures during upstream incidents instead of hung requests.',
        '',
      ),
    },
    {
      key: 'api',
      path: 'docs/api.md',
      title: `${ctx.resource.title} API`,
      body: lines(
        `# ${ctx.resource.title} API`,
        '',
        `Base path: \`/api/v1/${ctx.resource.pluralKebab}\``,
        '',
        '| Method | Path | Description |',
        '| --- | --- | --- |',
        `| GET | \`/api/v1/${ctx.resource.pluralKebab}\` | List ${ctx.resource.title.toLowerCase()} records (paged) |`,
        `| GET | \`/api/v1/${ctx.resource.pluralKebab}/{id}\` | Get one record |`,
        `| POST | \`/api/v1/${ctx.resource.pluralKebab}\` | Create a record |`,
        '',
        'All endpoints require a bearer token issued by ATH.',
        '',
      ),
    },
    {
      key: 'dr',
      path: 'docs/disaster-recovery.md',
      title: 'Disaster recovery',
      body: lines(
        '# Disaster recovery',
        '',
        `- RTO: ${ctx.app.tier === 1 ? '1 hour' : '4 hours'}`,
        `- RPO: ${ctx.app.tier === 1 ? '5 minutes' : '1 hour'}`,
        `- Secondary region: ${ctx.app.runtime.region === 'us-east4' ? 'us-central1' : 'us-west2'}`,
        '',
        'Failover is coordinated by Major Incident Management. See the enterprise DR playbook.',
        '',
      ),
    },
  ];
  return out;
}

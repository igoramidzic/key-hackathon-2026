import { startApi } from '@sim/api-kit/node';
import { PORTS } from '@sim/contracts';
import { createGitlabApp, SERVICE } from './app';
import { getStore } from './state';

const started = performance.now();
const stats = getStore().stats();
console.log(
  `[${SERVICE}] seeded ${stats.projects} projects, ${stats.commits} commits, ${stats.merge_requests} MRs in ${Math.round(performance.now() - started)}ms`,
);

startApi(createGitlabApp(), {
  port: Number(process.env.PORT ?? PORTS.gitlab.api),
  service: SERVICE,
});

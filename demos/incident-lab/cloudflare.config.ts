import { defineConfig, bindings, exports } from 'cf/config';
export default defineConfig({
  accountId: '7ca70a1deedbffff10d49a5e395aa978',
  worker: {
    name: 'hackathon-incident-lab',
    entrypoint: './worker.ts',
    compatibilityDate: '2026-11-05',
    env: {
      ASSETS: bindings.assets(),
      INCIDENT_ROOMS: bindings.durableObject({
        worker: 'hackathon-incident-lab',
        exportName: 'IncidentRoom',
      }),
    },
    exports: { IncidentRoom: exports.durableObject({ storage: 'sqlite' }) },
    assets: { notFoundHandling: 'single-page-application', runWorkerFirst: true },
    observability: { enabled: true, traces: { enabled: true } },
  },
});

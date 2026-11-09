import { startApi } from '@sim/api-kit/node';
import { PORTS } from '@sim/contracts';
import { createLogsApp, SERVICE } from './app';

const { app } = createLogsApp({ capacity: Number(process.env.LOGS_CAPACITY ?? 200_000) });

startApi(app, { port: Number(process.env.PORT ?? PORTS.logs.api), service: SERVICE });

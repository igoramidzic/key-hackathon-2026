import { startApi } from '@sim/api-kit/node';
import { PORTS } from '@sim/contracts';
import { buildApp, SERVICE } from './app';

const { app } = buildApp();

startApi(app, { port: Number(process.env.PORT ?? PORTS.servicenow.api), service: SERVICE });

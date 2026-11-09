import { startApi } from '@sim/api-kit/node';
import { PORTS } from '@sim/contracts';
import { createTeamsApp, SERVICE } from './app';

startApi(createTeamsApp(), { port: Number(process.env.PORT ?? PORTS.teams.api), service: SERVICE });

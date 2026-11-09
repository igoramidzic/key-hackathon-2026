import { PORTS } from '@sim/contracts';
import { serveMcpHttp } from '@sim/mcp-kit/node';
import { spec } from './server';

serveMcpHttp(spec, Number(process.env.PORT ?? PORTS.teams.mcp));

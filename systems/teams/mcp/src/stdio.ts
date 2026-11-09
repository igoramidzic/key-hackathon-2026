import { serveMcpStdio } from '@sim/mcp-kit/node';
import { spec } from './server';

await serveMcpStdio(spec);

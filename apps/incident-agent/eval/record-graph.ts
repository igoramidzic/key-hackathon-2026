/** Snapshots the CMDB dependency graph (over MCP) into test/fixtures/graph.json. */
import { writeFileSync } from 'node:fs';
import { loadConfig } from '../src/config';
import { GraphCache } from '../src/correlate/graph';
import { silent } from '../src/log';
import { McpGateway } from '../src/mcp/gateway';

const config = loadConfig();
const mcp = new McpGateway({ urls: config.mcp });
const graph = await new GraphCache(mcp, silent).load();
const edges: [string, string][] = [];
for (const [from, tos] of graph.up) for (const to of tos) edges.push([from, to]);
const out = process.argv[2] ?? 'test/fixtures/graph.json';
writeFileSync(out, JSON.stringify({ nodes: [...graph.nodes.values()], edges }));
console.log(`${graph.size} apps, ${edges.length} edges → ${out}`);
await mcp.close();

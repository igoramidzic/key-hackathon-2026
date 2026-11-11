/**
 * MCP client connectors and wrappers for logs, servicenow, gitlab, and teams.
 */
export const MCP_SYSTEMS = ['logs', 'servicenow', 'gitlab', 'teams'] as const;
export type McpSystem = (typeof MCP_SYSTEMS)[number];

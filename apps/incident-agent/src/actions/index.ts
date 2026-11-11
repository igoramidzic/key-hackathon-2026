/**
 * Incident agent actions and MCP tool execution wrappers.
 */
export interface AgentAction {
  name: string;
  system: 'logs' | 'servicenow' | 'gitlab' | 'teams';
  params: Record<string, unknown>;
}

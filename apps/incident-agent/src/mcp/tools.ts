/**
 * Which server owns each tool, and which tools only read. LLM phases get read tools only; every
 * write goes through orchestrator code. Unknown tools count as writes, so a new tool is denied to
 * the model until it is listed here.
 */
import type { ServerName } from '../config';

export const READ_TOOLS = {
  logs: [
    'search_logs',
    'get_log_entry',
    'tail_logs',
    'summarize_errors',
    'get_log_histogram',
    'list_log_services',
    'list_alerts',
    'get_alert',
  ],
  servicenow: [
    'list_incidents',
    'get_incident',
    'list_change_requests',
    'get_change_request',
    'search_apps',
    'get_app',
    'get_app_dependencies',
    'search_support_groups',
    'get_support_group',
    'search_users',
    'get_user',
  ],
  gitlab: [
    'search_projects',
    'get_project',
    'list_recent_commits',
    'get_commit',
    'compare_refs',
    'list_merge_requests',
    'get_merge_request',
    'get_file_tree',
    'get_file',
    'fetch_repository',
  ],
  teams: ['list_teams', 'list_channels', 'get_channel', 'read_messages', 'list_notifications'],
} as const satisfies Record<ServerName, readonly string[]>;

export const WRITE_TOOLS = {
  logs: ['update_alert'],
  servicenow: [
    'create_incident',
    'update_incident',
    'add_incident_note',
    'link_child_incidents',
    'create_change_request',
    'update_change_request',
  ],
  gitlab: ['create_merge_request', 'update_merge_request', 'add_merge_request_note', 'create_tag'],
  teams: ['create_channel', 'add_channel_members', 'remove_channel_member', 'post_message'],
} as const satisfies Record<ServerName, readonly string[]>;

export type ReadTool = (typeof READ_TOOLS)[ServerName][number];
export type WriteTool = (typeof WRITE_TOOLS)[ServerName][number];
export type ToolName = ReadTool | WriteTool;

const OWNER = new Map<string, ServerName>();
for (const table of [READ_TOOLS, WRITE_TOOLS] as Record<ServerName, readonly string[]>[])
  for (const [server, tools] of Object.entries(table) as [ServerName, readonly string[]][])
    for (const t of tools) OWNER.set(t, server);

const READ = new Set<string>(Object.values(READ_TOOLS).flat());

export function serverOf(tool: string): ServerName {
  const server = OWNER.get(tool);
  if (!server) throw new Error(`Unknown MCP tool "${tool}"`);
  return server;
}

export function isReadTool(tool: string): boolean {
  return READ.has(tool);
}

/** Tool name as the Claude Agent SDK exposes it: `mcp__<server>__<tool>`. */
export function qualified(tool: string): string {
  return `mcp__${serverOf(tool)}__${tool}`;
}

export const ALL_WRITE_TOOLS: string[] = Object.values(WRITE_TOOLS).flat();

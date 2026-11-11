/**
 * Known-good "Try it" arguments per tool, against the seeded baseline. Tools not listed fall back
 * to an example built from the schema. `note` explains where to get an id that changes per run.
 */
export const EXAMPLES: Record<string, { args: Record<string, unknown>; note?: string }> = {
  // logs
  search_logs: { args: { filter: 'severity>=ERROR', start_time: '15m', limit: 5 } },
  get_log_entry: {
    args: { insert_id: '<insert_id>' },
    note: 'Insert ids change every run: copy one from search_logs.',
  },
  tail_logs: { args: { filter: 'severity>=WARNING', wait_seconds: 5, limit: 10 } },
  summarize_errors: { args: { start_time: '30m', limit: 10 } },
  get_log_histogram: { args: { filter: 'severity>=WARNING', start_time: '30m' } },
  list_log_services: { args: { start_time: '15m', limit: 10 } },
  list_alerts: { args: { status: ['open'], limit: 5 } },
  get_alert: { args: { id: 0 }, note: 'Alert ids change every run: copy one from list_alerts.' },
  update_alert: {
    args: { id: 0, status: 'acknowledged', note: 'Looking into it.' },
    note: 'Alert ids change every run: copy one from list_alerts.',
  },
  // servicenow
  list_incidents: { args: { active: true, limit: 5 } },
  get_incident: { args: { number: 'INC0010203' } },
  create_incident: {
    args: {
      short_description: 'Customer profile lookups failing in OLB and MBL',
      description: 'Downstream apps report 500s since 14:05 ET. Investigating CIF.',
      app_tla: 'CIF',
      impact: 2,
      urgency: 2,
      contact_type: 'monitoring',
      assignment_group: 'grp_cif_support',
    },
  },
  update_incident: {
    args: { number: 'INC0010203', state: 'in_progress', work_note: 'Picked up by automation.' },
  },
  add_incident_note: {
    args: { number: 'INC0010203', type: 'work_note', text: 'Checked recent merges.' },
  },
  list_change_requests: { args: { implemented_after: '2d', sort: '-implemented_at', limit: 5 } },
  get_change_request: {
    args: { number: 'CHG0030001' },
    note: 'Change numbers depend on the history backfill: copy one from list_change_requests.',
  },
  create_change_request: {
    args: {
      short_description: 'CIF - restore snake_case JSON naming (INC0010205)',
      app_tla: 'CIF',
      merge_requests: ['keybank/CIF00/customer-profile-api!<iid>'],
      planned_start: 'now',
      type: 'emergency',
      related_incidents: ['<INC>'],
    },
    note: 'Use a fix MR a human has merged; KBR aborts the change if any MR is not merged.',
  },
  update_change_request: {
    args: { number: '<CHG>', planned_start: 'now', work_note: 'MR merged, rescheduling.' },
    note: 'Use a change you created (new or scheduled).',
  },
  search_apps: { args: { query: 'payments', limit: 5 } },
  get_app: { args: { tla: 'CIF' } },
  get_app_dependencies: { args: { tla: 'OLB', direction: 'up', depth: 2 } },
  search_support_groups: { args: { query: 'noc' } },
  get_support_group: { args: { group: 'grp_cif_support' } },
  search_users: { args: { query: 'whitfield' } },
  get_user: { args: { username: 'dwhitfield' } },
  link_child_incidents: {
    args: {
      parent: '<parent INC>',
      children: ['<INC>', '<INC>'],
      child_comment: 'Known outage, tracked in the parent incident. Updates will follow here.',
    },
    note: 'Use incidents you created: list_incidents with contact_type ["phone"] and relationship "standalone" finds calls to group.',
  },
  // gitlab
  search_projects: { args: { tla: 'CIF' } },
  get_project: { args: { project: 'keybank/CIF00/customer-profile-api' } },
  list_recent_commits: { args: { tla: 'CIF', since: '7d', limit: 5 } },
  get_commit: {
    args: { project: 'keybank/CIF00/customer-profile-api', sha: '<sha>' },
    note: 'Copy a sha from list_recent_commits or compare_refs.',
  },
  compare_refs: {
    args: { project: 'keybank/CIF00/customer-profile-api', from: 'main~2', to: 'main' },
  },
  list_merge_requests: { args: { tla: 'CIF', state: 'merged', merged_after: '7d' } },
  get_merge_request: { args: { project: 'keybank/CIF00/customer-profile-api', iid: 8 } },
  get_file_tree: { args: { project: 'keybank/CIF00/customer-profile-api', recursive: true } },
  get_file: {
    args: {
      project: 'keybank/CIF00/customer-profile-api',
      path: 'src/main/resources/application.yml',
    },
  },
  fetch_repository: { args: { project: 'keybank/CIF00/customer-profile-api' } },
  create_merge_request: {
    args: {
      project: 'keybank/CIF00/customer-profile-api',
      title: 'docs: add runbook note (INC0010203)',
      description: 'Tried from the agent docs.',
      source_branch: 'docs/try-it',
      changes: [{ path: 'RUNBOOK.md', content: '# Runbook\n\nPage CIF on-call first.\n' }],
      labels: ['incident'],
    },
    note: 'Branch names must be new: change source_branch to call it again.',
  },
  update_merge_request: {
    args: { project: 'keybank/CIF00/customer-profile-api', iid: 8, add_labels: ['incident'] },
  },
  add_merge_request_note: {
    args: {
      project: 'keybank/CIF00/customer-profile-api',
      iid: 8,
      body: 'Reviewed by automation.',
    },
  },
  create_tag: {
    args: {
      project: 'keybank/CIF00/customer-profile-api',
      tag_name: 'docs-try-it',
      ref: 'main',
      message: 'Tagged from the agent docs',
    },
    note: 'Tag names must be new: change tag_name to call it again.',
  },
  // teams
  list_teams: { args: {} },
  list_channels: { args: { incident_only: false } },
  get_channel: { args: { channel: 'general' } },
  create_channel: {
    args: {
      name: 'inc0010203-docs-try-it',
      description: 'INC0010203: trying create_channel from the agent docs.',
      members: [{ user: 'dwhitfield', reason: 'NOC shift lead, incident commander' }],
    },
    note: 'Channel names must be new: change name to call it again.',
  },
  add_channel_members: {
    args: { channel: 'general', members: [{ user: 'tokafor', reason: 'Major incident manager' }] },
  },
  remove_channel_member: { args: { channel: 'general', user: 'tokafor' } },
  post_message: {
    args: { channel: 'general', body: 'Hello from the **agent docs**. @dwhitfield FYI.' },
  },
  read_messages: { args: { channel: 'general', limit: 5 } },
  list_notifications: { args: { user: 'dwhitfield' } },
};

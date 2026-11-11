import { URLS } from '@sim/contracts';
import {
  Button,
  Card,
  CardContent,
  cn,
  Input,
  NativeSelect,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@sim/ui';
import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { InlineCode, Section, Snippet, SnippetTabs } from './bits';
import { endpoints } from './mcp';
import { useTarget } from './target';

const STREAM_PARAMS: [string, string][] = [
  ['filter', 'Logs Explorer query, e.g. severity>=ERROR AND labels.app_tla="PAY"'],
  ['severity', 'Minimum severity: DEBUG, INFO, NOTICE, WARNING, ERROR, CRITICAL'],
  ['app_tla', 'Only this app (ServiceNow TLA), e.g. OLB'],
  ['service', 'Only this service (container name), e.g. payments-api'],
  ['q', 'Free-text match anywhere in the entry'],
  ['after_seq', 'Resume after this seq (same as the Last-Event-ID header)'],
];

const FIELDS: [string, string][] = [
  ['seq', 'Monotonic sequence number; also the SSE event id'],
  ['severity', 'DEBUG … CRITICAL'],
  ['timestamp', 'ISO 8601, UTC'],
  ['labels.app_tla', 'App TLA, the key into ServiceNow (get_app) and GitLab (keybank/<TLA>00/…)'],
  ['resource.labels.container_name', 'Service name, e.g. payments-api'],
  ['jsonPayload.message', 'The log message'],
  ['jsonPayload.error', '{ type, message, stack_trace } on exceptions'],
  ['httpRequest', '{ requestMethod, requestUrl, status, latency } on request logs'],
  ['trace', 'Ties one request together across services'],
];

const ACTIVITY_PARAMS: [string, string][] = [
  ['table', 'incident, change_request (comma separated)'],
  [
    'kind',
    'incident.opened, incident.updated, incident.work_note, incident.comment, change_request.* (comma separated)',
  ],
  ['app_tla', 'Only these apps, e.g. CIF,OLB'],
  ['contact_type', 'Incidents opened via phone, email, chat, self_service, walk_in or monitoring'],
  ['after_seq', 'Resume after this seq (same as Last-Event-ID); 0 replays seeded history'],
];

const ACTIVITY_FIELDS: [string, string][] = [
  ['seq', 'Monotonic across incidents and change requests; also the SSE event id'],
  ['kind', 'e.g. incident.opened, incident.updated, incident.comment'],
  ['number', 'INC… or CHG… number'],
  ['app_tla', 'App TLA of the record, or null'],
  ['at', 'When the journal entry was recorded (ISO 8601, UTC)'],
  ['entry', '{ type, text, author, changes } the journal entry; changes lists field updates'],
  ['incident', 'Incident summary as it is now (state, priority, caller, contact_type, web_url)'],
  ['change_request', 'Change request summary as it is now, for change events'],
];

const SIM_API: [string, string, string][] = [
  [
    'GET',
    '/api/status',
    'Engine, systems, traffic and the current run (phase, bad and fix MR, alerts)',
  ],
  ['GET', '/api/scenarios', 'Scenario list, including the answer key'],
  ['GET', '/api/scenarios/:id', 'One scenario with its bad MR, fix, impacts and timeline'],
  [
    'POST',
    '/api/scenarios/:id/trigger',
    'Start a scenario. Body: { speed?: 1–10, force?: boolean }',
  ],
  ['POST', '/api/stop', 'Stop the current run'],
  ['POST', '/api/reset', 'Restore every system to the seeded baseline'],
  [
    'POST',
    '/api/traffic',
    'Background traffic. Body: { paused?: boolean, rate_multiplier?: 0–10 }',
  ],
];

export function StreamPage() {
  const { target } = useTarget();
  const ep = endpoints(target);
  const streamUrl = `${ep.logsApi}/api/logs/stream`;
  const activityUrl = `${ep.servicenowApi}/api/activity/stream`;
  return (
    <div className="grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-10">
      <div className="grid gap-2">
        <h1 className="font-semibold text-2xl tracking-tight">Live streams &amp; simulator API</h1>
        <p className="max-w-3xl text-base text-muted-foreground">
          Plain HTTP endpoints next to the MCP servers: live log and ServiceNow activity feeds for a
          detector that decides when to start the agent, and the simulator API for driving test runs
          from a harness.
        </p>
      </div>

      <Section
        title="Live log stream"
        description="Server-Sent Events, one 'log' event per entry in arrival order. Reconnect with Last-Event-ID (or ?after_seq=) to resume without gaps. Heartbeats every 15 s; a 'reset' event means the world was reset."
      >
        <SnippetTabs
          tabs={[
            {
              id: 'curl',
              label: 'curl',
              language: 'bash',
              code: `curl -N "${streamUrl}?severity=WARNING"`,
            },
            {
              id: 'ts',
              label: 'TypeScript',
              language: 'typescript',
              code: `const es = new EventSource('${streamUrl}?severity=ERROR');
es.addEventListener('log', (e) => {
  const entry = JSON.parse(e.data); // GCP LogEntry + seq
  if (entry.labels.app_tla === 'PAY') console.log(entry.jsonPayload.message);
});`,
            },
            {
              id: 'py',
              label: 'Python',
              language: 'python',
              code: `import json, requests

with requests.get("${streamUrl}", params={"severity": "ERROR"}, stream=True) as r:
    for line in r.iter_lines(decode_unicode=True):
        if line.startswith("data: "):
            entry = json.loads(line[6:])
            print(entry["labels"]["app_tla"], entry["jsonPayload"]["message"])`,
            },
            {
              id: 'poll',
              label: 'Long-poll',
              language: 'bash',
              code: `curl -s "${ep.logsApi}/api/logs/tail?after_seq=0&wait_seconds=30"   # then pass the returned cursor`,
            },
          ]}
        />
        <LiveTail />
        <div className="grid gap-4 lg:grid-cols-2">
          <ParamCard title="Query parameters (all optional)" rows={STREAM_PARAMS} />
          <ParamCard title="Entry fields (GCP LogEntry shape)" rows={FIELDS} />
        </div>
        <div className="grid gap-2">
          <span className="font-medium text-sm">
            Query language (a practical subset of Logs Explorer)
          </span>
          <Snippet
            language="plaintext"
            code={`severity>=ERROR AND labels.app_tla=("OLB" OR "MBL") AND jsonPayload.message:"customerId"
resource.labels.container_name="payments-api" httpRequest.status>=500 -"client disconnected"`}
          />
          <p className="text-muted-foreground text-xs">
            The same syntax works in the <InlineCode>search_logs</InlineCode> tool and the Logs
            Explorer UI.
          </p>
        </div>
      </Section>

      <Section
        title="ServiceNow activity feed"
        description="Every journal entry on incidents and change requests (opened, field changes, work notes, comments) in the order ServiceNow recorded it. Use it to react to incidents raised by people (bankers phoning the service desk), which never show up in the logs. Same mechanics as the log stream: SSE or long-poll, resumable by seq, 'reset' event on world reset."
      >
        <SnippetTabs
          tabs={[
            {
              id: 'curl',
              label: 'curl',
              language: 'bash',
              code: `curl -N "${activityUrl}?kind=incident.opened&contact_type=phone,email,chat"`,
            },
            {
              id: 'ts',
              label: 'TypeScript',
              language: 'typescript',
              code: `import { createServiceNowClient } from '@sim/contracts/servicenow';

// Long-polls under the hood: works in Node without an EventSource library.
const sn = createServiceNowClient('${ep.servicenowApi}');
for await (const ev of sn.followActivity({ kind: 'incident.opened', contact_type: 'phone,email,chat' })) {
  console.log(ev.number, ev.incident?.short_description);
}`,
            },
            {
              id: 'py',
              label: 'Python',
              language: 'python',
              code: `import requests

url = "${ep.servicenowApi}/api/activity/tail"
head = requests.get(url, params={"limit": 1}).json()
cursor, epoch = head["last_seq"], head["epoch"]  # start live
while True:
    r = requests.get(url, params={"after_seq": cursor, "wait_seconds": 30,
                                  "kind": "incident.opened", "contact_type": "phone,email,chat"}).json()
    if r["epoch"] != epoch:  # world reset: seqs restarted, carry on live
        cursor, epoch = r["last_seq"], r["epoch"]
        continue
    for ev in r["items"]:
        print(ev["number"], ev["incident"]["short_description"])
    cursor = r["cursor"]`,
            },
            {
              id: 'poll',
              label: 'Long-poll',
              language: 'bash',
              code: `curl -s "${ep.servicenowApi}/api/activity/tail?after_seq=0&wait_seconds=30&table=incident"   # then pass the returned cursor`,
            },
          ]}
        />
        <LiveActivity />
        <div className="grid gap-4 lg:grid-cols-2">
          <ParamCard title="Query parameters (all optional)" rows={ACTIVITY_PARAMS} />
          <ParamCard title="Event fields" rows={ACTIVITY_FIELDS} />
        </div>
      </Section>

      <Section
        title="Simulator API"
        description="For your test harness, not for the agent: it returns the answer key. Base URL below; the CLI (pnpm sim) wraps the same calls."
      >
        <Snippet code={ep.simApi} language="plaintext" />
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20 pl-4">Method</TableHead>
                  <TableHead className="w-72">Path</TableHead>
                  <TableHead className="pr-4">What</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SIM_API.map(([m, p, what]) => (
                  <TableRow key={`${m} ${p}`}>
                    <TableCell className="pl-4 font-mono text-xs">{m}</TableCell>
                    <TableCell className="font-mono text-xs">{p}</TableCell>
                    <TableCell className="whitespace-normal pr-4 text-sm">{what}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-sm">
          Success check for a run: <InlineCode>GET /api/status</InlineCode> →{' '}
          <InlineCode>run.phase === "recovered"</InlineCode> after the agent's MR is merged.
        </p>
      </Section>
    </div>
  );
}

function ParamCard({ title, rows }: { title: string; rows: [string, string][] }) {
  return (
    <Card className="gap-2 py-3">
      <div className="px-4 font-medium text-sm">{title}</div>
      <CardContent className="px-0">
        <Table>
          <TableBody>
            {rows.map(([k, v]) => (
              <TableRow key={k} className="align-top">
                <TableCell className="pl-4 font-mono text-xs">{k}</TableCell>
                <TableCell className="whitespace-normal pr-4 text-muted-foreground text-xs leading-5">
                  {v}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

interface Entry {
  seq: number;
  severity: string;
  timestamp: string;
  labels?: { app_tla?: string };
  resource?: { labels?: { container_name?: string } };
  jsonPayload?: { message?: string };
}

const SEV_CLASS: Record<string, string> = {
  WARNING: 'text-warning',
  ERROR: 'text-negative',
  CRITICAL: 'text-negative font-semibold',
};

/** Connects to this host's stream and shows the newest entries. */
function LiveTail() {
  const [on, setOn] = useState(false);
  const [severity, setSeverity] = useState('WARNING');
  const [filter, setFilter] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');
  const filterRef = useRef(filter);
  filterRef.current = filter;

  useEffect(() => {
    if (!on) {
      setState('idle');
      return;
    }
    const params = new URLSearchParams({ severity });
    if (filterRef.current.trim()) params.set('filter', filterRef.current.trim());
    const es = new EventSource(`${URLS.logs.api}/api/logs/stream?${params}`);
    setState('connecting');
    es.onopen = () => setState('live');
    es.onerror = () => setState('error');
    es.addEventListener('log', (e) => {
      const entry = JSON.parse((e as MessageEvent).data) as Entry;
      setEntries((prev) => [entry, ...prev].slice(0, 40));
    });
    return () => es.close();
  }, [on, severity]);

  return (
    <Card className="gap-3 py-3">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="mr-auto font-medium text-sm">Watch it live (this host)</span>
        <NativeSelect
          value={severity}
          onChange={(e) => setSeverity(e.target.value)}
          className="h-7 w-32 text-xs"
          aria-label="Minimum severity"
        >
          {['INFO', 'WARNING', 'ERROR'].map((s) => (
            <option key={s} value={s}>
              ≥ {s}
            </option>
          ))}
        </NativeSelect>
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && on) {
              setOn(false);
              setTimeout(() => setOn(true), 0);
            }
          }}
          placeholder='filter, e.g. labels.app_tla="PAY"'
          className="h-7 w-64 font-mono text-xs"
          aria-label="Stream filter"
        />
        <Button size="sm" variant={on ? 'outline' : 'default'} onClick={() => setOn(!on)}>
          {on ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {on ? 'Stop' : 'Connect'}
        </Button>
      </div>
      <div className="mx-4 h-64 overflow-auto border bg-muted/30 font-mono text-[11.5px] leading-5">
        {entries.length === 0 ? (
          <div className="grid h-full place-items-center text-muted-foreground">
            {state === 'error'
              ? 'Stream unreachable. Is pnpm dev running?'
              : state === 'idle'
                ? 'Connect to watch entries arrive.'
                : 'Waiting for entries…'}
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.seq} className="flex gap-2 whitespace-nowrap px-2">
              <span className="text-muted-foreground tabular-nums">{e.seq}</span>
              <span className="text-muted-foreground">{e.timestamp.slice(11, 19)}</span>
              <span className={cn('w-16 shrink-0', SEV_CLASS[e.severity])}>{e.severity}</span>
              <span className="w-8 shrink-0">{e.labels?.app_tla}</span>
              <span className="w-40 shrink-0 truncate text-muted-foreground">
                {e.resource?.labels?.container_name}
              </span>
              <span className="truncate">{e.jsonPayload?.message}</span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

interface ActivityEvent {
  seq: number;
  kind: string;
  number: string;
  app_tla: string | null;
  at: string;
  entry: { type: string; text: string; author?: { username: string } };
  incident?: { short_description: string; contact_type: string; priority: number };
  change_request?: { short_description: string };
}

const KIND_CLASS: Record<string, string> = {
  'incident.opened': 'text-warning',
  'change_request.opened': 'text-warning',
};

/** Connects to this host's ServiceNow activity stream and shows the newest events. */
function LiveActivity() {
  const [on, setOn] = useState(false);
  const [table, setTable] = useState('incident');
  const [opened, setOpened] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [state, setState] = useState<'idle' | 'connecting' | 'live' | 'error'>('idle');

  useEffect(() => {
    if (!on) {
      setState('idle');
      return;
    }
    const params = new URLSearchParams();
    if (table) params.set('table', table);
    if (opened) params.set('kind', 'incident.opened,change_request.opened');
    const es = new EventSource(`${URLS.servicenow.api}/api/activity/stream?${params}`);
    setState('connecting');
    es.onopen = () => setState('live');
    es.onerror = () => setState('error');
    es.addEventListener('activity', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as ActivityEvent;
      setEvents((prev) => [ev, ...prev].slice(0, 40));
    });
    es.addEventListener('reset', () => setEvents([]));
    return () => es.close();
  }, [on, table, opened]);

  return (
    <Card className="gap-3 py-3">
      <div className="flex flex-wrap items-center gap-2 px-4">
        <span className="mr-auto font-medium text-sm">Watch it live (this host)</span>
        <NativeSelect
          value={table}
          onChange={(e) => setTable(e.target.value)}
          className="h-7 w-40 text-xs"
          aria-label="Table"
        >
          <option value="incident">Incidents</option>
          <option value="change_request">Change requests</option>
          <option value="">Both</option>
        </NativeSelect>
        <NativeSelect
          value={opened ? 'opened' : 'all'}
          onChange={(e) => setOpened(e.target.value === 'opened')}
          className="h-7 w-40 text-xs"
          aria-label="Kinds"
        >
          <option value="all">All activity</option>
          <option value="opened">Newly opened only</option>
        </NativeSelect>
        <Button size="sm" variant={on ? 'outline' : 'default'} onClick={() => setOn(!on)}>
          {on ? <Pause data-icon="inline-start" /> : <Play data-icon="inline-start" />}
          {on ? 'Stop' : 'Connect'}
        </Button>
      </div>
      <div className="mx-4 h-64 overflow-auto border bg-muted/30 font-mono text-[11.5px] leading-5">
        {events.length === 0 ? (
          <div className="grid h-full place-items-center px-4 text-center text-muted-foreground">
            {state === 'error'
              ? 'Stream unreachable. Is pnpm dev running?'
              : state === 'idle'
                ? 'Connect to watch incidents and changes arrive.'
                : 'Waiting for activity… (pnpm sim trigger a scenario, or edit an incident)'}
          </div>
        ) : (
          events.map((e) => (
            <div key={e.seq} className="flex gap-2 whitespace-nowrap px-2">
              <span className="text-muted-foreground tabular-nums">{e.seq}</span>
              <span className="text-muted-foreground">{e.at.slice(11, 19)}</span>
              <span className={cn('w-44 shrink-0', KIND_CLASS[e.kind])}>{e.kind}</span>
              <span className="w-24 shrink-0">{e.number}</span>
              <span className="w-8 shrink-0">{e.app_tla}</span>
              <span className="w-16 shrink-0 text-muted-foreground">
                {e.incident?.contact_type ?? ''}
              </span>
              <span className="truncate">
                {e.kind.endsWith('.opened')
                  ? (e.incident?.short_description ?? e.change_request?.short_description)
                  : e.entry.text}
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

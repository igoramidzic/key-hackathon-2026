import type { RunEvent, RunStatus, ScenarioSummary } from '@sim/contracts/simulator';
import {
  Alert,
  AlertDescription,
  AppShell,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cn,
  ErrorState,
  PageHeader,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from '@sim/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Check, Loader2, Play, Square } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { HeaderActions } from './Header';
import {
  ButtonIcon,
  errorText,
  formatDuration,
  KIND_LABEL,
  PhaseBadge,
  sim,
  useScenarioDetail,
  useScenarios,
  useStatus,
  useTicker,
} from './lib';

// ---------------------------------------------------------------------------
// The current run: five plain steps, one sentence, the one link that matters.
// ---------------------------------------------------------------------------

type StepTone = 'warning' | 'negative' | 'info' | 'positive';

interface Step {
  label: string;
  done: boolean;
  tone: StepTone;
  at?: number;
}

/** Color per step: amber for the change, red while things break, blue for the fix, green when healthy. */
const STEP_COLOR: Record<
  StepTone,
  { bar: string; soft: string; box: string; ring: string; text: string }
> = {
  warning: {
    bar: 'bg-chart-2',
    soft: 'bg-chart-2/30',
    box: 'border-chart-2 bg-chart-2',
    ring: 'border-chart-2 text-chart-2',
    text: 'text-chart-2',
  },
  negative: {
    bar: 'bg-negative',
    soft: 'bg-negative/30',
    box: 'border-negative bg-negative',
    ring: 'border-negative text-negative',
    text: 'text-negative',
  },
  info: {
    bar: 'bg-chart-1',
    soft: 'bg-chart-1/30',
    box: 'border-chart-1 bg-chart-1',
    ring: 'border-chart-1 text-chart-1',
    text: 'text-chart-1',
  },
  positive: {
    bar: 'bg-positive',
    soft: 'bg-positive/30',
    box: 'border-positive bg-positive',
    ring: 'border-positive text-positive',
    text: 'text-positive',
  },
};

const firstOffset = (events: RunEvent[], kinds: RunEvent['kind'][]) =>
  events.find((e) => kinds.includes(e.kind))?.offset_sec;

function steps(run: RunStatus): Step[] {
  const helpdesk = run.kind === 'helpdesk';
  return [
    {
      label: 'Bad change merged',
      tone: 'warning',
      done: run.bad_mr !== null,
      at: firstOffset(run.events, ['merge']),
    },
    {
      label: 'Errors spreading',
      tone: 'negative',
      done: run.fault_onset_at !== null,
      at: firstOffset(run.events, ['fault']),
    },
    helpdesk
      ? {
          label: 'Help desk call',
          tone: 'negative',
          done: run.helpdesk.length > 0,
          at: firstOffset(run.events, ['helpdesk']),
        }
      : {
          label: 'Alerts firing',
          tone: 'negative',
          done: run.alerts.length > 0,
          at: firstOffset(run.events, ['alert']),
        },
    {
      label: run.fixed_at !== null ? 'Fix merged' : 'Waiting for a fix',
      tone: 'info',
      done: run.fixed_at !== null,
      at: firstOffset(run.events, ['fix']),
    },
    {
      label: 'Recovered',
      tone: 'positive',
      done: run.recovered_at !== null,
      at: firstOffset(run.events, ['recovered']),
    },
  ];
}

function Stepper({ items, active }: { items: Step[]; active: boolean }) {
  const current = items.findIndex((s) => !s.done);
  return (
    <ol className="grid grid-cols-5 gap-2">
      {items.map((step, i) => {
        const isCurrent = active && i === current;
        const c = STEP_COLOR[step.tone];
        return (
          <li key={step.label} className="grid gap-2">
            <div
              className={cn(
                'h-1',
                step.done ? c.bar : isCurrent ? cn(c.soft, 'animate-pulse') : 'bg-muted',
              )}
            />
            <div className="flex items-start gap-1.5">
              <span
                className={cn(
                  'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                  step.done && cn(c.box, 'text-white'),
                  isCurrent && c.ring,
                  !step.done && !isCurrent && 'border-border',
                )}
              >
                {step.done ? (
                  <Check className="size-3" />
                ) : isCurrent ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
              </span>
              <div className="min-w-0">
                <div
                  className={cn(
                    'text-xs',
                    step.done || isCurrent ? 'font-medium' : 'text-muted-foreground',
                  )}
                >
                  {step.label}
                </div>
                {step.at !== undefined && (
                  <div className="text-muted-foreground text-xs tabular-nums">
                    +{formatDuration(step.at)}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function sentence(run: RunStatus): string {
  const apps = run.affected_tlas.length;
  switch (run.phase) {
    case 'pending':
      return 'A change just merged and is rolling out. Nothing looks wrong yet.';
    case 'degrading':
      if (run.kind === 'helpdesk' && run.helpdesk.length > 0)
        return 'A branch manager called the help desk and an incident is open. Monitoring stays quiet, so the agent has to work from the ticket.';
      if (run.alerts.length > 0)
        return `Errors are spreading across ${apps} app${apps === 1 ? '' : 's'} and monitoring is alerting. Now the agent takes over: find the cause, open an incident, bring in the right people and propose a fix.`;
      return 'Errors are starting to show up in the logs.';
    case 'recovering':
      return 'A fix was merged. Errors are dying down.';
    case 'recovered':
      return 'Everything is back to normal. Reset to start fresh, or run another scenario.';
    case 'stopped':
      return 'This run was stopped.';
    case 'failed':
      return run.error ?? 'The scenario could not start.';
  }
}

function Reveal({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-fit text-muted-foreground text-xs underline-offset-4 hover:text-foreground hover:underline"
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && children}
    </div>
  );
}

function AnswerKey({ run }: { run: RunStatus }) {
  const detail = useScenarioDetail(run.id, true);
  const key = detail.data?.answer_key;
  if (!key) return <Spinner className="justify-start p-0" />;
  return (
    <div className="grid gap-2 border-l-2 border-foreground pl-3 text-xs">
      <p>{key.root_cause}</p>
      <p className="text-muted-foreground">{key.why_it_looks_green}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {run.bad_mr && (
          <a
            href={run.bad_mr.web_url}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-4 hover:underline"
          >
            The bad change in GitLab ↗
          </a>
        )}
        <span className="text-muted-foreground">Known fix: {detail.data?.fix.title}</span>
      </div>
    </div>
  );
}

function EventLog({ events }: { events: RunEvent[] }) {
  return (
    <ol className="grid gap-1 text-xs">
      {events.map((e, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-14 shrink-0 text-right text-muted-foreground tabular-nums">
            +{formatDuration(e.offset_sec)}
          </span>
          <span className="min-w-0">
            {e.url ? (
              <a
                href={e.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 hover:underline"
              >
                {e.message}
              </a>
            ) : (
              e.message
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CurrentRun({ run }: { run: RunStatus }) {
  const qc = useQueryClient();
  const now = useTicker(run.active);
  const elapsed = run.active ? (now - Date.parse(run.started_at)) / 1000 : run.elapsed_sec;
  const stop = useMutation({
    mutationFn: sim.stop,
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });
  const incident = run.helpdesk[0];

  return (
    <Card>
      <CardHeader>
        <CardDescription>{run.active ? 'Running now' : 'Last run'}</CardDescription>
        <CardTitle className="text-base">{run.title}</CardTitle>
        <CardAction className="flex items-center gap-3">
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDuration(elapsed)}
          </span>
          <PhaseBadge phase={run.phase} />
          {run.active && (
            <Button
              size="sm"
              variant="outline"
              disabled={stop.isPending}
              onClick={() => stop.mutate()}
            >
              <ButtonIcon loading={stop.isPending} icon={<Square />} />
              Stop
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-5">
        <Stepper items={steps(run)} active={run.active} />
        <p className="max-w-3xl text-sm">{sentence(run)}</p>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={run.logs_url} target="_blank" rel="noreferrer">
              Watch the errors in the logs
              <ArrowUpRight data-icon="inline-end" />
            </a>
          </Button>
          {incident && (
            <Button asChild size="sm" variant="outline">
              <a href={incident.web_url} target="_blank" rel="noreferrer">
                Open {incident.number}
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
          )}
        </div>
      </CardContent>
      <CardFooter className="grid gap-4 border-t">
        <Reveal label="answer">
          <AnswerKey run={run} />
        </Reveal>
        <Reveal label="event log">
          <EventLog events={run.events} />
        </Reveal>
      </CardFooter>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Scenario list: one card, one row per scenario.
// ---------------------------------------------------------------------------

function ScenarioRow({
  scenario,
  speed,
  activeId,
}: {
  scenario: ScenarioSummary;
  speed: number;
  activeId: string | null;
}) {
  const qc = useQueryClient();
  const trigger = useMutation({
    mutationFn: () => sim.trigger(scenario.id, { speed }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });
  const isActive = activeId === scenario.id;
  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-sm">{scenario.title}</span>
          <span className="text-muted-foreground text-xs">{KIND_LABEL[scenario.kind]}</span>
        </div>
        <p className="mt-0.5 max-w-3xl text-muted-foreground text-xs">{scenario.summary}</p>
        {trigger.isError && (
          <p className="mt-1 text-negative text-xs">{errorText(trigger.error)}</p>
        )}
      </div>
      <Button
        size="sm"
        variant={isActive ? 'secondary' : 'default'}
        className="shrink-0 sm:w-24"
        disabled={activeId !== null || trigger.isPending}
        onClick={() => trigger.mutate()}
      >
        <ButtonIcon loading={trigger.isPending || isActive} icon={<Play />} />
        {isActive ? 'Running' : 'Start'}
      </Button>
    </li>
  );
}

function ScenarioList({
  scenarios,
  activeId,
}: {
  scenarios: ScenarioSummary[];
  activeId: string | null;
}) {
  const [speed, setSpeed] = useState('1');
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scenarios</CardTitle>
        <CardDescription>
          Each one ships a bad change and lets the consequences play out.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <span className="text-muted-foreground text-xs">Speed</span>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={speed}
            onValueChange={(v) => v && setSpeed(v)}
          >
            {['1', '2', '5'].map((s) => (
              <ToggleGroupItem key={s} value={s} aria-label={`${s}x speed`}>
                {s}×
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {scenarios.map((s) => (
            <ScenarioRow key={s.id} scenario={s} speed={Number(speed)} activeId={activeId} />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------

export function App() {
  const status = useStatus();
  const scenarios = useScenarios();
  const data = status.data;
  const run = data?.run ?? null;
  const phase = data?.engine.phase;

  return (
    <AppShell system="simulator" actions={<HeaderActions status={data} offline={status.isError} />}>
      <div className="mx-auto grid w-full max-w-5xl gap-6">
        <PageHeader
          className="mb-0"
          title="Simulate an incident"
          description="Pick a scenario. A bad change ships, errors spread through the systems above, and your agent takes it from there."
        />
        {status.isError && (
          <ErrorState error="The simulator isn't reachable. Is it running (pnpm dev)?" />
        )}
        {data && phase !== 'running' && (
          <Alert>
            <Loader2 className="animate-spin" />
            <AlertDescription className="first-letter:uppercase">
              {data.engine.message ?? phase?.replace(/_/g, ' ')}
            </AlertDescription>
          </Alert>
        )}
        {run && <CurrentRun run={run} />}
        {run?.active ? null : scenarios.isLoading ? (
          <Spinner label="Loading scenarios" />
        ) : scenarios.isError ? (
          <ErrorState error={scenarios.error} />
        ) : (
          scenarios.data && (
            <ScenarioList scenarios={scenarios.data} activeId={run?.active ? run.id : null} />
          )
        )}
      </div>
    </AppShell>
  );
}

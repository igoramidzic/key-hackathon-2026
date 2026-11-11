/**
 * The guided demo (`/demo`): one screen that runs a scenario and walks the audience through what
 * the incident agent does, live. It embeds the real UIs, moves between them as things happen,
 * spotlights what matters and dims the rest, holds each step long enough to read, and tells the
 * presenter when it is their turn to click.
 *
 * It follows the live systems (the simulator's run status and the agent's case stream) and never
 * a script of timings, so it works for any scenario at any speed.
 */
import { Button, cn, NativeSelect } from '@sim/ui';
import { ArrowLeft, ArrowRight, Loader2, Pause, Play } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { errorText, sim, useScenarios, useStatus } from '../lib';
import { clockOffset, NativePane, runningLanes } from './Agent';
import { Stage } from './Stage';
import { buildStory } from './story';
import { type Beat, CHAPTERS } from './types';
import { agentBase, agentHosted, pickCase, useAgent } from './useAgent';
import './demo.css';

/** Quiet seconds the agent gets after a reset to learn the baseline (as in the eval harness). */
const BASELINE_MS = 15_000;
/** An optional step is skipped once a later one has been waiting this long. */
const SKIP_GRACE_MS = 3_000;
const DEFAULT_SCENARIO = 'cif-snake-case-cascade';
/**
 * The model the audience sees named. KeyBank standardises on Gemini, so outward-facing copy says
 * Gemini; the agent itself runs on Claude (see apps/incident-agent).
 */
const MODEL_LABEL = 'Gemini';

const PACES = [
  { label: 'Relaxed', factor: 1.5 },
  { label: 'Normal', factor: 1 },
  { label: 'Brisk', factor: 0.6 },
];

interface Tour {
  /** When the world was ready (reset finished), or 0 when joining a run in progress. */
  readyAt: number;
  /** When the scenario was triggered (ms), once it has been. */
  triggeredAt: number | null;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function DemoPage() {
  const base = useMemo(agentBase, []);
  const agent = useAgent(base);
  const status = useStatus();
  const scenarios = useScenarios();
  const now = useNow(250);

  const [scenario, setScenario] = useState(DEFAULT_SCENARIO);
  const [tour, setTour] = useState<Tour | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [enteredAt, setEnteredAt] = useState(() => Date.now());
  const [auto, setAuto] = useState(true);
  const pace = 1;
  const history = useRef<number[]>([]);
  const firstReady = useRef<Record<string, number>>({});
  const doneAt = useRef<Record<string, number>>({});
  const triggering = useRef(false);

  const speed = agent.info?.speed ?? 4;
  const liveRun = status.data?.run ?? null;
  const run =
    tour?.triggeredAt && liveRun && Date.parse(liveRun.started_at) >= tour.triggeredAt - 5_000
      ? liveRun
      : null;
  // The agent may already have a case open when the fault starts (a blip while the world settles
  // after the reset) and fold the incident into it, so look back to the reset, not the trigger.
  const since = tour?.triggeredAt ? tour.readyAt || tour.triggeredAt : null;
  const view = useMemo(() => pickCase(agent.cases, since), [agent.cases, since]);

  const beats = useMemo(
    () =>
      buildStory({
        started: tour !== null,
        baselineReady:
          tour !== null && (tour.triggeredAt !== null || now - tour.readyAt >= BASELINE_MS),
        run,
        view,
      }),
    [tour, run, view, now],
  );

  // When each beat became true: what the systems say, else when we first saw it.
  for (const b of beats) if (b.ready) firstReady.current[b.id] ??= now;
  const readyMs = useCallback((b: Beat) => {
    const at = b.at ? Date.parse(b.at) : Number.NaN;
    return Number.isNaN(at) ? (firstReady.current[b.id] ?? Number.POSITIVE_INFINITY) : at;
  }, []);

  const beat = beats[Math.min(index, beats.length - 1)]!;
  if (beat.action?.done) doneAt.current[beat.id] ??= now;

  /** The next step that can be shown, or null while the tour waits for the agent. */
  const nextIndex = useMemo(() => {
    for (let j = index + 1; j < beats.length; j++) {
      const b = beats[j]!;
      if (b.ready) {
        const skipped = j > index + 1;
        return !skipped || now - (firstReady.current[b.id] ?? now) > SKIP_GRACE_MS ? j : null;
      }
      if (!b.optional) return null;
    }
    return null;
  }, [beats, index, now]);

  /** How many steps the live systems are ahead of what is on screen. */
  const ahead = beats.filter((b, j) => j > index && b.ready).length;
  const waitingOn = nextIndex === null ? beats.slice(index + 1).find((b) => !b.optional) : null;

  const go = useCallback((to: number, record = true) => {
    setIndex((from) => {
      if (record && from !== to) history.current.push(from);
      return to;
    });
    setEnteredAt(Date.now());
  }, []);
  const next = useCallback(() => {
    if (nextIndex !== null) go(nextIndex);
  }, [go, nextIndex]);
  const back = useCallback(() => {
    const to = history.current.pop();
    if (to === undefined) return;
    setAuto(false);
    go(to, false);
  }, [go]);
  const catchUp = useCallback(() => {
    let last = -1;
    beats.forEach((b, j) => {
      if (b.ready) last = j;
    });
    if (last > index) go(last);
    setAuto(true);
  }, [beats, go, index]);

  // Auto-advance: hold each step for its dwell, and wait for the presenter where it says so.
  useEffect(() => {
    if (!tour || !auto || nextIndex === null) return;
    const held = (now - enteredAt) / 1000;
    if (beat.action) {
      const done = doneAt.current[beat.id];
      if (!done || now - done < 2_500) return;
    } else if (held < beat.dwell * PACES[pace]!.factor) return;
    go(nextIndex);
  }, [tour, auto, nextIndex, now, enteredAt, beat, go]);

  // Entering "A change ships" is what triggers the scenario.
  useEffect(() => {
    if (!tour || tour.triggeredAt !== null || beat.id !== 'change' || triggering.current) return;
    triggering.current = true;
    const at = Date.now();
    sim
      .trigger(scenario, { speed, force: true })
      .then(() => setTour((t) => (t ? { ...t, triggeredAt: at } : t)))
      .catch((err) => setError(`Could not trigger the scenario: ${errorText(err)}`))
      .finally(() => {
        triggering.current = false;
      });
  }, [tour, beat.id, scenario, speed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tour || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') next();
      else if (e.key === 'ArrowLeft') back();
      else if (e.key === ' ') {
        e.preventDefault();
        setAuto((a) => !a);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tour, next, back]);

  function begin(t: Tour, at: number) {
    history.current = [];
    firstReady.current = {};
    doneAt.current = {};
    setError(null);
    setIndex(at);
    setEnteredAt(Date.now());
    setAuto(true);
    setTour(t);
  }

  async function start() {
    setError(null);
    try {
      setBusy('Resetting the bank to a clean state…');
      await sim.reset();
      for (let i = 0; i < 80; i++) {
        const s = await sim.status();
        if (s.engine.phase === 'running' && s.systems.every((x) => x.api.ok)) break;
        await sleep(500);
      }
      begin({ readyAt: Date.now(), triggeredAt: null }, 0);
    } catch (err) {
      setError(`Could not reset the world: ${errorText(err)}`);
    } finally {
      setBusy(null);
    }
  }

  /** Follow a run that is already going (the page was reloaded, or it was started elsewhere). */
  function join() {
    if (!liveRun) return;
    begin({ readyAt: 0, triggeredAt: Date.parse(liveRun.started_at) - 1_000 }, 2);
  }

  // Events are revealed up to the moment of the next step, so the rail never runs ahead of the story.
  const cutoff = useMemo(() => {
    for (let j = index + 1; j < beats.length; j++) if (beats[j]!.ready) return readyMs(beats[j]!);
    return Number.POSITIVE_INFINITY;
  }, [beats, index, readyMs]);
  const events = useMemo(
    () => (view?.timeline ?? []).filter((e) => Date.parse(e.at) < cutoff),
    [view, cutoff],
  );

  const onsetIso = run?.fault_onset_at ?? view?.onset_at ?? view?.opened_at ?? null;
  const onsetMs = onsetIso ? Date.parse(onsetIso) : null;
  const milestones = view?.records?.milestones;
  const endIso =
    milestones?.['announce:recovered'] ?? milestones?.resolved ?? run?.recovered_at ?? null;
  const clock =
    onsetMs === null
      ? null
      : clockOffset(onsetMs, new Date(endIso ? Date.parse(endIso) : now).toISOString());

  if (!tour) {
    const engine = status.data?.engine.phase;
    const systemsOk = status.data?.systems.every((x) => x.api.ok && x.mcp.ok) ?? false;
    const worldOk = engine === 'running' && systemsOk;
    const agentOk = agent.status === 'live';
    return (
      <div className="demo-root demo-pre">
        <div className="demo-pre-card">
          <h1>Guided demo</h1>
          <p>
            Runs a real scenario and walks through what the incident agent does, one step at a time.
            It shows you where to look, and tells you when it is your turn to click.
          </p>

          <ul className="demo-checks">
            <li className={cn(worldOk && 'ok')}>
              <i />
              <span>
                <strong>Simulated bank</strong>
                {status.isError
                  ? 'Not running. Start it with pnpm dev'
                  : worldOk
                    ? 'Ready'
                    : 'Starting…'}
              </span>
            </li>
            <li className={cn(agentOk && 'ok')}>
              <i />
              <span>
                <strong>Incident agent</strong>
                {agentOk
                  ? `Ready · ${agent.info?.llm === 'off' ? 'no model' : MODEL_LABEL} · ${speed}× speed`
                  : agentHosted()
                    ? 'Starting… (the first start takes up to a minute)'
                    : 'Not running. Start it with pnpm demo'}
              </span>
            </li>
          </ul>

          <label className="demo-field">
            Scenario
            <NativeSelect value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {(scenarios.data ?? [{ id: DEFAULT_SCENARIO, title: DEFAULT_SCENARIO }]).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.title}
                </option>
              ))}
            </NativeSelect>
          </label>

          {error && <p className="demo-error">{error}</p>}

          <div className="demo-pre-actions">
            <Button size="lg" disabled={!worldOk || !agentOk || busy !== null} onClick={start}>
              {busy ? <Loader2 className="animate-spin" /> : <Play />}
              {busy ?? 'Start'}
            </Button>
            {liveRun?.active && agentOk && !busy && (
              <Button size="lg" variant="outline" onClick={join}>
                Join the run in progress
              </Button>
            )}
          </div>
          <p className="demo-hint">
            Starting resets the simulated bank. Use → for next, ← for back, space to pause.
          </p>
          <Link to="/" className="demo-hint">
            Back to the control panel
          </Link>
        </div>
      </div>
    );
  }

  const chapterAt = CHAPTERS.indexOf(beat.chapter);
  const dwell = beat.dwell * PACES[pace]!.factor;
  const progress =
    beat.action || !auto || nextIndex === null ? 0 : Math.min(1, (now - enteredAt) / 1000 / dwell);
  const needsYou = !!beat.action && !beat.action.done;
  const failed = view?.failure ?? (run?.phase === 'failed' ? run.error : null);
  // Background work the story has reached and that is still going in the live case.
  const live = new Set((view?.background ?? []).map((t) => t.name));
  const lanes = runningLanes(events).filter((l) => live.has(l.name));
  const status_line = needsYou
    ? null
    : lanes.length > 0
      ? `Meanwhile, the agent is ${lanes.map((l) => l.label).join(' and ')} (${Math.max(0, Math.round((now - lanes[0]!.startedMs) / 1000))}s)`
      : nextIndex === null && waitingOn
        ? tour.triggeredAt === null
          ? 'Letting the agent watch a quiet bank for a few seconds…'
          : 'The agent is working on the next step…'
        : null;

  return (
    <div className="demo-root">
      <header className="demo-top">
        <strong>Guided demo</strong>
        <ol>
          {CHAPTERS.map((c, i) => (
            <li key={c} className={cn(i < chapterAt && 'done', i === chapterAt && 'now')}>
              {c}
            </li>
          ))}
        </ol>
        {clock && (
          <span className="demo-clock" title="Time since the first error">
            {clock}
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => setTour(null)}>
          Restart
        </Button>
      </header>

      <Stage
        panes={beat.panes}
        preload
        native={(which) => <NativePane view={which} caseView={view} onsetMs={onsetMs} />}
      />

      <footer className={cn('demo-caption', needsYou && 'needs-you')}>
        <div className="demo-progress" style={{ width: `${progress * 100}%` }} />
        <div className="demo-caption-text" key={beat.id}>
          <h2>{beat.title}</h2>
          <p>{beat.say}</p>
          {failed && <p className="demo-error">The run hit a problem: {failed}</p>}
          {error && <p className="demo-error">{error}</p>}
          {status_line && (
            <p className="demo-meanwhile">
              <Loader2 className="size-3.5 animate-spin" />
              {status_line}
            </p>
          )}
        </div>
        <div className="demo-controls">
          {ahead > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={catchUp}
              title="Jump to what is happening now"
            >
              Skip to live
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            onClick={back}
            disabled={history.current.length === 0}
            title="Back (←)"
            aria-label="Back"
          >
            <ArrowLeft />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setAuto((a) => !a)}
            title={auto ? 'Pause (space)' : 'Play (space)'}
            aria-label={auto ? 'Pause' : 'Play'}
          >
            {auto ? <Pause /> : <Play />}
          </Button>
          <Button onClick={next} disabled={nextIndex === null} title="Next (→)">
            Next
            <ArrowRight />
          </Button>
        </div>
      </footer>
    </div>
  );
}

/**
 * The stage: the real system UIs in iframes, arranged for the current beat. Frames stay mounted
 * for the whole tour, so moving between beats is an in-page navigation (through the demo bridge
 * in @sim/ui), not a reload. Each frame renders at desktop width and is scaled to its pane.
 */
import { URLS } from '@sim/contracts';
import { cn, type DemoCommand, type DemoReport, SystemLogo } from '@sim/ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Pane, ScreenId } from './types';

const SCREENS: ScreenId[] = ['logs', 'alerts', 'servicenow', 'gitlab', 'teams'];

const SCREEN_META: Record<
  ScreenId,
  { name: string; logo: 'logs' | 'servicenow' | 'gitlab' | 'teams' }
> = {
  logs: { name: 'Cloud Logging', logo: 'logs' },
  alerts: { name: 'Moogsoft', logo: 'logs' },
  servicenow: { name: 'ServiceNow', logo: 'servicenow' },
  gitlab: { name: 'GitLab', logo: 'gitlab' },
  teams: { name: 'Teams', logo: 'teams' },
};

/** Where each screen sits before the story sends it anywhere. */
export function homeUrl(screen: ScreenId): string {
  switch (screen) {
    case 'logs':
      return `${URLS.logs.web}/logs?range=15m`;
    case 'alerts':
      return `${URLS.logs.web}/alerts?status=active`;
    case 'servicenow':
      return `${URLS.servicenow.web}/incidents`;
    case 'gitlab':
      return `${URLS.gitlab.web}/`;
    case 'teams':
      return `${URLS.teams.web}/`;
  }
}

/** Frames lay out at least this wide, then scale down to the stage. */
const MIN_LOGICAL = 1280;

interface Desired {
  seq: number;
  key: string;
  pane: Extract<Pane, { kind: 'frame' }> | null;
  goSent: number;
  clickSent: number;
  /** How long the page is shown untouched before its spotlight fades in (ms). */
  settle: number;
}

/** A page just arrived at is shown whole for a moment before anything is dimmed. */
const SETTLE_NEW_PAGE = 1_800;
const SETTLE_SAME_PAGE = 700;

export function Stage({
  panes,
  preload,
  native,
  present = false,
}: {
  /** What is on stage. One thing at a time: only the first pane is shown. */
  panes: Pane[];
  /** Mount every screen at its home page, so the first visit is instant. */
  preload: boolean;
  native: (view: Extract<Pane, { kind: 'native' }>['view']) => ReactNode;
  /** Presentation mode: a large "which app is this" strip, for recordings and projectors. */
  present?: boolean;
}) {
  const pane = panes[0] ?? null;
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Initial src per screen. Set once: later moves go through the bridge.
  const [src, setSrc] = useState<Partial<Record<ScreenId, string>>>({});
  const frames = useRef<Partial<Record<ScreenId, HTMLIFrameElement | null>>>({});
  const ready = useRef<Partial<Record<ScreenId, boolean>>>({});
  const desired = useRef<Partial<Record<ScreenId, Desired>>>({});
  const seq = useRef(0);

  const flush = useRef((screen: ScreenId) => {
    const want = desired.current[screen];
    const win = frames.current[screen]?.contentWindow;
    if (!want || !win || !ready.current[screen]) return;
    const post = (msg: DemoCommand) => win.postMessage(msg, '*');
    const pane = want.pane;
    if (!pane) {
      post({ simDemo: true, cmd: 'clear' });
      return;
    }
    if (want.goSent !== want.seq) {
      want.goSent = want.seq;
      post({ simDemo: true, cmd: 'go', url: pane.url });
    }
    if (pane.click && want.clickSent !== want.seq) {
      want.clickSent = want.seq;
      post({ simDemo: true, cmd: 'click', ...pane.click });
    }
    post({
      simDemo: true,
      cmd: 'spot',
      seq: want.seq,
      targets: pane.spots ?? [],
      dim: !pane.plain,
      mark: !pane.plain,
      settle: want.settle,
    });
  });

  // The bridge in each frame announces itself (and every navigation) to us.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const msg = e.data as DemoReport | undefined;
      if (msg?.simDemo !== true || msg.type !== 'ready') return;
      for (const screen of SCREENS) {
        if (frames.current[screen]?.contentWindow !== e.source) continue;
        ready.current[screen] = true;
        flush.current(screen);
      }
    };
    window.addEventListener('message', onMessage);
    // Spotlights are re-sent so a frame that reloaded (or rendered late) still gets them.
    const again = setInterval(() => {
      for (const s of SCREENS) flush.current(s);
    }, 1_000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(again);
    };
  }, []);

  useEffect(() => {
    if (!preload) return;
    setSrc((prev) => {
      const next = { ...prev };
      for (const s of SCREENS) next[s] ??= homeUrl(s);
      return next;
    });
  }, [preload]);

  const wanted = JSON.stringify(pane);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `wanted` is the pane, by value
  useEffect(() => {
    const onStage = new Map<ScreenId, Extract<Pane, { kind: 'frame' }>>();
    if (pane?.kind === 'frame') onStage.set(pane.screen, pane);
    setSrc((prev) => {
      let next = prev;
      for (const [screen, p] of onStage) if (!next[screen]) next = { ...next, [screen]: p.url };
      return next;
    });
    for (const screen of SCREENS) {
      const want = onStage.get(screen) ?? null;
      const key = JSON.stringify(want);
      const prev = desired.current[screen];
      if (prev?.key === key) continue;
      // A new spotlight on the same page keeps its place: only a new URL navigates.
      const sameUrl = !!want && prev?.pane?.url === want.url;
      const next = ++seq.current;
      desired.current[screen] = {
        seq: next,
        key,
        pane: want,
        goSent: sameUrl ? next : -1,
        clickSent: -1,
        settle: sameUrl ? SETTLE_SAME_PAGE : SETTLE_NEW_PAGE,
      };
      flush.current(screen);
    }
  }, [wanted]);

  const w = size.w;
  const h = size.h;
  const logical = Math.max(w, MIN_LOGICAL);
  const scale = w > 0 ? w / logical : 1;
  const meta = pane?.kind === 'frame' ? SCREEN_META[pane.screen] : null;

  return (
    <div className={cn('demo-stage', present && 'is-present')}>
      <header className="demo-stage-head" key={meta?.name ?? 'agent'}>
        {meta && pane?.kind === 'frame' ? (
          <>
            <SystemLogo system={meta.logo} className={present ? 'size-7' : 'size-4'} />
            <strong>{meta.name}</strong>
            {pane.what && <span>{pane.what}</span>}
          </>
        ) : (
          <>
            <i className="demo-mark" />
            <strong>Incident agent</strong>
          </>
        )}
      </header>
      <div ref={box} className="demo-stage-body">
        {SCREENS.map((screen) => {
          const url = src[screen];
          if (!url) return null;
          const on = pane?.kind === 'frame' && pane.screen === screen;
          return (
            <iframe
              key={screen}
              ref={(el) => {
                frames.current[screen] = el;
              }}
              title={SCREEN_META[screen].name}
              src={url}
              className={cn(!on && 'is-off')}
              aria-hidden={!on}
              tabIndex={on ? 0 : -1}
              style={{
                width: logical,
                height: scale > 0 ? h / scale : 0,
                transform: `scale(${scale})`,
              }}
            />
          );
        })}
        {pane?.kind === 'native' && (
          <div key={pane.view} className="demo-native">
            {native(pane.view)}
          </div>
        )}
      </div>
    </div>
  );
}

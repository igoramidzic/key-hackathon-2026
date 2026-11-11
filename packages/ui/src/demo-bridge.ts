/**
 * Guided-demo bridge. The control panel's `/demo` page embeds each system UI in an iframe and
 * tells it, over postMessage, where to go and what to point at. Inside the frame this module
 * navigates the router, dims and blurs the page, and cuts "spotlights" around the named elements.
 *
 * It does nothing unless the page is framed, and it only listens to its parent window.
 * The message shapes are shared with the director (`apps/control-panel/src/demo`).
 */

/** How to find an element. `sel` narrows by CSS, `text` by content, `closest` then walks up. */
export interface DemoTarget {
  sel?: string;
  /** Case-insensitive substring of the element's text (the whole text with `exact`). */
  text?: string;
  exact?: boolean;
  closest?: string;
  /** Which match to use (default the first). */
  nth?: number | 'last';
  /** Spotlight every match (up to 12) instead of one. */
  all?: boolean;
  /** Small callout attached to the spotlight. */
  label?: string;
  /** `click` draws the "press here" treatment. */
  tone?: 'look' | 'click';
  /** Extra pixels around the element (default 6). */
  pad?: number;
  /** Put the callout under the element instead of above it. */
  labelBelow?: boolean;
}

export type DemoCommand =
  | { simDemo: true; cmd: 'go'; url: string }
  | { simDemo: true; cmd: 'spot'; seq: number; targets: DemoTarget[]; dim?: boolean }
  | { simDemo: true; cmd: 'click'; target: DemoTarget; unless?: DemoTarget }
  | { simDemo: true; cmd: 'clear' };

export type DemoReport =
  | { simDemo: true; type: 'ready'; href: string }
  | { simDemo: true; type: 'spot'; seq: number; found: number };

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  below: boolean;
  tone: 'look' | 'click';
}

const MAX_MATCHES = 12;
const STYLE = `
.sim-demo-layer{position:fixed;inset:0;z-index:2147483000;pointer-events:none;font-family:"Geist Variable",ui-sans-serif,system-ui,sans-serif}
.sim-demo-dim{position:absolute;inset:0;background:rgb(24 24 27 / .42);backdrop-filter:blur(1.5px);-webkit-backdrop-filter:blur(1.5px);opacity:0;transition:opacity .4s ease}
.sim-demo-dim.on{opacity:1}
.sim-demo-ring{position:absolute;box-shadow:0 0 0 2px #fff,0 0 0 4px #18181b;animation:sim-demo-in .3s ease both;transition:left .2s ease,top .2s ease,width .2s ease,height .2s ease}
.sim-demo-ring.click{box-shadow:0 0 0 2px #fff,0 0 0 5px #15803d;animation:sim-demo-in .3s ease both,sim-demo-press 1.4s ease-in-out .3s infinite}
.sim-demo-tag{position:absolute;transform:translateY(-100%);margin-top:-12px;white-space:nowrap;background:#18181b;color:#fff;font-weight:500;font-size:13px;line-height:1;padding:7px 10px;animation:sim-demo-in .3s ease both}
.sim-demo-tag.below{transform:none;margin-top:12px}
.sim-demo-tag.click{background:#15803d;font-size:14px;font-weight:600;padding:8px 12px}
@keyframes sim-demo-in{from{opacity:0}to{opacity:1}}
@keyframes sim-demo-press{50%{box-shadow:0 0 0 2px #fff,0 0 0 5px #15803d,0 0 0 12px rgb(21 128 61 / .25)}}
@media (prefers-reduced-motion:reduce){.sim-demo-ring,.sim-demo-tag{animation:none}}
`;

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/** Elements matching a target, innermost text matches first. */
export function resolveTarget(t: DemoTarget, root: ParentNode = document): Element[] {
  let found: Element[];
  try {
    found = [...root.querySelectorAll(t.sel ?? '*')];
  } catch {
    return [];
  }
  if (t.text) {
    const want = norm(t.text);
    found = found.filter((el) => {
      const text = norm(el.textContent);
      return t.exact ? text === want : text.includes(want);
    });
    // Without a selector every ancestor matches too: keep the innermost elements.
    if (!t.sel) found = found.filter((el) => !found.some((o) => o !== el && el.contains(o)));
  }
  if (t.closest) {
    const up = found.map((el) => el.closest(t.closest!)).filter((el): el is Element => !!el);
    found = [...new Set(up)];
  }
  found = found.filter(visible);
  if (t.all) return found.slice(0, MAX_MATCHES);
  const pick = t.nth === 'last' ? found.at(-1) : found[t.nth ?? 0];
  return pick ? [pick] : [];
}

function samePlace(url: URL): boolean {
  if (url.pathname.replace(/\/+$/, '') !== location.pathname.replace(/\/+$/, '')) return false;
  const here = new URLSearchParams(location.search);
  for (const [k, v] of url.searchParams) if (here.get(k) !== v) return false;
  return url.hash === '' || url.hash === location.hash;
}

/** Idempotent. Call once per app; a no-op outside an iframe. */
export function installDemoBridge(): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  // One per page, even when hot reload evaluates this module again.
  const flagged = window as unknown as { __simDemoBridge?: boolean };
  if (flagged.__simDemoBridge) return;
  flagged.__simDemoBridge = true;

  const report = (msg: DemoReport) => window.parent.postMessage(msg, '*');

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);
  const layer = document.createElement('div');
  layer.className = 'sim-demo-layer';
  layer.setAttribute('aria-hidden', 'true');
  const dim = document.createElement('div');
  dim.className = 'sim-demo-dim';
  layer.appendChild(dim);
  document.documentElement.appendChild(layer);

  let targets: DemoTarget[] = [];
  let seq = 0;
  let wantDim = true;
  let userScrolled = false;
  let lastScroll = 0;
  let lastFound = -1;
  let lastKey = '';
  const marks: HTMLElement[] = [];
  let pendingClick: { target: DemoTarget; unless?: DemoTarget; until: number } | null = null;

  function measure(): Box[] {
    const boxes: Box[] = [];
    let first: Element | undefined;
    for (const t of targets) {
      for (const el of resolveTarget(t)) {
        first ??= el;
        const r = el.getBoundingClientRect();
        const pad = t.pad ?? 6;
        boxes.push({
          x: Math.round(r.left - pad),
          y: Math.round(r.top - pad),
          w: Math.round(r.width + pad * 2),
          h: Math.round(r.height + pad * 2),
          label: boxes.some((b) => b.label === t.label) ? undefined : t.label,
          below: !!t.labelBelow,
          tone: t.tone ?? 'look',
        });
      }
    }
    // Keep the first target in view while the page settles (content loads, the app resets its
    // own scroll), until the viewer scrolls for themselves.
    if (first instanceof HTMLElement && !userScrolled && Date.now() - lastScroll > 900) {
      const r = first.getBoundingClientRect();
      const H = window.innerHeight;
      const tall = r.height > H - 180;
      const out = tall ? r.top < 40 || r.top > H * 0.5 : r.top < 80 || r.bottom > H - 30;
      if (out) {
        lastScroll = Date.now();
        first.style.scrollMarginTop = '120px';
        first.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'smooth' });
      }
    }
    return boxes;
  }

  function draw(boxes: Box[]): void {
    const key = JSON.stringify(boxes) + wantDim;
    if (key === lastKey) return;
    lastKey = key;
    const W = window.innerWidth;
    const H = window.innerHeight;
    const holes = boxes.map((b) => `M${b.x} ${b.y}h${b.w}v${b.h}h${-b.w}Z`).join(' ');
    dim.style.clipPath = `path(evenodd,"M0 0H${W}V${H}H0Z ${holes}")`;
    dim.classList.toggle('on', wantDim && boxes.length > 0);
    // Rings are reused by index so they glide when the element moves.
    while (marks.length > boxes.length * 2) marks.pop()!.remove();
    boxes.forEach((b, i) => {
      let ring = marks[i * 2];
      let tag = marks[i * 2 + 1];
      if (!ring || !tag) {
        ring = document.createElement('div');
        tag = document.createElement('div');
        layer.append(ring, tag);
        marks[i * 2] = ring;
        marks[i * 2 + 1] = tag;
      }
      ring.className = `sim-demo-ring ${b.tone}`;
      Object.assign(ring.style, {
        left: `${b.x}px`,
        top: `${b.y}px`,
        width: `${b.w}px`,
        height: `${b.h}px`,
      });
      const below = b.below || b.y < 48;
      tag.className = `sim-demo-tag ${b.tone}${below ? ' below' : ''}`;
      tag.textContent = b.label ?? '';
      tag.style.display = b.label ? '' : 'none';
      tag.style.left = `${Math.max(8, Math.min(b.x, W - 260))}px`;
      tag.style.top = `${below ? b.y + b.h : b.y}px`;
    });
  }

  function tick(): void {
    if (pendingClick) {
      const { target, unless, until } = pendingClick;
      if (unless && resolveTarget(unless).length > 0) pendingClick = null;
      else {
        const el = resolveTarget(target)[0];
        if (el instanceof HTMLElement) {
          el.click();
          pendingClick = null;
        } else if (Date.now() > until) pendingClick = null;
      }
    }
    const boxes = targets.length ? measure() : [];
    draw(boxes);
    if (targets.length && boxes.length !== lastFound) {
      lastFound = boxes.length;
      report({ simDemo: true, type: 'spot', seq, found: boxes.length });
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return;
    const msg = e.data as DemoCommand | undefined;
    if (msg?.simDemo !== true) return;
    if (msg.cmd === 'go') {
      let url: URL;
      try {
        url = new URL(msg.url, location.href);
      } catch {
        return;
      }
      if (url.origin !== location.origin) return;
      if (samePlace(url)) return;
      history.pushState(null, '', url.pathname + url.search + url.hash);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      window.scrollTo(0, 0);
    } else if (msg.cmd === 'spot') {
      // The director repeats the current spotlight; only a new one scrolls and reports again.
      if (msg.seq !== seq) {
        userScrolled = false;
        lastFound = -1;
      }
      targets = msg.targets;
      seq = msg.seq;
      wantDim = msg.dim !== false;
    } else if (msg.cmd === 'click') {
      pendingClick = { target: msg.target, unless: msg.unless, until: Date.now() + 6_000 };
    } else if (msg.cmd === 'clear') {
      targets = [];
      lastFound = -1;
    }
  });

  for (const type of ['wheel', 'touchmove', 'keydown'] as const)
    window.addEventListener(
      type,
      () => {
        userScrolled = true;
      },
      { passive: true },
    );

  let href = '';
  const announce = () => {
    if (location.href === href) return;
    href = location.href;
    report({ simDemo: true, type: 'ready', href });
  };
  announce();
  setInterval(announce, 400);
}

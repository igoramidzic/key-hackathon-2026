import type { LogHistogram, Severity } from '@sim/contracts/logs';
import { SEVERITIES } from '@sim/contracts/logs';
import { useEffect, useRef, useState } from 'react';
import { formatCount, SEVERITY_STYLE, SeveritySwatch } from '../lib';

/** Stack order: most severe at the bottom so error spikes stand out. */
const STACK: Severity[] = [...SEVERITIES].reverse();

const HEIGHT = 104;
const AXIS = 18;
const LEFT = 36;

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function timeLabel(iso: string, bucketSeconds: number): string {
  const d = new Date(iso);
  const opts: Intl.DateTimeFormatOptions =
    bucketSeconds >= 3600
      ? { month: 'short', day: 'numeric', hour: 'numeric' }
      : {
          hour: 'numeric',
          minute: '2-digit',
          ...(bucketSeconds < 60 ? { second: '2-digit' } : {}),
        };
  return d.toLocaleString(undefined, opts);
}

/** Stacked severity histogram (SVG) with hover details. */
export function Histogram({ data, loading }: { data?: LogHistogram; loading?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const buckets = data?.buckets ?? [];
  const max = Math.max(1, ...buckets.map((b) => b.total));
  const plotW = Math.max(0, width - LEFT);
  const bw = buckets.length ? plotW / buckets.length : 0;
  const plotH = HEIGHT - AXIS;
  const y = (n: number) => (n / max) * (plotH - 6);
  const tickEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 110))));
  const hovered = hover !== null ? buckets[hover] : undefined;
  const present = STACK.filter((s) => buckets.some((b) => b.counts[s]));

  return (
    <div className="relative">
      <div className="mb-2 flex items-center justify-between gap-4 text-[12px] text-muted-foreground">
        <span>
          {data ? (
            <>
              <span className="font-medium text-foreground tabular-nums">
                {formatCount(data.total)}
              </span>{' '}
              entries ·{' '}
              {data.bucket_seconds >= 60
                ? `${data.bucket_seconds / 60}m`
                : `${data.bucket_seconds}s`}{' '}
              buckets
            </>
          ) : loading ? (
            'Loading histogram…'
          ) : (
            ' '
          )}
        </span>
        <span className="flex flex-wrap items-center gap-3">
          {[...present].reverse().map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <SeveritySwatch severity={s} />
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </span>
          ))}
        </span>
      </div>
      <div ref={ref} className="relative" style={{ height: HEIGHT }}>
        {width > 0 && data && (
          <svg width={width} height={HEIGHT} className="block" onMouseLeave={() => setHover(null)}>
            {(max >= 4 ? [0, Math.round(max / 2), max] : [0, max]).map((v) => {
              const yy = plotH - y(v);
              return (
                <g key={v}>
                  <line
                    x1={LEFT}
                    x2={width}
                    y1={yy}
                    y2={yy}
                    stroke={v ? '#e8eaed' : 'var(--border)'}
                  />
                  {Boolean(data?.total) && (
                    <text
                      x={LEFT - 6}
                      y={yy + 3}
                      textAnchor="end"
                      className="fill-muted-foreground text-[11px]"
                    >
                      {v}
                    </text>
                  )}
                </g>
              );
            })}
            {data && data.total === 0 && (
              <text
                x={LEFT + plotW / 2}
                y={plotH / 2}
                textAnchor="middle"
                className="fill-muted-foreground text-xs"
              >
                No entries in this time range
              </text>
            )}
            {buckets.map((b, i) => {
              const x = LEFT + i * bw;
              let acc = 0;
              return (
                <g key={b.start} onMouseEnter={() => setHover(i)}>
                  <rect
                    x={x}
                    y={0}
                    width={bw}
                    height={plotH}
                    fill={hover === i ? '#e8eaed' : 'transparent'}
                  />
                  {STACK.map((s) => {
                    const n = b.counts[s];
                    if (!n) return null;
                    const h = Math.max(1, y(n));
                    acc += h;
                    return (
                      <rect
                        key={s}
                        x={x + Math.min(1, bw * 0.15)}
                        y={plotH - acc}
                        width={Math.max(1, bw - Math.min(2, bw * 0.3))}
                        height={h}
                        fill={SEVERITY_STYLE[s].fill}
                        fillOpacity={SEVERITY_STYLE[s].opacity}
                      />
                    );
                  })}
                  {i % tickEvery === 0 && x + 64 < width && (
                    <text x={x} y={HEIGHT - 4} className="fill-muted-foreground text-[11px]">
                      {timeLabel(b.start, data?.bucket_seconds ?? 60)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        {hovered && hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-48 rounded-[4px] bg-popover px-3 py-2 text-[12px] text-popover-foreground shadow-[0_1px_2px_rgba(60,64,67,0.3),0_2px_6px_2px_rgba(60,64,67,0.15)]"
            style={
              LEFT + hover * bw > width / 2
                ? { right: width - (LEFT + hover * bw) + 8 }
                : { left: LEFT + (hover + 1) * bw + 8 }
            }
          >
            <div className="mb-1 font-medium">
              {new Date(hovered.start).toLocaleString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
              })}
            </div>
            {hovered.total === 0 ? (
              <div className="text-muted-foreground">No entries</div>
            ) : (
              [...STACK].reverse().map((s) =>
                hovered.counts[s] ? (
                  <div
                    key={s}
                    className="flex items-center justify-between gap-4 text-muted-foreground"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <SeveritySwatch severity={s} />
                      {s}
                    </span>
                    <span className="text-foreground tabular-nums">
                      {formatCount(hovered.counts[s] ?? 0)}
                    </span>
                  </div>
                ) : null,
              )
            )}
          </div>
        )}
      </div>
    </div>
  );
}

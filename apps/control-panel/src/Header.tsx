import type { SimulatorStatus } from '@sim/contracts/simulator';
import { Button, cn, StatusDot, type Tone } from '@sim/ui';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RotateCcw } from 'lucide-react';
import { ConfirmButton, errorText, sim } from './lib';

/** Right side of the app header: live traffic readout with pause, and Reset. */
export function HeaderActions({
  status,
  offline,
}: {
  status: SimulatorStatus | undefined;
  offline: boolean;
}) {
  const qc = useQueryClient();
  const reset = useMutation({
    mutationFn: sim.reset,
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });
  const traffic = useMutation({
    mutationFn: (paused: boolean) => sim.setTraffic({ paused }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['status'] }),
  });
  const t = status?.traffic;
  const running = status?.engine.phase === 'running';
  const resetting = reset.isPending || status?.engine.phase === 'resetting';
  const unhealthy = (t?.buffered ?? 0) > 200;
  const live = running && !t?.paused && !offline;
  const tone: Tone = offline
    ? 'negative'
    : t?.paused || !running || unhealthy
      ? 'warning'
      : 'positive';

  return (
    <>
      {reset.isError && (
        <span className="hidden text-negative text-xs sm:inline">{errorText(reset.error)}</span>
      )}
      {reset.isSuccess && !resetting && (
        <span className="hidden text-muted-foreground text-xs sm:inline">
          Reset in {(reset.data.duration_ms / 1000).toFixed(1)}s
        </span>
      )}
      <div
        className="flex h-7 items-center gap-2 border bg-card pr-0.5 pl-2.5 text-xs"
        title={t ? `${t.total_lines.toLocaleString('en-US')} lines ingested` : undefined}
      >
        <span className="relative flex size-2">
          {live && (
            <StatusDot
              tone={tone}
              className="absolute inset-0 animate-ping opacity-60 motion-reduce:hidden"
            />
          )}
          <StatusDot tone={tone} className="relative" />
        </span>
        <span
          className={cn(
            'hidden whitespace-nowrap font-medium tabular-nums sm:inline',
            !live && 'text-muted-foreground',
          )}
        >
          {offline
            ? 'Simulator offline'
            : !running
              ? (status?.engine.phase.replace(/_/g, ' ') ?? 'connecting')
              : t?.paused
                ? 'Traffic paused'
                : `${(t?.lines_per_sec ?? 0).toFixed(1)} lines/s`}
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          title={t?.paused ? 'Resume baseline traffic' : 'Pause baseline traffic'}
          aria-label={t?.paused ? 'Resume baseline traffic' : 'Pause baseline traffic'}
          disabled={!running || traffic.isPending}
          onClick={() => traffic.mutate(!t?.paused)}
        >
          {t?.paused ? <Play /> : <Pause />}
        </Button>
      </div>
      <ConfirmButton
        label={resetting ? 'Resetting' : 'Reset'}
        confirmLabel="Reset everything"
        prompt="Reset all four systems?"
        icon={<RotateCcw />}
        loading={resetting}
        disabled={!running && !resetting}
        onConfirm={() => reset.mutate()}
      />
    </>
  );
}

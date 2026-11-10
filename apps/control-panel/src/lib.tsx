import { createSimulatorClient, type RunPhase, type ScenarioKind } from '@sim/contracts/simulator';
import { Button, cn, navLinkClass, StatusBadge, type Tone } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { type ComponentProps, type ReactNode, useEffect, useState } from 'react';
import { NavLink } from 'react-router';

/**
 * Path prefix the UI is served under: '' at the root (base '/'), or the prefix passed to
 * `vite build --base`. The simulator API sits under the same prefix.
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Same-origin client under BASE_PATH; Vite proxies /api to the simulator engine. */
export const sim = createSimulatorClient(BASE_PATH);

export function useStatus() {
  return useQuery({
    queryKey: ['status'],
    queryFn: sim.status,
    refetchInterval: 1500,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export function useScenarios() {
  return useQuery({ queryKey: ['scenarios'], queryFn: sim.listScenarios, staleTime: 30_000 });
}

export function useScenarioDetail(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['scenario', id],
    queryFn: () => sim.getScenario(id),
    enabled,
    staleTime: 60_000,
  });
}

/** Re-renders every `ms` while `active`. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const KIND_LABEL: Record<ScenarioKind, string> = {
  cascade: 'Cascade',
  'single-app': 'Single app',
  helpdesk: 'Help desk',
};

export const PHASE: Record<RunPhase, { label: string; tone: Tone }> = {
  pending: { label: 'Rolling out', tone: 'warning' },
  degrading: { label: 'Degrading', tone: 'negative' },
  recovering: { label: 'Recovering', tone: 'info' },
  recovered: { label: 'Recovered', tone: 'positive' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'negative' },
};

export function PhaseBadge({ phase }: { phase: RunPhase }) {
  const p = PHASE[phase];
  return (
    <StatusBadge tone={p.tone} dot>
      {p.label}
    </StatusBadge>
  );
}

/** Spinner in place of a button's leading icon while it works. */
export function ButtonIcon({ loading, icon }: { loading?: boolean; icon?: ReactNode }) {
  if (loading) return <Loader2 className="animate-spin" data-icon="inline-start" />;
  return icon ?? null;
}

type ButtonProps = ComponentProps<typeof Button>;

/** Two-step button: first click asks, second click runs `onConfirm`. */
export function ConfirmButton({
  label,
  confirmLabel,
  prompt,
  onConfirm,
  loading,
  disabled,
  variant = 'outline',
  size = 'sm',
  icon,
}: {
  label: string;
  confirmLabel: string;
  prompt: string;
  onConfirm: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  icon?: ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const id = setTimeout(() => setAsking(false), 6000);
    return () => clearTimeout(id);
  }, [asking]);
  if (asking) {
    return (
      <span className="inline-flex items-center gap-2">
        <span className="text-muted-foreground text-xs">{prompt}</span>
        <Button size={size} variant="ghost" onClick={() => setAsking(false)}>
          Cancel
        </Button>
        <Button
          size={size}
          variant="destructive"
          onClick={() => {
            setAsking(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
      </span>
    );
  }
  return (
    <Button
      size={size}
      variant={variant}
      disabled={disabled || loading}
      onClick={() => setAsking(true)}
    >
      <ButtonIcon loading={loading} icon={icon} />
      {label}
    </Button>
  );
}

/** Header nav shared by the control panel and the agent docs. */
export function TopNav() {
  const item = ({ isActive }: { isActive: boolean }) =>
    cn('flex h-8 items-center border border-transparent px-2.5 text-sm', navLinkClass(isActive));
  return (
    <>
      <NavLink end to="/" className={item}>
        Control panel
      </NavLink>
      <NavLink to="/docs" className={item}>
        Agent docs
      </NavLink>
    </>
  );
}

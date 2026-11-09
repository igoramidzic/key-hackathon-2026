import type { ChannelSummary, Team } from '@sim/contracts/teams';
import { cn } from '@sim/ui';
import { ChevronDown, ChevronRight, Lock, Siren } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useMatch } from 'react-router';
import { useAllChannels, useTeams } from './api';
import { TeamAvatar } from './people';
import { useViewer } from './viewer';

const INCIDENT_TEAM = 'incident-response';
const TEAM_ORDER = [INCIDENT_TEAM, 'enterprise-command-center', 'it-service-desk'];
const NEW_FOR_MS = 2 * 3_600_000;

/** Incident channels newest first, then General, then the rest by name. */
function orderChannels(teamId: string, channels: ChannelSummary[]): ChannelSummary[] {
  const incidents = channels
    .filter((c) => c.incident_number)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const general = channels.filter((c) => c.name === 'general');
  const rest = channels
    .filter((c) => !c.incident_number && c.name !== 'general')
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  return teamId === INCIDENT_TEAM
    ? [...incidents, ...general, ...rest]
    : [...general, ...incidents, ...rest];
}

function orderTeams(teams: Team[]): Team[] {
  const rank = (t: Team) => {
    const i = TEAM_ORDER.indexOf(t.id);
    return i === -1 ? TEAM_ORDER.length : i;
  };
  return [...teams].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const EXPANDED_KEY = 'teams.expanded';

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch {
    // ignore
  }
  return new Set([INCIDENT_TEAM, 'enterprise-command-center']);
}

export function TeamsPane() {
  const teams = useTeams();
  const channels = useAllChannels();
  const { link } = useViewer();
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);

  // The route accepts ids or names (agents may paste either); highlight by the resolved channel.
  const param = useMatch('/channels/:id')?.params.id;
  const active = param
    ? channels.data?.items.find((c) => c.id === param || c.name === param)
    : undefined;
  const activeChannelId = active?.id;
  const activeTeam = active?.team_id;

  const byTeam = useMemo(() => {
    const map = new Map<string, ChannelSummary[]>();
    for (const c of channels.data?.items ?? []) {
      map.set(c.team_id, [...(map.get(c.team_id) ?? []), c]);
    }
    return map;
  }, [channels.data]);

  useEffect(() => {
    if (activeTeam && !expanded.has(activeTeam)) {
      setExpanded((prev) => new Set([...prev, activeTeam]));
    }
  }, [activeTeam, expanded]);

  useEffect(() => {
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
    } catch {
      // ignore
    }
  }, [expanded]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const now = Date.now();
  const teamList = orderTeams(teams.data?.items ?? []);

  return (
    <div className="flex flex-col pb-3">
      <div className="flex h-14 shrink-0 items-center justify-between px-4">
        <h2 className="font-semibold text-[18px] leading-none">Teams</h2>
        {teams.data && (
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {teamList.length} team{teamList.length === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="px-4 pb-1 font-semibold text-[12px] text-muted-foreground">Your teams</div>
      <div className="px-2">
        {teamList.map((team) => {
          const open = expanded.has(team.id);
          const list = orderChannels(team.id, byTeam.get(team.id) ?? []);
          const liveIncidents = list.filter(
            (c) => c.incident_number && now - new Date(c.created_at).getTime() < NEW_FOR_MS,
          ).length;
          return (
            <div key={team.id} className="mb-1">
              <button
                type="button"
                onClick={() => toggle(team.id)}
                aria-expanded={open}
                className="group flex h-10 w-full items-center gap-2 rounded-[4px] px-1.5 text-left outline-none hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                title={team.description}
              >
                {open ? (
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <TeamAvatar name={team.name} />
                <span className="min-w-0 flex-1 truncate font-semibold text-[14px]">
                  {team.name}
                </span>
                {!open && liveIncidents > 0 && (
                  <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-negative px-1 font-semibold text-[10px] text-white tabular-nums">
                    {liveIncidents}
                  </span>
                )}
              </button>
              {open && (
                <div className="grid grid-cols-[minmax(0,1fr)] gap-px">
                  {list.map((c) => {
                    const isActive = c.id === activeChannelId;
                    const isNew =
                      c.incident_number && now - new Date(c.created_at).getTime() < NEW_FOR_MS;
                    return (
                      <Link
                        key={c.id}
                        to={link(`/channels/${c.id}`)}
                        title={c.description || c.name}
                        aria-current={isActive ? 'page' : undefined}
                        className={cn(
                          'flex h-8 items-center gap-2 rounded-[4px] pr-2 pl-[62px] text-[14px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                          isActive
                            ? 'bg-brand-tint font-semibold text-foreground'
                            : 'text-foreground/85 hover:bg-black/[0.04]',
                        )}
                      >
                        {c.incident_number && (
                          <Siren
                            className={cn(
                              'size-3.5 shrink-0',
                              isNew ? 'text-negative' : 'text-muted-foreground',
                            )}
                          />
                        )}
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            isNew && 'font-semibold text-foreground',
                          )}
                        >
                          {c.display_name}
                        </span>
                        {c.type === 'private' && (
                          <Lock className="size-3 shrink-0 text-muted-foreground" />
                        )}
                        {isNew && (
                          <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-negative px-1.5 font-semibold text-[10px] text-white">
                            New
                          </span>
                        )}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

import { EmptyState, RelativeTime, Spinner } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Siren, Users } from 'lucide-react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router';
import { ActivityPage } from './ActivityPage';
import { api, useAllChannels } from './api';
import { ChannelPage } from './ChannelPage';
import { TeamAvatar } from './people';
import { Shell } from './Shell';
import { TeamsPane } from './TeamsPane';
import { useViewer } from './viewer';

export function App() {
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<TeamsHome />} />
        <Route path="/teams/:teamId" element={<TeamRedirect />} />
        <Route path="/channels/:id" element={<ChannelRoute />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function ChannelRoute() {
  const { id } = useParams();
  return <ChannelPage key={id} id={id!} />;
}

function TeamRedirect() {
  const { teamId } = useParams();
  const { link } = useViewer();
  const team = useQuery({ queryKey: ['team', teamId], queryFn: () => api.getTeam(teamId!) });
  if (team.data?.channels[0]) {
    return <Navigate to={link(`/channels/${team.data.channels[0].id}`)} replace />;
  }
  if (team.error) return <Navigate to={link('/')} replace />;
  return <Spinner />;
}

function TeamsHome() {
  const channels = useAllChannels();
  const { link } = useViewer();
  const incidents = (channels.data?.items ?? [])
    .filter((c) => c.incident_number)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-[60px] shrink-0 items-center gap-3 border-b bg-card px-4 md:px-5">
        <span className="flex size-8 items-center justify-center rounded-[4px] bg-negative/10 text-negative">
          <Siren className="size-4" />
        </span>
        <div className="min-w-0">
          <h1 className="font-semibold text-[18px] leading-tight">Incident channels</h1>
          <div className="truncate text-[12px] text-muted-foreground">
            Created by Incident Automation and the NOC in the Incident Response team. Pick one, or
            any team channel on the left.
          </div>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-6">
        <div className="mx-auto max-w-[1040px]">
          <div className="mb-2 flex items-baseline gap-2">
            <h2 className="font-semibold text-[14px]">Most recent</h2>
            <span className="text-[12px] text-muted-foreground">
              The latest {incidents.length || ''} incident channels
            </span>
          </div>
          {!channels.data ? (
            <Spinner />
          ) : incidents.length === 0 ? (
            <div className="rounded-[6px] bg-card shadow-fluent-2">
              <EmptyState
                icon={<Siren />}
                title="No incident channels yet"
                description="Trigger a scenario and Incident Automation creates one here."
              />
            </div>
          ) : (
            <div className="grid gap-2">
              {incidents.map((c) => (
                <Link
                  key={c.id}
                  to={link(`/channels/${c.id}`)}
                  className="group flex items-center gap-3 rounded-[6px] bg-card px-4 py-3 shadow-fluent-2 outline-none transition-shadow hover:shadow-fluent-8 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TeamAvatar name={c.team_name} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-semibold text-[14px] group-hover:text-primary">
                        {c.display_name}
                      </span>
                      {c.incident_number && (
                        <span className="inline-flex h-4 shrink-0 items-center rounded-full bg-negative/10 px-1.5 font-semibold text-[10.5px] text-negative">
                          {c.incident_number}
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-[13px] text-muted-foreground">
                      {c.team_name} · {c.description}
                    </span>
                  </span>
                  <span className="hidden shrink-0 items-center gap-1 text-[12px] text-muted-foreground tabular-nums sm:flex">
                    <Users className="size-3.5" /> {c.member_count}
                  </span>
                  <RelativeTime
                    value={c.last_activity_at}
                    className="w-20 shrink-0 text-right text-[12px] text-muted-foreground tabular-nums"
                  />
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                </Link>
              ))}
            </div>
          )}
          {/* The list pane is hidden on phones, so the team list sits under the incidents. */}
          <div className="mt-4 overflow-hidden rounded-[6px] bg-pane shadow-fluent-2 md:hidden">
            <TeamsPane />
          </div>
        </div>
      </div>
    </div>
  );
}

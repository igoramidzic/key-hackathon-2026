import { EmptyState, Spinner } from '@sim/ui';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router';
import { codeChip, Loadable, PageTitle } from '../components/common';
import { DiffView } from '../components/DiffView';
import { CommitList } from '../components/lists';
import { api, mrHref } from '../lib/api';
import { useProjectPath } from '../lib/project';

/** Pipeline links resolve to the merge request that owns the pipeline. */
export function PipelinePage() {
  const { path } = useProjectPath();
  const id = Number(useParams().id);
  const mrs = useQuery({
    queryKey: ['mrs', path, 'pipeline-lookup'],
    queryFn: () => api.listProjectMergeRequests(path, { state: 'all', limit: 500 }),
  });
  if (mrs.isPending) return <Spinner />;
  const mr = mrs.data?.items.find((m) => m.pipeline.id === id);
  if (mr) return <Navigate to={mrHref(path, mr.iid)} replace />;
  return <EmptyState title={`Pipeline #${id} not found`} />;
}

/** `/-/compare/<from>...<to>` */
export function ComparePage() {
  const { path } = useProjectPath();
  const spec = decodeURIComponent(useParams()['*'] ?? '');
  const [from = '', to = 'main'] = spec.split('...');
  const cmp = useQuery({
    queryKey: ['compare', path, from, to],
    queryFn: () => api.compare(path, from, to),
  });
  return (
    <div className="grid gap-5">
      <PageTitle>
        <span className="inline-flex items-center gap-2">
          Compare <code className={`${codeChip} text-sm`}>{from.slice(0, 12)}</code>
          <span className="text-muted-foreground">…</span>
          <code className={`${codeChip} text-sm`}>{to.slice(0, 12)}</code>
        </span>
      </PageTitle>
      <Loadable query={cmp}>
        {(c) => (
          <>
            <CommitList commits={c.commits} />
            <DiffView diffs={c.diffs} projectPath={path} viewRef={to} />
          </>
        )}
      </Loadable>
    </div>
  );
}

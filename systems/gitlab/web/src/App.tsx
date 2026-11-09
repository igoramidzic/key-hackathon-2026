import { Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { GroupPage, RootGroupPage } from './pages/GroupPages';
import { HomePage } from './pages/HomePage';
import { ComparePage, PipelinePage } from './pages/MiscPages';
import { DashboardMrsPage, MrPage, ProjectMrsPage } from './pages/MrPages';
import {
  BlobPage,
  BranchesPage,
  CommitPage,
  CommitsPage,
  ProjectPage,
  TagsPage,
  TreePage,
} from './pages/ProjectPages';
import { NotFoundPage, UserPage } from './pages/UserPage';

const P = 'keybank/:group/:project';

/** URLs mirror gitlab.com: /keybank/PAY00/payments-api/-/merge_requests/12 */
export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<HomePage />} />
        <Route path="dashboard/merge_requests" element={<DashboardMrsPage />} />
        <Route path="keybank" element={<RootGroupPage />} />
        <Route path="keybank/:group" element={<GroupPage />} />
        <Route path={P} element={<ProjectPage />} />
        <Route path={`${P}/-/tree/*`} element={<TreePage />} />
        <Route path={`${P}/-/blob/*`} element={<BlobPage />} />
        <Route path={`${P}/-/commits/*`} element={<CommitsPage />} />
        <Route path={`${P}/-/commit/:sha`} element={<CommitPage />} />
        <Route path={`${P}/-/merge_requests`} element={<ProjectMrsPage />} />
        <Route path={`${P}/-/merge_requests/:iid/*`} element={<MrPage />} />
        <Route path={`${P}/-/branches`} element={<BranchesPage />} />
        <Route path={`${P}/-/tags`} element={<TagsPage />} />
        <Route path={`${P}/-/tags/:tag`} element={<TagsPage />} />
        <Route path={`${P}/-/pipelines/:id`} element={<PipelinePage />} />
        <Route path={`${P}/-/compare/*`} element={<ComparePage />} />
        <Route path=":username" element={<UserPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

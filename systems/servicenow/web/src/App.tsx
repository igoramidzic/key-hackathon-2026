import { EmptyState } from '@sim/ui';
import { Navigate, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { AppDetail, AppList } from './pages/Apps';
import { ChangeCreate, ChangeDetail, ChangeList } from './pages/Changes';
import { GroupDetail, GroupList } from './pages/Groups';
import { IncidentCreate } from './pages/IncidentCreate';
import { IncidentDetail } from './pages/IncidentDetail';
import { IncidentList } from './pages/IncidentList';
import { SearchPage } from './pages/Search';
import { UserDetail, UserList } from './pages/Users';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Navigate to="/incidents" replace />} />
        <Route path="/incidents" element={<IncidentList />} />
        <Route path="/incidents/new" element={<IncidentCreate />} />
        <Route path="/incidents/:number" element={<IncidentDetail />} />
        <Route path="/change_requests" element={<ChangeList />} />
        <Route path="/change_requests/new" element={<ChangeCreate />} />
        <Route path="/change_requests/:number" element={<ChangeDetail />} />
        <Route path="/apps" element={<AppList />} />
        <Route path="/apps/:tla" element={<AppDetail />} />
        <Route path="/groups" element={<GroupList />} />
        <Route path="/groups/:id" element={<GroupDetail />} />
        <Route path="/users" element={<UserList />} />
        <Route path="/users/:username" element={<UserDetail />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<EmptyState title="Page not found" />} />
      </Routes>
    </Layout>
  );
}

import { TooltipProvider } from '@sim/ui';
import { Navigate, Route, Routes } from 'react-router';
import { GcpShell } from './chrome/GcpShell';
import { MoogsoftShell } from './chrome/MoogsoftShell';
import { AlertDetail } from './pages/AlertDetail';
import { AlertsPage } from './pages/Alerts';
import { LogsExplorer } from './pages/LogsExplorer';

/**
 * Two products in one app: the Logs Explorer wears the Google Cloud console's chrome, the alert
 * console Moogsoft's. Each layout route scopes its own theme tokens.
 */
export function App() {
  return (
    <TooltipProvider delayDuration={400}>
      <Routes>
        <Route path="/" element={<Navigate to="/logs" replace />} />
        <Route element={<GcpShell />}>
          <Route path="/logs" element={<LogsExplorer />} />
        </Route>
        <Route element={<MoogsoftShell />}>
          <Route path="/alerts" element={<AlertsPage />} />
          <Route path="/alerts/:id" element={<AlertDetail />} />
        </Route>
        <Route path="*" element={<Navigate to="/logs" replace />} />
      </Routes>
    </TooltipProvider>
  );
}

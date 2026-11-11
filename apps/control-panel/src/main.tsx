import { QueryProvider } from '@sim/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import { App } from './App';
import { DemoPage } from './demo/DemoPage';
import { DocsPage } from './docs/Docs';
import { BASE_PATH } from './lib';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <BrowserRouter basename={BASE_PATH || '/'}>
        <Routes>
          <Route path="/docs/*" element={<DocsPage />} />
          <Route path="/demo" element={<DemoPage />} />
          <Route path="*" element={<App />} />
        </Routes>
      </BrowserRouter>
    </QueryProvider>
  </StrictMode>,
);

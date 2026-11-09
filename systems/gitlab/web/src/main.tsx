import { QueryProvider } from '@sim/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { BASE_PATH } from './lib/api';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <BrowserRouter basename={BASE_PATH || '/'}>
        <App />
      </BrowserRouter>
    </QueryProvider>
  </StrictMode>,
);

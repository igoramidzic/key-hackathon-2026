import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { installDemoBridge } from './demo-bridge';

/** TanStack Query provider with demo-friendly defaults (short stale time, no retry storms). */
export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 2_000, retry: 1, refetchOnWindowFocus: true },
        },
      }),
  );
  // Every UI mounts this provider, so the guided demo can drive any of them when framed.
  useEffect(installDemoBridge, []);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

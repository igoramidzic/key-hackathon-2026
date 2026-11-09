import { useCallback, useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

export const DEFAULT_VIEWER = 'dwhitfield';
const STORAGE_KEY = 'teams.viewer';

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * The person the UI is "viewing as". Lives in `?user=` (so links are shareable) with the last
 * choice remembered locally for bare URLs such as an agent's channel web_url.
 */
export function useViewer() {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const fromUrl = params.get('user');
  const username = fromUrl || stored() || DEFAULT_VIEWER;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, username);
    } catch {
      // ignore
    }
    if (!fromUrl) {
      const next = new URLSearchParams(location.search);
      next.set('user', username);
      navigate(
        { pathname: location.pathname, search: `?${next}`, hash: location.hash },
        { replace: true },
      );
    }
  }, [fromUrl, username, location.pathname, location.search, location.hash, navigate]);

  /** Appends `?user=` to an internal path (keeps any hash). */
  const link = useCallback(
    (path: string) => {
      const [base, hash] = path.split('#');
      const [pathname, query] = base!.split('?');
      const search = new URLSearchParams(query);
      search.set('user', username);
      return `${pathname}?${search}${hash ? `#${hash}` : ''}`;
    },
    [username],
  );

  const setViewer = useCallback(
    (next: string) => {
      const search = new URLSearchParams(location.search);
      search.set('user', next);
      navigate({ pathname: location.pathname, search: `?${search}` });
    },
    [location.pathname, location.search, navigate],
  );

  return { username, link, setViewer };
}

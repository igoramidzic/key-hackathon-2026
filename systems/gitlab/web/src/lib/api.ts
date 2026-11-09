import { createGitlabClient } from '@sim/contracts/gitlab';

/**
 * Path prefix the UI is served under: '' in multi-port dev (base '/'), '/gitlab' when built with
 * `vite build --base /gitlab/` for single-origin hosting. The REST API sits under the same prefix.
 */
export const BASE_PATH = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Same-origin client under BASE_PATH; Vite proxies /api to the GitLab API. */
export const api = createGitlabClient(BASE_PATH);

export const ORG = 'keybank';

/** `keybank/PAY00/payments-api` → UI path `/keybank/PAY00/payments-api`. */
export const projectHref = (path: string) => `/${path}`;
export const groupHref = (fullPath: string) => `/${fullPath}`;
export const mrHref = (projectPath: string, iid: number) =>
  `/${projectPath}/-/merge_requests/${iid}`;
export const commitHref = (projectPath: string, sha: string) => `/${projectPath}/-/commit/${sha}`;
const encPath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
export const treeHref = (projectPath: string, ref: string, dir = '') =>
  `/${projectPath}/-/tree/${encPath(ref)}${dir ? `/${encPath(dir)}` : ''}`;
export const blobHref = (projectPath: string, ref: string, file: string) =>
  `/${projectPath}/-/blob/${encPath(ref)}/${encPath(file)}`;
export const commitsHref = (projectPath: string, ref = 'main', path?: string) =>
  `/${projectPath}/-/commits/${encPath(ref)}${path ? `?path=${encodeURIComponent(path)}` : ''}`;

/** People who can merge from the UI (NOC, incident management); app members are added per group. */
export const DEFAULT_MERGERS = ['dwhitfield', 'mbell', 'tokafor'];

const MERGE_AS_KEY = 'gitlab.mergeAs';
export function loadMergeAs(): string {
  try {
    return localStorage.getItem(MERGE_AS_KEY) || 'dwhitfield';
  } catch {
    return 'dwhitfield';
  }
}
export function saveMergeAs(username: string) {
  try {
    localStorage.setItem(MERGE_AS_KEY, username);
  } catch {
    // per-viewer convenience only
  }
}

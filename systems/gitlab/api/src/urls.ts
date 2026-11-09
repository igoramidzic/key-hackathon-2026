import { URLS } from '@sim/contracts';

const env = (name: string) =>
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name];

/**
 * Base URL of the GitLab web UI; every entity's `web_url` points here. Read at call time so
 * single-origin hosting (configureUrls) applies.
 */
export const web = () => (env('GITLAB_WEB_URL') ?? URLS.gitlab.web).replace(/\/$/, '');
/** Public base URL of this API (used for archive download links). */
export const apiBase = () => (env('GITLAB_API_URL') ?? URLS.gitlab.api).replace(/\/$/, '');

const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/');

export const webUrls = {
  group: (fullPath: string) => `${web()}/${fullPath}`,
  project: (path: string) => `${web()}/${path}`,
  user: (username: string) => `${web()}/${username}`,
  mr: (path: string, iid: number) => `${web()}/${path}/-/merge_requests/${iid}`,
  commit: (path: string, sha: string) => `${web()}/${path}/-/commit/${sha}`,
  blob: (path: string, ref: string, file: string) =>
    `${web()}/${path}/-/blob/${enc(ref)}/${enc(file)}`,
  tree: (path: string, ref: string, dir = '') =>
    `${web()}/${path}/-/tree/${enc(ref)}${dir ? `/${enc(dir)}` : ''}`,
  branch: (path: string, name: string) => `${web()}/${path}/-/tree/${enc(name)}`,
  tag: (path: string, name: string) => `${web()}/${path}/-/tags/${encodeURIComponent(name)}`,
  pipeline: (path: string, id: number) => `${web()}/${path}/-/pipelines/${id}`,
  compare: (path: string, from: string, to: string) => `${web()}/${path}/-/compare/${from}...${to}`,
};

import { GitlabStore, type GitlabStoreOptions } from './store/store';

let store: GitlabStore | null = null;
let options: GitlabStoreOptions = {};

/** Sets options for the next store build (call before first use; reset keeps them). */
export function configureStore(next: GitlabStoreOptions): void {
  options = next;
}

/** The current in-memory instance (built on first use and on reset). */
export function getStore(): GitlabStore {
  if (!store) store = new GitlabStore(Date.now(), options);
  return store;
}

export function resetStore(): GitlabStore {
  store = new GitlabStore(Date.now(), options);
  return store;
}

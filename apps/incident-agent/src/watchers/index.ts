/**
 * Stream watchers for live log streams and ServiceNow activity feeds.
 */
export interface StreamWatcherOptions {
  url: string;
  signal?: AbortSignal;
}

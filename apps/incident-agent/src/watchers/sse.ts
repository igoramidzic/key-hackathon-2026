/** Minimal Server-Sent Events reader over fetch (Node has no EventSource without a flag). */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parses an SSE byte stream into events. Comments (`: heartbeat`) are skipped. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = 'message';
  let data: string[] = [];
  let id: string | undefined;
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n'), id };
          event = 'message';
          data = [];
          id = undefined;
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = value;
        else if (field === 'data') data.push(value);
        else if (field === 'id') id = value;
      }
    }
    if (data.length) yield { event, data: data.join('\n'), id };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

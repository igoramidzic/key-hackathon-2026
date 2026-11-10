import { defaultTarget, type Target } from './mcp';

// ---------------------------------------------------------------------------
// Snippet target: the endpoints of wherever these docs are served from. Opened from `pnpm dev`
// (localhost) the snippets use the local ports; opened from the hosted Worker they use its origin.
// ---------------------------------------------------------------------------

const TARGET: Target = defaultTarget();

export const useTarget = (): { target: Target } => ({ target: TARGET });

/** One line saying which endpoints the snippets use. */
export function targetNote(target: Target): string {
  return target === 'local'
    ? 'Local endpoints: needs pnpm dev running.'
    : 'Hosted endpoints: shared with everyone using the live demo.';
}

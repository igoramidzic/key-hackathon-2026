import { ToggleGroup, ToggleGroupItem } from '@sim/ui';
import { createContext, type ReactNode, useContext, useState } from 'react';
import { defaultTarget, type Target } from './mcp';

// ---------------------------------------------------------------------------
// Snippet target (local ports vs the hosted Worker), shared by every page.
// ---------------------------------------------------------------------------

const TargetContext = createContext<{ target: Target; setTarget: (t: Target) => void }>({
  target: 'local',
  setTarget: () => {},
});

export const useTarget = () => useContext(TargetContext);

function readTarget(): Target {
  try {
    const v = localStorage.getItem('docs.target');
    if (v === 'local' || v === 'hosted') return v;
  } catch {}
  return defaultTarget();
}

export function TargetToggle() {
  const { target, setTarget } = useTarget();
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Snippets for</span>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        value={target}
        onValueChange={(v) => (v === 'local' || v === 'hosted') && setTarget(v)}
      >
        <ToggleGroupItem value="local">Local</ToggleGroupItem>
        <ToggleGroupItem value="hosted">Hosted</ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

export function TargetProvider({ children }: { children: ReactNode }) {
  const [target, setTargetState] = useState<Target>(readTarget);
  const setTarget = (t: Target) => {
    setTargetState(t);
    try {
      localStorage.setItem('docs.target', t);
    } catch {}
  };
  return <TargetContext.Provider value={{ target, setTarget }}>{children}</TargetContext.Provider>;
}

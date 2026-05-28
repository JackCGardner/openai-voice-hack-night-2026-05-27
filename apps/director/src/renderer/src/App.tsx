import { useEffect, type JSX } from 'react';
import { DormantStrip } from './components/DormantStrip';
import { useDirectorStore } from './state/store';

export function App(): JSX.Element {
  const setHotkeyPing = useDirectorStore((s) => s.pingHotkey);

  useEffect(() => {
    // Bridge will be undefined in non-Electron contexts (e.g. plain `vite` web preview).
    const bridge = window.director;
    if (!bridge) return;
    const unsubscribe = bridge.onHotkey(() => {
      setHotkeyPing();
    });
    return unsubscribe;
  }, [setHotkeyPing]);

  return <DormantStrip />;
}

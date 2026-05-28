import { useEffect, useState, type JSX } from 'react';
import { DormantStrip } from './components/DormantStrip';
import { ListeningStrip } from './components/ListeningStrip';
import { SpeakingStrip } from './components/SpeakingStrip';
import { ThinkingStrip } from './components/ThinkingStrip';
import { HiveStrip } from './components/HiveStrip';
import { useRealtimeClient } from './hooks/useRealtimeClient';
import { useDirectorStore, type Agent, type StripState } from './state/store';

type HiveVariant = 'working' | 'blocked' | 'done';

const HIVE_WORKING: Agent[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'FRONTEND',
    accent: 'maya',
    status: 'working',
    trail: 'wiring the flip animation',
    files: 'PlaylistCard.tsx · CoverArt.tsx',
  },
  {
    id: 'jin',
    name: 'Jin',
    role: 'BACKEND',
    accent: 'jin',
    status: 'working',
    trail: 'POST /api/generate routed',
    files: 'lib/generator.ts',
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'DATA',
    accent: 'cleo',
    status: 'working',
    trail: 'writing Mixtape schema',
    files: 'lib/schema.ts',
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'DESIGN',
    accent: 'wren',
    status: 'working',
    trail: 'holographic tokens tuning',
    files: 'tailwind.config.ts · themes.ts',
  },
];

const HIVE_BLOCKED: Agent[] = [
  {
    id: 'jin',
    name: 'Jin',
    role: 'BACKEND',
    accent: 'jin',
    status: 'blocked',
    trail: 'awaiting Stripe key direction',
    files: '',
  },
  {
    id: 'maya',
    name: 'Maya',
    role: 'FRONTEND',
    accent: 'maya',
    status: 'working',
    trail: 'wiring the flip animation',
    files: 'PlaylistCard.tsx',
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'DATA',
    accent: 'cleo',
    status: 'working',
    trail: 'writing Mixtape schema',
    files: 'lib/schema.ts',
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'DESIGN',
    accent: 'wren',
    status: 'done',
    trail: 'holographic tokens locked',
    files: '',
  },
];

const HIVE_DONE: Agent[] = [
  {
    id: 'maya',
    name: 'Maya',
    role: 'FRONTEND',
    accent: 'maya',
    status: 'done',
    trail: 'PlaylistCard delivered',
    files: '4 files · 184 lines',
  },
  {
    id: 'jin',
    name: 'Jin',
    role: 'BACKEND',
    accent: 'jin',
    status: 'done',
    trail: 'generate route shipped',
    files: '2 files · 96 lines',
  },
  {
    id: 'cleo',
    name: 'Cleo',
    role: 'DATA',
    accent: 'cleo',
    status: 'done',
    trail: 'schema + store committed',
    files: '3 files · 71 lines',
  },
  {
    id: 'wren',
    name: 'Wren',
    role: 'DESIGN',
    accent: 'wren',
    status: 'done',
    trail: 'theme tokens shipped',
    files: '2 files · 48 lines',
  },
];

export function App(): JSX.Element {
  const stripState = useDirectorStore((s) => s.stripState);
  const setStripState = useDirectorStore((s) => s.setStripState);
  const pingHotkey = useDirectorStore((s) => s.pingHotkey);
  const { client, status: realtimeStatus } = useRealtimeClient();
  const [hiveVariant, setHiveVariant] = useState<HiveVariant>('working');

  // Log Realtime lifecycle. W3 will reflect this into stripState.
  useEffect(() => {
    console.log(`[realtime] status → ${realtimeStatus}`);
  }, [realtimeStatus]);

  // Bridge global hotkey from main process (W1).
  useEffect(() => {
    const bridge = window.director;
    if (!bridge) return;
    return bridge.onHotkey(() => {
      pingHotkey();
      if (
        client.status === 'idle' ||
        client.status === 'closed' ||
        client.status === 'error'
      ) {
        client.connect().catch((err) => {
          console.error('[realtime] connect failed', err);
        });
      }
    });
  }, [pingHotkey, client]);

  // Dev switcher: 1/2/3/4 cycle Dormant/Listening/Speaking/Thinking;
  // 5/6/7 set Hive working/blocked/done. Removed once W3 wires the
  // real state-machine transitions. Modifier-key shortcuts are ignored.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const map: Record<string, () => void> = {
        '1': () => setStripState('dormant'),
        '2': () => setStripState('listening'),
        '3': () => setStripState('speaking'),
        '4': () => setStripState('thinking'),
        '5': () => {
          setStripState('hive');
          setHiveVariant('working');
        },
        '6': () => {
          setStripState('hive');
          setHiveVariant('blocked');
        },
        '7': () => {
          setStripState('hive');
          setHiveVariant('done');
        },
      };
      const fn = map[e.key];
      if (fn) {
        fn();
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setStripState]);

  return renderStrip(stripState, hiveVariant);
}

function renderStrip(state: StripState, variant: HiveVariant): JSX.Element {
  switch (state) {
    case 'dormant':
      return <DormantStrip />;
    case 'listening':
      return <ListeningStrip />;
    case 'speaking':
      return <SpeakingStrip />;
    case 'thinking':
      return <ThinkingStrip />;
    case 'hive': {
      const agents =
        variant === 'blocked' ? HIVE_BLOCKED : variant === 'done' ? HIVE_DONE : HIVE_WORKING;
      return <HiveStrip agents={agents} variant={variant} />;
    }
    case 'escalating':
      return <HiveStrip agents={HIVE_BLOCKED} variant="blocked" />;
    default:
      return <DormantStrip />;
  }
}

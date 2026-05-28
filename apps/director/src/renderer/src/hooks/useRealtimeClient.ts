import { useEffect, useRef, useState } from 'react';
import { RealtimeClient, type RealtimeClientStatus } from '../realtime/client.js';

/**
 * React hook that owns a single RealtimeClient instance for the lifetime
 * of the component tree. Returns the client + its current status. Higher
 * layers (W3 state) can subscribe to events directly off the client.
 */
export function useRealtimeClient(): { client: RealtimeClient; status: RealtimeClientStatus } {
  const ref = useRef<RealtimeClient | null>(null);
  if (!ref.current) ref.current = new RealtimeClient();
  const [status, setStatus] = useState<RealtimeClientStatus>(ref.current.status);

  useEffect(() => {
    const client = ref.current!;
    const off = client.on('status', setStatus);
    return () => {
      off();
      // Tear down the peer if the host component unmounts. Sessions are
      // short-lived in dev (hot reload) so we want a clean slate each time.
      client.close();
    };
  }, []);

  return { client: ref.current, status };
}

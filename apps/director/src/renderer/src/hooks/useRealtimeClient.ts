import { useEffect, useRef, useState } from 'react';
import {
  RealtimeClient,
  type RealtimeClientStatus,
  type RealtimeStreams,
} from '../realtime/client.js';

/**
 * React hook that owns a single RealtimeClient instance for the lifetime
 * of the component tree. Returns the client, its current status, and the
 * live mic + remote audio MediaStreams (null until they materialize). The
 * canonical state-machine store reads no audio data — these streams are
 * consumed by ListeningStrip / SpeakingStrip waveform analysers only.
 */
export function useRealtimeClient(): {
  client: RealtimeClient;
  status: RealtimeClientStatus;
  micStream: MediaStream | null;
  remoteStream: MediaStream | null;
} {
  const ref = useRef<RealtimeClient | null>(null);
  if (!ref.current) ref.current = new RealtimeClient();
  const [status, setStatus] = useState<RealtimeClientStatus>(ref.current.status);
  const [streams, setStreams] = useState<RealtimeStreams>(ref.current.getStreams());

  useEffect(() => {
    const client = ref.current!;
    const offStatus = client.on('status', setStatus);
    const offStreams = client.on('streams', setStreams);
    return () => {
      offStatus();
      offStreams();
      // Tear down the peer if the host component unmounts. Sessions are
      // short-lived in dev (hot reload) so we want a clean slate each time.
      client.close();
    };
  }, []);

  return {
    client: ref.current,
    status,
    micStream: streams.mic,
    remoteStream: streams.remote,
  };
}

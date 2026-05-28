/**
 * Tiny wrapper around the preload `window.director.tool.call` bridge so any
 * renderer surface (chat footer buttons, dev keystrokes) can fire a tool
 * call without re-implementing the boilerplate. No-op (with warning) if
 * the bridge is not exposed yet — keeps the UI from crashing during the
 * brief window between renderer mount and preload ready.
 */

export async function devToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const bridge = window.director;
  if (!bridge?.tool) {
    console.warn('[dev] window.director.tool not exposed yet — skipping', {
      name,
      args,
    });
    return;
  }
  try {
    const result = await bridge.tool.call({
      callId: `dev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: name as never,
      args,
      realtimeItemId: `dev-item-${Date.now()}`,
    });
    console.log('[dev] tool.call', name, '→', result);
  } catch (err) {
    console.error('[dev] tool.call failed', err);
  }
}

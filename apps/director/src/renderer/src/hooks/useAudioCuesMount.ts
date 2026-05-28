/**
 * useAudioCuesMount — defensive loader for W3's audio cue wiring (P5.2).
 *
 * W3 ships `apps/director/src/renderer/src/audio/index.ts` exporting a
 * single `initAudioCues()` function that subscribes to zustand state
 * transitions and plays the appropriate cue (`confirm`, `tick`, `done`,
 * `escalation`, `halo`).
 *
 * Until W3's audio module lands, this hook is a noop — it attempts a
 * dynamic import once at mount; failure logs a single warn and never
 * retries. Per W4's lane in docs/remaining-phases.md § 5.3, App.tsx
 * mounts this once via the marker section.
 *
 * Mounting via dynamic import + try/catch keeps the renderer compiling
 * before W3 ships their module — no static import failure at build time.
 */

import { useEffect } from 'react';

export function useAudioCuesMount(): void {
  useEffect(() => {
    let unmounted = false;
    let teardown: (() => void) | void;
    (async () => {
      try {
        // Dynamic import — using a string literal Vite cannot statically
        // resolve (so the missing module doesn't fail the build). The
        // value is reconstructed at runtime to deliberately bypass the
        // bundler's module-resolution check.
        const target = ['..', 'audio', 'index.js'].join('/');
        const mod = await import(/* @vite-ignore */ target).catch(() => null);
        if (unmounted) return;
        if (!mod) {
          // Module not present yet (W3 has not landed P5.2). Silent.
          return;
        }
        const init = (mod as { initAudioCues?: () => void | (() => void) }).initAudioCues;
        if (typeof init !== 'function') {
          console.warn('[useAudioCuesMount] audio module loaded but no initAudioCues export');
          return;
        }
        const result = init();
        if (typeof result === 'function') {
          teardown = result;
        }
      } catch (err) {
        // Any other failure — log once, never retry.
        console.warn('[useAudioCuesMount] failed to init audio cues', err);
      }
    })();
    return () => {
      unmounted = true;
      try {
        teardown?.();
      } catch (err) {
        console.warn('[useAudioCuesMount] teardown threw', err);
      }
    };
  }, []);
}

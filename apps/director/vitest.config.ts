import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sharedPath = fileURLToPath(new URL('./src/shared', import.meta.url));
const rendererPath = fileURLToPath(new URL('./src/renderer/src', import.meta.url));

export default defineConfig({
  // esbuild handles .tsx via the default loader; vitest follows the
  // `jsx` field in tsconfig.web.json (react-jsx). No plugin needed.
  esbuild: {
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      // Mirror tsconfig.web.json paths so vitest can resolve the same
      // module specifiers that the renderer build uses.
      '@shared': sharedPath,
      '@renderer': rendererPath,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});

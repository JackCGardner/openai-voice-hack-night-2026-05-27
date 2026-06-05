/**
 * Tests for the agent-brain's image-generation wiring (finish-spec §A).
 *
 * Headless, no network: the OpenAI Images client is a FAKE injected either via
 * the `_setImagesClientForTests` seam (for the `generate_image` tool path) or as
 * the optional second arg to `generateImageImpl` (the executor under test). The
 * file write lands in a per-test temp dir (we point `homedir()` at it before the
 * module loads, since GENERATED_DIR is computed at import time). `electron` is
 * mocked defensively — agent-brain's electron-touching code (`canvas.js`) is a
 * lazy import inside `show_canvas`, never hit here, but the mock keeps the import
 * graph headless-safe regardless.
 *
 * Covers: saveGeneratedImage (bare base64 + data-URL stripping, on-disk write,
 * file:// url); generateImageImpl (data: URL shape, persisted file, file_url,
 * label echo, the size default, the no-data error); and the generate_image tool's
 * execute — valid JSON on success AND the caught-error `{ ok:false, error }`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// `electron.shell.openExternal` is recorded so the open_preview tool's lazy
// `import('electron')` path (no injected seam) is assertable headlessly.
const openExternalSpy = vi.fn(async (_u: string) => {});
vi.mock('electron', () => ({
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
  BrowserWindow: class {},
  app: { getPath: () => tmpdir() },
  shell: { openExternal: (u: string) => openExternalSpy(u) },
}));

// GENERATED_DIR is `join(homedir(), '.director', 'generated')`, evaluated at
// module load. Point homedir() at a throwaway dir BEFORE importing agent-brain
// so generated files never touch the real ~/.director.
const TMP_HOME = mkdtempSync(join(tmpdir(), 'director-brain-test-'));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => TMP_HOME };
});

// A 1x1 transparent PNG (valid base64 body) — used as the "generated" bytes.
const PNG_1x1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// Import AFTER the mocks so they apply.
const { _internals, saveGeneratedImage } = await import('./agent-brain.js');
const { generateImageImpl, generateImageTool, GENERATED_DIR, openPreviewImpl, openPreviewTool } =
  _internals;

/** Build a fake OpenAI client whose images.generate returns a fixed b64 (or throws). */
function fakeImagesClient(opts: {
  b64?: string | undefined;
  throwError?: Error;
  capture?: (params: unknown) => void;
}): import('openai').default {
  const generate = vi.fn(async (params: unknown) => {
    opts.capture?.(params);
    if (opts.throwError) throw opts.throwError;
    return { created: 0, data: opts.b64 === undefined ? [] : [{ b64_json: opts.b64 }] };
  });
  // Only `images.generate` is exercised; cast through unknown to the SDK type.
  return { images: { generate } } as unknown as import('openai').default;
}

afterEach(() => {
  _internals._setImagesClientForTests(null); // reset to the lazy production singleton
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

describe('saveGeneratedImage', () => {
  it('writes a bare base64 body to GENERATED_DIR and returns path + file:// url', () => {
    const { path, fileUrl } = saveGeneratedImage(PNG_1x1_B64, { label: 'Calm Mist' });
    expect(path.startsWith(GENERATED_DIR)).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(path).toContain('calm-mist'); // slugified label
    expect(existsSync(path)).toBe(true);
    expect(fileUrl).toBe(pathToFileURL(path).href);
    expect(fileUrl.startsWith('file://')).toBe(true);
    // Bytes on disk round-trip from the base64 body.
    expect(readFileSync(path).equals(Buffer.from(PNG_1x1_B64, 'base64'))).toBe(true);
  });

  it('strips a full data: URL prefix and honors the ext from the mime', () => {
    const { path } = saveGeneratedImage(`data:image/webp;base64,${PNG_1x1_B64}`);
    expect(path.endsWith('.webp')).toBe(true);
    expect(readFileSync(path).equals(Buffer.from(PNG_1x1_B64, 'base64'))).toBe(true);
  });
});

describe('generateImageImpl', () => {
  it('returns a data: URL, persists the file, and echoes the label', async () => {
    const client = fakeImagesClient({ b64: PNG_1x1_B64 });
    const ref = await generateImageImpl(
      { prompt: 'a calm misty forest at dawn', label: 'Calm' },
      client,
    );
    expect(ref.ok).toBe(true);
    expect(ref.image_url).toBe(`data:image/png;base64,${PNG_1x1_B64}`);
    expect(ref.image_url.startsWith('data:image/png;base64,')).toBe(true);
    expect(ref.label).toBe('Calm');
    // A file landed under GENERATED_DIR and file_url is its file:// form.
    expect(ref.path.startsWith(GENERATED_DIR)).toBe(true);
    expect(existsSync(ref.path)).toBe(true);
    expect(ref.file_url).toBe(pathToFileURL(ref.path).href);
    expect(ref.file_url.startsWith('file://')).toBe(true);
  });

  it('passes the configured model, n:1, b64_json format, and defaults size', async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeImagesClient({
      b64: PNG_1x1_B64,
      capture: (p) => {
        captured = p as Record<string, unknown>;
      },
    });
    await generateImageImpl({ prompt: 'x' }, client); // no size → default
    expect(captured.model).toBe(_internals.IMAGE_MODEL);
    expect(captured.n).toBe(1);
    expect(captured.response_format).toBe('b64_json');
    expect(captured.size).toBe('1024x1024');
    expect(captured.prompt).toBe('x');
  });

  it('forwards an explicit size', async () => {
    let captured: Record<string, unknown> = {};
    const client = fakeImagesClient({
      b64: PNG_1x1_B64,
      capture: (p) => {
        captured = p as Record<string, unknown>;
      },
    });
    await generateImageImpl({ prompt: 'hero', size: '1536x1024' }, client);
    expect(captured.size).toBe('1536x1024');
  });

  it('throws a clear error when the API returns no base64 data', async () => {
    const client = fakeImagesClient({ b64: undefined }); // data: []
    await expect(generateImageImpl({ prompt: 'x' }, client)).rejects.toThrow(
      /no base64 image data/i,
    );
  });
});

describe('generate_image tool', () => {
  const ctx = {} as never; // executor body ignores runContext

  it('is a function tool named generate_image', () => {
    expect(generateImageTool.type).toBe('function');
    expect(generateImageTool.name).toBe('generate_image');
  });

  it('returns valid JSON with the data: URL on success (via the client seam)', async () => {
    _internals._setImagesClientForTests(fakeImagesClient({ b64: PNG_1x1_B64 }));
    const out = await generateImageTool.invoke(
      ctx,
      JSON.stringify({ prompt: 'a brand mark, minimal', label: 'Mark', size: null }),
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.image_url).toBe(`data:image/png;base64,${PNG_1x1_B64}`);
    expect(parsed.label).toBe('Mark');
    expect(existsSync(parsed.path)).toBe(true);
  });

  it('returns { ok:false, error } as JSON when the API throws (never hangs)', async () => {
    _internals._setImagesClientForTests(fakeImagesClient({ throwError: new Error('rate limited') }));
    const out = await generateImageTool.invoke(
      ctx,
      JSON.stringify({ prompt: 'x', label: null, size: null }),
    );
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/rate limited/);
  });
});

describe('openPreviewImpl (Flow 5 — open the running product in the browser)', () => {
  it('calls the injected shell.openExternal with the url and returns { ok:true }', async () => {
    const openExternal = vi.fn(async (_u: string) => {});
    const res = await openPreviewImpl('http://localhost:3000', { openExternal });
    expect(res.ok).toBe(true);
    expect(res.url).toBe('http://localhost:3000');
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('http://localhost:3000');
  });

  it('trims surrounding whitespace before opening', async () => {
    const openExternal = vi.fn(async (_u: string) => {});
    const res = await openPreviewImpl('  https://example.dev  ', { openExternal });
    expect(res.ok).toBe(true);
    expect(openExternal).toHaveBeenCalledWith('https://example.dev');
  });

  it('rejects an empty url WITHOUT calling the shell (error string, never throws)', async () => {
    const openExternal = vi.fn(async (_u: string) => {});
    const res = await openPreviewImpl('   ', { openExternal });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-empty/i);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('rejects a non-http(s) url (e.g. file:, javascript:) WITHOUT calling the shell', async () => {
    const openExternal = vi.fn(async (_u: string) => {});
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      const res = await openPreviewImpl(bad, { openExternal });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/http/i);
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('returns { ok:false, error } (never throws) when shell.openExternal rejects', async () => {
    const openExternal = vi.fn(async (_u: string) => {
      throw new Error('no browser');
    });
    const res = await openPreviewImpl('http://localhost:5173', { openExternal });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no browser/);
    expect(res.url).toBe('http://localhost:5173');
  });

  it('falls back to the real electron.shell when no seam is injected', async () => {
    openExternalSpy.mockClear();
    const res = await openPreviewImpl('http://localhost:8080');
    expect(res.ok).toBe(true);
    expect(openExternalSpy).toHaveBeenCalledWith('http://localhost:8080');
  });
});

describe('open_preview tool', () => {
  const ctx = {} as never; // executor body ignores runContext

  it('is a function tool named open_preview', () => {
    expect(openPreviewTool.type).toBe('function');
    expect(openPreviewTool.name).toBe('open_preview');
  });

  it('execute returns JSON { ok:true, url } and opens via electron.shell', async () => {
    openExternalSpy.mockClear();
    const out = await openPreviewTool.invoke(ctx, JSON.stringify({ url: 'http://localhost:4321' }));
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(true);
    expect(parsed.url).toBe('http://localhost:4321');
    expect(openExternalSpy).toHaveBeenCalledWith('http://localhost:4321');
  });

  it('execute returns JSON { ok:false, error } for a bad url (never throws)', async () => {
    openExternalSpy.mockClear();
    const out = await openPreviewTool.invoke(ctx, JSON.stringify({ url: 'ftp://nope' }));
    const parsed = JSON.parse(out as string);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/http/i);
    expect(openExternalSpy).not.toHaveBeenCalled();
  });
});

// Verify the SDP endpoint URL by minting a token then POSTing a bogus
// SDP body. We don't have a real WebRTC offer here, but the URL existence
// + auth shape will be clear from the response code:
//   404 → wrong path (try /v1/realtime?model=…)
//   401 → bad ephemeral token
//   400/422 → URL is right, body is bogus (expected)
// Run: node apps/director/scripts/test-sdp.mjs

import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(here, '..');
const REPO_ROOT = resolve(APP_DIR, '..', '..');
loadDotenv({ path: resolve(REPO_ROOT, '.env') });
loadDotenv({ path: resolve(APP_DIR, '.env') });

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY missing');
  process.exit(1);
}

// Mint with the same minimal config that works.
const mintRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    session: {
      type: 'realtime',
      model: 'gpt-realtime-2',
      output_modalities: ['audio'],
      audio: {
        input: { format: { type: 'audio/pcm', rate: 24000 } },
        output: { format: { type: 'audio/pcm', rate: 24000 }, voice: 'marin' },
      },
    },
  }),
});

if (!mintRes.ok) {
  console.error(`[sdp-test] mint failed: HTTP ${mintRes.status}`, await mintRes.text());
  process.exit(2);
}

const mintJson = await mintRes.json();
const token = mintJson.client_secret?.value ?? mintJson.value;
if (!token) {
  console.error('[sdp-test] no token in mint response', mintJson);
  process.exit(3);
}
console.log(`[sdp-test] minted ek_ token (${token.length} chars)`);

const candidates = [
  'https://api.openai.com/v1/realtime/calls',
  'https://api.openai.com/v1/realtime?model=gpt-realtime-2',
];

for (const url of candidates) {
  console.log(`\n[sdp-test] probing ${url}`);
  const sdpRes = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/sdp' },
    body: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n',
  });
  const body = await sdpRes.text();
  console.log(`  HTTP ${sdpRes.status}`);
  console.log(`  body: ${body.slice(0, 240).replace(/\n/g, ' ')}${body.length > 240 ? '…' : ''}`);
}

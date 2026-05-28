// Smoke test for the realtime mint endpoint. Loads .env the same way main
// does, then POSTs the same payload main would POST and prints the result.
// Run: node apps/director/scripts/test-mint.mjs

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
  console.error('OPENAI_API_KEY missing — set it in apps/director/.env or repo root .env');
  process.exit(1);
}

const model = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2';
const voice = process.env.OPENAI_REALTIME_VOICE || 'marin';

const body = {
  session: {
    type: 'realtime',
    model,
    output_modalities: ['audio'],
    instructions: 'You are Director. Be brief.',
    audio: {
      input: {
        format: { type: 'audio/pcm', rate: 24000 },
        turn_detection: { type: 'semantic_vad', eagerness: 'medium', interrupt_response: true },
      },
      output: { format: { type: 'audio/pcm', rate: 24000 }, voice, speed: 1.0 },
    },
    tools: [
      {
        type: 'function',
        name: 'ask_user',
        description: 'Ask the user a direct question.',
        parameters: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      },
    ],
    tool_choice: 'auto',
    reasoning: { effort: 'low' },
    include: ['item.input_audio_transcription.logprobs'],
  },
};

console.log(`[mint-test] model=${model} voice=${voice}`);
const res = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
  method: 'POST',
  headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const text = await res.text();
console.log(`[mint-test] HTTP ${res.status}`);

// Pretty-print but redact the secret value so logs are safe to share.
try {
  const json = JSON.parse(text);
  const redacted = JSON.parse(JSON.stringify(json));
  if (redacted.value) redacted.value = `${redacted.value.slice(0, 12)}…(${redacted.value.length} chars)`;
  if (redacted.client_secret?.value) {
    redacted.client_secret.value = `${redacted.client_secret.value.slice(0, 12)}…(${redacted.client_secret.value.length} chars)`;
  }
  console.log(JSON.stringify(redacted, null, 2));
} catch {
  console.log(text);
}

if (!res.ok) process.exit(2);

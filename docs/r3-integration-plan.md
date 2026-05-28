# R3 Cross-Cutting Integration Plan

> **Owner**: Main (orchestrator). Fires when W1 P4 + W3 P3 both land on `main`.
>
> **Why this is Main's job**: it crosses 3 workers' boundaries (W1's planner.ts + tool-router.ts, W3's side-store.ts, W3's renderer state). Single worker can't own it. Per `docs/orchestrator-playbook.md` Mode 5.

This document is what I execute the moment both prerequisites land. Pre-written so the integration is fast + deterministic instead of improvised under pressure.

---

## Prerequisites (must all be true before this fires)

1. ✅ W1 P3 done: `apps/director/src/main/planner.ts` exists, exports `consultDirector()`, has a TODO stub for `readWorldState()`
2. ✅ W2 P3 done: `consult_director` tool registered in session.update, persona knows to use it
3. ⏳ W3 P3 done: `apps/director/src/main/side-store.ts` exists, exports `readWorldState()` + `appendHarnessRule()` + `writeAgent()` + `registerSideStoreIpc()`
4. ⏳ W1 P4 done: `apps/director/src/main/codex-pool.ts` exists, exports `dispatchAgent()` + `registerCodexPoolIpc()`

When all four are true: dispatch this integration.

---

## Integration tasks (ordered)

### Task 1: Wire side store init at app boot (3 min)

**File**: `apps/director/src/main/index.ts` (W1's, but Main does cross-cutting per § 13.3)

In `app.whenReady()`, BEFORE `registerToolRouterIpc()` and `registerPlannerDevIpc()`, add:

```ts
import { registerSideStoreIpc } from './side-store.js';
// ...
await registerSideStoreIpc();  // initializes ~/.director/sessions/<id>/
```

Side store must be initialized before any tool handler that writes to it.

### Task 2: Replace planner's `readWorldState()` stub with real import (3 min)

**File**: `apps/director/src/main/planner.ts`

Find the stub:
```ts
async function readWorldState(): Promise<Record<string, unknown>> {
  // TODO(side-store): replace stub with real readSideStore() once landed
  return { active_agents: [], harness: [], recent_decisions: [], current_task: null };
}
```

Replace the body with:
```ts
import { readWorldState as readSideStoreWorldState } from './side-store.js';
// ...
async function readWorldState(): Promise<Record<string, unknown>> {
  const ws = await readSideStoreWorldState();
  return ws as unknown as Record<string, unknown>;
}
```

The planner now feeds gpt-5 actual session state instead of empty objects.

### Task 3: Make `update_harness` tool persist to side store (5 min)

**File**: `apps/director/src/main/tool-router.ts` — find `handleUpdateHarness` (or whatever the W1 worker named it).

Currently it calls `sendStripPatch('harness', ...)` to update the renderer store. Add a side-store write BEFORE the patch:

```ts
import { appendHarnessRule, appendDecision } from './side-store.js';
// ...
async function handleUpdateHarness(req: ToolCallRequest) {
  const { rule, why } = req.args as { rule: string; why: string };
  const hRule = { rule, why, timestamp: Date.now() };

  // Persist to disk first (durability).
  const allRules = await appendHarnessRule(hRule);
  await appendDecision({
    at: Date.now(),
    kind: 'harness_rule',
    payload: { rule, why },
  });

  // Then patch the renderer store (existing behavior).
  sendStripPatch('harness', { action: 'addRule', rule: hRule });

  // Then trigger the canvas flash (existing behavior).
  renderCanvas({ component: 'harness_rule_save', props: { rule, why }, autoDismissMs: 1200 });

  return { ok: true, callId: req.callId, output: { harness_count: allRules.length }, latencyMs: 0 };
}
```

Disk write happens before store mutation. If disk fails, we don't update UI (atomic-ish).

### Task 4: Make `dispatch_agent_mock` use real Codex pool (10 min — the biggest item)

**File**: `apps/director/src/main/tool-router.ts` — find `handleDispatchAgentMock`.

Currently it adds an agent via `sendStripPatch` and kicks off the timer sim. We need to ALSO spawn a real Codex subprocess via W1's pool, OR replace the sim entirely with real Codex.

For the demo, the cleanest pivot: KEEP the sim as the fallback when no `OPENAI_API_KEY` is present, but USE real Codex when available.

```ts
import { dispatchAgent } from './codex-pool.js';
import { initSession } from './side-store.js';
// ...
async function handleDispatchAgentMock(req: ToolCallRequest) {
  const { name, role, task } = req.args as { name: string; role: AgentRole; task: string };
  const agentId = name.toLowerCase();

  const accent = ACCENT_FOR_ROLE[role]; // existing constants
  const agentSnapshot: Agent = {
    id: agentId, name, role, accent,
    status: 'working', trail: task, files: [],
  };

  // Persist agent to disk + patch the store immediately so the Hive shows it.
  await writeAgent(agentSnapshot);
  sendStripPatch('agents', { action: 'addAgent', agent: agentSnapshot });

  // Decide: real Codex or sim?
  const useRealCodex = !!process.env.OPENAI_API_KEY && shouldUseRealCodex();
  if (useRealCodex) {
    const { sessionId } = await initSession();
    const result = await dispatchAgent({
      agentId,
      name,
      role,
      task,
      targetRepo: TARGET_REPO,  // examples/mixtape
    }, sessionId);
    if (!result.ok) {
      // Fallback to sim if Codex spawn fails
      console.warn('[tool-router] codex dispatch failed, falling back to sim:', result.error);
      kickOffSim();
    }
  } else {
    // No API key or feature flag off — use sim
    kickOffSim();
  }

  return { ok: true, callId: req.callId, output: { agent_id: agentId }, latencyMs: 0 };
}

function shouldUseRealCodex(): boolean {
  return process.env.DIRECTOR_USE_REAL_CODEX === '1';
}
```

The `DIRECTOR_USE_REAL_CODEX=1` env var is the kill switch. Default to sim until we're confident Codex works. Add to `.env.example` documenting this.

### Task 5: Codex pool events → renderer state (10 min — needs renderer touch)

**File**: `apps/director/src/main/codex-pool.ts` already emits `IpcChannel.CodexEvent`. The renderer needs to subscribe and translate events into store actions.

**File**: `apps/director/src/renderer/src/state/ipcSync.ts` (W3's territory — but I'm doing cross-cutting integration).

Add a handler for `codex.event`:

```ts
import { IpcChannel } from '../../../shared/ipc.js';
// ...
const bridge = window.director;
if (bridge?.codex?.onEvent) {
  bridge.codex.onEvent((event) => {
    const store = useStore.getState();
    switch (event.type) {
      case 'agent_started':
        // Already handled by tool-router's addAgent — no-op
        break;
      case 'file_change': {
        const file = (event.payload.path as string) ?? '';
        if (file) store.updateAgent(event.agent_id, { files: [file].concat(store.agents[event.agent_id]?.files ?? []).slice(0, 3) });
        break;
      }
      case 'agent_message': {
        const text = (event.payload.text as string) ?? '';
        if (text) store.updateAgent(event.agent_id, { trail: text.slice(0, 80) });
        break;
      }
      case 'command_execution': {
        const cmd = (event.payload.command as string) ?? '';
        if (cmd) store.updateAgent(event.agent_id, { trail: `$ ${cmd.slice(0, 60)}` });
        break;
      }
      case 'error': {
        const msg = (event.payload.message as string) ?? 'codex error';
        store.failAgent(event.agent_id, msg);
        break;
      }
      case 'turn_completed': {
        store.completeAgent(event.agent_id, undefined);
        break;
      }
    }
  });
}
```

This means the Hive sidebar UPDATES IN REAL TIME from real Codex events. Beautiful.

The preload bridge (`window.director.codex.onEvent`) needs to exist. Check W1's `preload/index.ts` — if not present, add a single appended block.

### Task 6: Smoke test the full P3+P4 stack (15 min)

The most exciting test of the whole project so far:

1. Set `DIRECTOR_USE_REAL_CODEX=1` in `.env`
2. Launch: `pnpm --filter director dev`
3. Click Mic, say: **"Director, how should we handle persistence for Mixtape share links?"**
4. Expected: brief pause (gpt-5 thinking), then AI narrates a 1-3 sentence answer.
5. Then say: **"Build the share page. Maya, take the frontend."**
6. Expected:
   - Maya appears in the Hive sidebar
   - Real Codex subprocess spawns in `~/.director/sessions/<id>/agents/maya/worktree/`
   - File change events flow into Maya's row (you see file names update)
   - Eventually Maya completes — actual files exist in the worktree

Check `~/.director/sessions/<latest>/`:
- `harness.json` — any Harness rules saved
- `decisions.jsonl` — at least the agent dispatch decision
- `agents/maya.json` — Maya's snapshot
- `agents/maya/worktree/` — the actual git worktree with Codex's edits

If all the above works: **R3 PASS** → dispatch P5 (polish: captions, audio cues) and P6 (resilience: session rotation).

If anything breaks: identify the layer, write a focused fix prompt. Most likely failure mode is the Codex SDK API differing from my guesses — that's a W1 follow-up.

---

## Risks + fallbacks

| Risk | Detection | Mitigation |
|---|---|---|
| Codex SDK requires interactive auth (browser-based login) | First spawn hangs on stdin | Document the auth flow; for demo, pre-authenticate manually before recording |
| Rate window exhausts (5-hour rolling on Plus) | API returns 429 | Demo on ChatGPT Pro $200 tier, OR API-key fallback path |
| gpt-5 model name changes / unavailable | `/v1/responses` returns 404 | Fall back to `gpt-4o` with `reasoning.effort` removed |
| Worktree creation fails because target repo isn't initialized | `git worktree add` errors | Check `examples/mixtape/.git` exists, init if not |
| Real Codex generates code that doesn't match Pencil designs | Visual demo doesn't match expectations | Acceptable for the technical demo; polish is post-R3 |

---

## What to commit

One commit per task above (5 commits total from Main). Suggested messages:
- `feat(main): init side-store at app boot`
- `feat(planner): use real readWorldState from side-store`
- `feat(tool-router): persist harness rules to side-store`
- `feat(tool-router): dispatch real Codex via pool (env-gated)`
- `feat(renderer): sync codex events to Hive state`

After all commits, push and run smoke test.

---

## Status (live)

- [ ] W3 P3 (side-store.ts) shipped on main
- [ ] W1 P4 (codex-pool.ts) shipped on main
- [ ] Task 1: side-store init at boot
- [ ] Task 2: planner uses real world state
- [ ] Task 3: update_harness persists
- [ ] Task 4: dispatch_agent_mock uses real Codex (env-gated)
- [ ] Task 5: codex events → Hive
- [ ] Task 6: full smoke test passed

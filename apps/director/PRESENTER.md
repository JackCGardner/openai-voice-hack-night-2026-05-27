# Director Presenter Script

**Setup strip:** Director desktop app + `http://localhost:3001` Canvas. Make sure `:3001` is running. Press `⌘⇧Space` to talk. Use `⌃⌥⌘A` for the punchline reveal.

1. **"Director, let's pick up Mixtape. I want to finish the playlist card."**  
   *Before: summon Director; wait for listening waveform.* *After: Director asks where to start.*  
   Fallback: type the line, then advance to thinking.

2. **"The card material. I haven't picked yet. Show me options."**  
   *Before: answer immediately.* *After: Canvas opens three material options.*  
   Fallback: press `⌃⌥⌘M` for the moodboard.

3. **"The cassette one."**  
   *Before: let all three tiles render.* *After: cassette halo, Canvas closes, Harness rule flashes.*  
   Fallback: click the cassette tile.

4. **"I can keep working. Director will tell me when it needs me."**  
   *Before: Hive starts populating.* *After: four agents dispatch and trail text moves.*  
   Fallback: narrate over the visual; no voice command needed.

5. **"Use the mock seed. Real keys later."**  
   *Before: wait for Jin blocker chime and question.* *After: Jin returns green, Harness rule flashes.*  
   Fallback: click/type `use mock seed`.

6. **"That's the bargain — I get interrupted only when it matters."**  
   *Before: all agents are working again.* *After: Cleo, Wren, Jin, Maya finish in order.*  
   Fallback: say it to camera while sim continues.

7. **"Yeah, show me."**  
   *Before: wait for Director: "Mixtape's ready. Want to see it?"* *After: artifact Canvas opens.*  
   Fallback: press `⌃⌥⌘A`.

8. **"Late night drive through Tokyo neon."**  
   *Before: focus the vibe input.* *After: cover art and tracks appear; click cover for flip.*  
   Fallback: type it, then click the cover.

## Q&A Pitch

```text
Director is an ambient voice layer for running coding agents in parallel.
Instead of babysitting one chat thread, you speak intent once, then frontend,
backend, data, and design agents work asynchronously. The desktop strip stays
quiet until a real judgment call or blocker needs you. Visual decisions open in
Canvas, and durable preferences get written into the Harness so future agents
inherit them. The point is attended parallelization: you remain the director,
but the system owns routing, progress, escalation, and memory.
```

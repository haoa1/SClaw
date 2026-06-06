# SClaw — Prompt debug panel: SSE event + frontend UI ✅

**Problem**: AI prompt dumps written to disk (`~/.sclaw/debug/`) but no way to see them from the frontend.

**Solution**: Two-part change:

## Part 1: Backend (chat.ts) — ✅ Done
- SSE handler extended with `case 'debug_prompt'` 
- Emits `{type: "debug_prompt", filePath, messageCount, totalTokens}` after each LLM call
- File already being written to disk by `dumpPrompt()` in the chat route

## Part 2: Frontend (ChatPanel.tsx) — ✅ Done  
- `debugPrompts` ref (last 5 entries)
- `[debugOpen, setDebugOpen]` state (collapsible panel toggle)
- `[debugCount, setDebugCount]` state (shows count in button label)
- SSE handler: `case 'debug_prompt'` stores entry + increments count
- Debug panel renders between chat area and input bar:
  - Button: `▶ Prompt Debug (N dumped)` — amber-themed
  - Expanded: shows timestamp, msg count, token count, file path per entry
  - Collapsible, only visible when `debugCount > 0` (auto-shows after first dump)

**Status**: ✅ Both backend + frontend compile clean. Not yet deployed.

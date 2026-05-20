# Stock Screener AI Agent Plan

## Goal
Add a TypeScript AI Agent inside the stock-screener project. Users talk to the agent to create, modify, and run stock screening strategies.

## Architecture

```
stock-screener/
├── backend/              # Existing TS backend
├── plugins/              # Existing strategy plugins
└── ai-agent/             # NEW: TypeScript AI Agent
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── index.ts              # CLI entry point
        ├── agent-loop.ts         # Streaming agent loop
        ├── system-prompt.ts      # Stock expert system prompt
        ├── tools/
        │   ├── registry.ts       # Tool base class + registry
        │   ├── file-tools.ts     # read, write, edit, glob, grep
        │   ├── bash-tool.ts      # shell execution
        │   ├── llm-tool.ts       # LLM call wrapper
        │   ├── screen-tools.ts   # Phase 2: market_screen etc.
        │   ├── compact-tool.ts   # Phase 2: context compression
        │   └── agent-tool.ts     # Phase 3: sub-agent spawner
        ├── agents/
        │   ├── coder-agent.ts    # Phase 4
        │   ├── analyzer-agent.ts # Phase 4
        │   ├── verifier-agent.ts # Phase 4
        │   └── backtest-agent.ts # Phase 4
        └── memory/
            └── index.ts          # MEMORY.md persistence
```

## Phases

### Phase 1: Foundation — Tools + Agent Loop
- [ ] 1.1 `package.json` + `tsconfig.json`
- [ ] 1.2 `tools/registry.ts` — Tool base class + ToolRegistry + JSON Schema output
- [ ] 1.3 `tools/file-tools.ts` — read, write, edit, glob, grep
- [ ] 1.4 `tools/bash-tool.ts` — shell execution
- [ ] 1.5 `tools/llm-tool.ts` — OpenAI-compatible streaming client
- [ ] 1.6 `system-prompt.ts` — stock expert system prompt
- [ ] 1.7 `agent-loop.ts` — main interactive loop (streaming + tool execution + memory)
- [ ] 1.8 `index.ts` — CLI entry point
- [ ] 1.9 Test: `npx tsx src/index.ts` starts and accepts input

### Phase 2: Stock Tools + Compact
- [ ] 2.1 `tools/screen-tools.ts` — market_screen, stock_detail, kline_data, market_overview, list_strategies
- [ ] 2.2 `tools/compact-tool.ts` — context compression
- [ ] 2.3 Wire screen tools into agent loop
- [ ] 2.4 Test: agent can screen stocks via conversation

### Phase 3: Sub-Agent Infrastructure
- [ ] 3.1 `tools/agent-tool.ts` — spawn background sub-agent
- [ ] 3.2 Agent kill mechanism (AbortController)
- [ ] 3.3 Agent result notification
- [ ] 3.4 Test: parallel sub-agent execution

### Phase 4: Specialized Sub-Agents
- [ ] 4.1 `agents/coder-agent.ts` — strategy writer
- [ ] 4.2 `agents/analyzer-agent.ts` — result analyzer
- [ ] 4.3 `agents/verifier-agent.ts` — code reviewer
- [ ] 4.4 `agents/backtest-agent.ts` — backtester

### Phase 5: E2E via Sandbox
- [ ] 5.1 Start backend, start AI agent
- [ ] 5.2 Create strategy via conversation
- [ ] 5.3 Run strategy, analyze results
- [ ] 5.4 Modify strategy, re-run
- [ ] 5.5 Parallel backtest

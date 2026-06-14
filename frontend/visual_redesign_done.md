# SClaw Visual Redesign — Bronze/Antique Gold Theme ✅ Done

## What was done
- **Logo**: "S" in bronze, rest in stock-text, font-display (DM Serif Display)
- **Tabs**: Active tab has `tab-active` class (bronze underline diamond), inactive = stock-text-secondary
- **Header**: User info, AI indicator, and Run button all bronze-themed
- **Login page**: SClaw logo + 鹰爪·市场猎手 subtitle, bronze button, bronze focus rings
- **AI indicator**: Bronze glow when active, subtle bronze border when idle
- **Run button**: `btn-bronze` class
- **History tab**: Bronze dividers (`◇`), bronze code badges, bronze "Show all" button
- **Logs tab**: Bronze dividers, chat type in bronze, strategy type in bronze-dim
- **Backtest panel**: Bronze buttons, bronze strategy badges
- **Chat panel divider**: border-stock-border
- **Plugin panel**: Bronze "Active" badges, bronze category counts
- **Results table**: Bronze matched stocks count, bronze CSV hover
- **Results modal**: Bronze stock code links, bronze badges
- **Loading spinner**: Bronze dots
- **Watch alerts**: Bronze unread indicators, bronze hover states
- **All blue references removed** — 11 component files updated via sub-agent

## Remaining design assets in index.css
- `font-display`: DM Serif Display for headings
- `font-body`: Inter for UI text
- `font-mono`: JetBrains Mono for code
- `bronze-divider`: ◇ separator lines
- `tab-active`: bronze underline for active tabs
- `btn-bronze`: bronze button with hover effects
- `focus-bronze`: bronze focus ring for inputs
- `bg-bronze-glow`: translucent bronze background
- `shadow-bronze-sm`: subtle bronze shadow

## Files changed
- `src/App.tsx` — All gray/blue/bright-green → bronze/stock-text colors
- `src/index.css` — Bronze design tokens + custom utility classes (built earlier)
- `src/components/PluginPanel.tsx` — Blue badges → bronze
- `src/components/ResultsTable.tsx` — Blue text → bronze
- `src/components/ResultsModal.tsx` — Blue badges/links → bronze
- `src/components/DebugPanel.tsx` — Blue bg → bronze-glow
- `src/components/WatchAlertPanel.tsx` — Blue indicators → bronze
- `src/components/StrategyParamInput.tsx` — Blue buttons/focus → bronze
- `src/components/BacktestPanel.tsx` — Blue buttons/badges → bronze
- `src/components/LoadingSpinner.tsx` — Blue dots → bronze
- `src/components/StrategyConfig.tsx` — Blue buttons → bronze
- `src/components/ChatPanel.tsx` — Blue tool call badge → bronze
- `src/components/WatchAlertToast.tsx` — Blue hover → bronze

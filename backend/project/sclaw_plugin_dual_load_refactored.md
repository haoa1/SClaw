# Plugin dual-load refactoring — ✅ Complete

## Summary
Eliminated the dual plugin loading system by refactoring strategy-validator and strategy-generator to use PluginManager instead of their independent `require()`-based loader. All tools now load plugins through the PluginManager singleton wired from index.ts.

## What changed

### Directory layout
```
plugins/common/           ← Admin-shared, visible to ALL users
plugins/users/{userId}/   ← User-private, only visible to that user
plugins/backend/          ← Symlink → ../backend (for plugin import resolution)
```

### Files changed
- **backend/src/index.ts**: PluginManager now takes `(pluginsDir, usersPluginsDir)`. Added `setPluginManager()` wire-up for strategy tools.
- **backend/src/plugin-system/plugin-manager.ts**: Added 3 directory accessor methods: `getCommonPluginsDir()`, `getUsersPluginsRoot()`, `getUserPluginsDir(userId)`.
- **backend/src/tools/strategy-validator.ts**: Added `setPluginManager(pm)` singleton. `getPluginsForCurrentUser()` uses PluginManager + request-context for user-scoped plugin access. Fallback to independent loader when PluginManager not available (tests/backward compat).
- **backend/src/tools/strategy-generator.ts**: Uses `getTargetPluginsDir(userId?)` to write plugins to user-specific directory via PluginManager.
- **backend/src/tools/strategy.ts**: Added `promote(plugin_id)` subcommand — copies plugin from user dir to common dir, makes it available to ALL users.

### Symlink fix
Plugins import from `../../backend/src/types`. From `plugins/common/XXX/`, this resolves to `plugins/backend/src/types`. The symlink `plugins/backend → ../backend` makes this work.

## How to use
- **strategy(generate)**: Creates plugin in `plugins/users/{userId}/{pluginId}/`
- **strategy(promote, plugin_id="xxx")**: Copies from user dir to `plugins/common/{pluginId}/`
- **strategy(reload)**: Reloads all plugins (common + all loaded users)
- **list_strategies**: Shows user-scoped plugins (common + user's private)
- **Production**: Run with `npx tsx src/index.ts` (tsx handles .ts plugin loading)

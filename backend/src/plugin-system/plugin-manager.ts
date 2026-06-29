/**
 * PluginManager — dual-scope plugin system.
 *
 * Directory layout:
 *   plugins/common/           ← Admin-shared, visible to ALL users
 *   plugins/users/{userId}/   ← User-private, visible only to that user
 *
 * User plugins override common plugins with the same plugin ID.
 * Admin can promote a user plugin to common via promotePlugin().
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { StockScreenerPlugin } from '../types';

export class PluginManager extends EventEmitter {
  private commonDir: string;
  private userBaseDir: string;
  private commonPlugins: Map<string, StockScreenerPlugin> = new Map();
  // userId -> Map<pluginId, StockScreenerPlugin>
  private userPlugins: Map<string, Map<string, StockScreenerPlugin>> = new Map();
  private watcher: fs.FSWatcher | null = null;

  constructor(pluginsDir: string, userPluginsDir?: string) {
    super();
    this.commonDir = pluginsDir;
    this.userBaseDir = userPluginsDir || path.resolve(pluginsDir, '..', 'users');
  }

  // ===== Loading =====

  /** Load ALL common plugins from disk */
  async loadAll(): Promise<void> {
    this.commonPlugins.clear();
    await this.loadFromDir(this.commonDir, this.commonPlugins);
    console.log(`[PluginManager] Loaded ${this.commonPlugins.size} common plugins`);
    this.emit('common:loaded', this.commonPlugins.size);
  }

  /** Load plugins for a specific user (lazy — only loads once per user) */
  async loadForUser(userId: string): Promise<void> {
    if (this.userPlugins.has(userId)) return; // already loaded

    const userDir = path.join(this.userBaseDir, userId);
    const userMap = new Map<string, StockScreenerPlugin>();
    await this.loadFromDir(userDir, userMap);
    this.userPlugins.set(userId, userMap);

    if (userMap.size > 0) {
      console.log(`[PluginManager] Loaded ${userMap.size} user plugins for ${userId}`);
    }
    this.emit('user:loaded', userId, userMap.size);
  }

  /** Unload a user's plugins (e.g. after they generate a new one) */
  unloadUser(userId: string): void {
    this.userPlugins.delete(userId);
  }

  /** Force-reload a specific user's plugins */
  async reloadUser(userId: string): Promise<void> {
    this.userPlugins.delete(userId);
    await this.loadForUser(userId);
  }

  /** Reload all plugins (common + all loaded users) */
  async reloadAll(): Promise<void> {
    this.commonPlugins.clear();
    this.userPlugins.clear();
    await this.loadAll();
  }

  // ===== Accessors =====

  /** Get all common plugins (backward compat) */
  getAll(): StockScreenerPlugin[] {
    return Array.from(this.commonPlugins.values());
  }

  /** Get plugins visible to a specific user: common + user's private */
  getAllForUser(userId: string): StockScreenerPlugin[] {
    const merged = new Map<string, StockScreenerPlugin>();

    // Common plugins first
    for (const [id, plugin] of this.commonPlugins) {
      merged.set(id, plugin);
    }

    // User plugins override common ones with same ID
    const userMap = this.userPlugins.get(userId);
    if (userMap) {
      for (const [id, plugin] of userMap) {
        merged.set(id, plugin);
      }
    }

    return Array.from(merged.values());
  }

  /** Get a single plugin by ID (from common only) */
  get(pluginId: string): StockScreenerPlugin | undefined {
    return this.commonPlugins.get(pluginId);
  }

  /** Get a plugin for a specific user (checks user first, then common) */
  getForUser(userId: string, pluginId: string): StockScreenerPlugin | undefined {
    const userMap = this.userPlugins.get(userId);
    if (userMap && userMap.has(pluginId)) {
      return userMap.get(pluginId);
    }
    return this.commonPlugins.get(pluginId);
  }

  /** Check if a user has private plugins */
  hasUserPlugins(userId: string): boolean {
    const userMap = this.userPlugins.get(userId);
    return userMap !== undefined && userMap.size > 0;
  }

  // ===== Directory Accessor Methods =====

  /** Get the common plugins directory path */
  getCommonPluginsDir(): string {
    return this.commonDir;
  }

  /** Get the root directory for user-specific plugins */
  getUsersPluginsRoot(): string {
    return this.userBaseDir;
  }

  /** Get a specific user's plugins directory path */
  getUserPluginsDir(userId: string): string {
    return path.join(this.userBaseDir, userId);
  }

  // ===== File Operations =====

  /**
   * Create a plugin in the user's private directory.
   * Returns the output file path.
   */
  writePluginForUser(userId: string, pluginId: string, sourceCode: string): string {
    const userDir = path.join(this.userBaseDir, userId);
    fs.mkdirSync(userDir, { recursive: true });

    const pluginDir = path.join(userDir, pluginId);
    if (fs.existsSync(pluginDir)) {
      // Remove old plugin directory (replace with new version)
      this.removeDirSync(pluginDir);
    }
    fs.mkdirSync(pluginDir, { recursive: true });

    const outputPath = path.join(pluginDir, 'index.ts');
    fs.writeFileSync(outputPath, sourceCode, 'utf-8');
    return outputPath;
  }

  /**
   * Promote a user's private plugin to the common directory.
   * Moves it from plugins/users/{userId}/{pluginId}/ → plugins/common/{pluginId}/
   * Returns the new path on success, or error message string.
   */
  promotePlugin(userId: string, pluginId: string): string | null {
    const userPluginDir = path.join(this.userBaseDir, userId, pluginId);
    if (!fs.existsSync(userPluginDir)) {
      return `Plugin ${pluginId} not found in user ${userId}'s directory`;
    }

    const commonPluginDir = path.join(this.commonDir, pluginId);
    if (fs.existsSync(commonPluginDir)) {
      return `Plugin ${pluginId} already exists in common. Remove it first or use a different plugin ID.`;
    }

    try {
      // Move the directory
      fs.renameSync(userPluginDir, commonPluginDir);

      // Reload common plugins to pick up the new one
      return null; // success
    } catch (err) {
      return `Failed to promote plugin: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Delete a user's private plugin.
   */
  deleteUserPlugin(userId: string, pluginId: string): boolean {
    const pluginDir = path.join(this.userBaseDir, userId, pluginId);
    if (!fs.existsSync(pluginDir)) return false;

    this.removeDirSync(pluginDir);
    return true;
  }

  // ===== Internal =====

  /**
   * Load all plugins from a directory into a map.
   */
  private async loadFromDir(dir: string, target: Map<string, StockScreenerPlugin>): Promise<void> {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.loadSinglePlugin(dir, entry.name, target);
      }
    }
  }

  /**
   * Load a single plugin from {dir}/{dirName}/ into the target map.
   */
  private async loadSinglePlugin(
    dir: string,
    dirName: string,
    target: Map<string, StockScreenerPlugin>
  ): Promise<void> {
    const pluginDir = path.join(dir, dirName);
    const indexPath = path.join(pluginDir, 'index.ts');
    const indexJsPath = path.join(pluginDir, 'index.js');
    const packagePath = path.join(pluginDir, 'package.json');

    let entryPath: string | null = null;
    if (fs.existsSync(indexPath)) entryPath = indexPath;
    else if (fs.existsSync(indexJsPath)) entryPath = indexJsPath;
    else if (fs.existsSync(packagePath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
        if (pkg.main) {
          const mainPath = path.join(pluginDir, pkg.main);
          if (fs.existsSync(mainPath)) entryPath = mainPath;
        }
      } catch { /* ignore bad package.json */ }
    }

    if (!entryPath) return;

    try {
      // Register tsx loader to handle .ts files via require()
      try { require('tsx/cjs'); } catch { /* tsx not available, .ts files may fail */ }

      // Use dynamic import() instead of require() — handles .ts files with type annotations
      const pluginModule = await import(entryPath);
      const plugin = pluginModule.default || pluginModule;

      if (!this.validatePlugin(plugin)) {
        console.warn(`[PluginManager] Invalid plugin: ${dirName}`);
        return;
      }

      target.set(plugin.id, plugin as StockScreenerPlugin);
      console.log(`[PluginManager] Loaded: ${plugin.name} v${plugin.version} (${plugin.strategies.length} strategies)`);
      this.emit('plugin:loaded', plugin);
    } catch (err) {
      console.error(`[PluginManager] Failed to load ${dirName}:`, err);
    }
  }

  /**
   * Validate a plugin object has the required shape.
   */
  private validatePlugin(plugin: any): plugin is StockScreenerPlugin {
    if (!plugin || typeof plugin !== 'object') return false;
    if (!plugin.id || !plugin.name || !plugin.version) return false;
    if (!Array.isArray(plugin.strategies)) return false;
    for (const s of plugin.strategies) {
      if (!s.id || !s.name || typeof s.execute !== 'function') return false;
    }
    return true;
  }

  /**
   * Remove a directory and all its contents synchronously.
   */
  private removeDirSync(dirPath: string): void {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath)) {
      const fullPath = path.join(dirPath, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        this.removeDirSync(fullPath);
      } else {
        fs.unlinkSync(fullPath);
      }
    }
    fs.rmdirSync(dirPath);
  }

  // ===== Watching =====

  startWatching(): void {
    if (this.watcher) return;

    this.watcher = fs.watch(this.commonDir, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;
      const parts = filename.split(path.sep);
      const pluginDir = parts[0];

      setTimeout(async () => {
        const pluginDirPath = path.join(this.commonDir, pluginDir);
        if (!fs.existsSync(pluginDirPath) || !fs.statSync(pluginDirPath).isDirectory()) return;

        if (
          filename.endsWith('index.ts') ||
          filename.endsWith('index.js') ||
          filename.endsWith('package.json')
        ) {
          console.log(`[PluginManager] Detected change in common plugin: ${pluginDir}, reloading...`);

          // Remove old entry
          for (const [id, plugin] of this.commonPlugins) {
            if (plugin.id === pluginDir || pluginDir.includes(plugin.id)) {
              this.commonPlugins.delete(id);
              break;
            }
          }

          const temp = new Map<string, StockScreenerPlugin>();
          await this.loadSinglePlugin(this.commonDir, pluginDir, temp);
          for (const [id, p] of temp) {
            this.commonPlugins.set(id, p);
          }
        }
      }, 500);
    });

    console.log(`[PluginManager] Watching ${this.commonDir} for changes`);
    this.emit('watching:started');
  }

  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[PluginManager] Stopped watching');
      this.emit('watching:stopped');
    }
  }
}

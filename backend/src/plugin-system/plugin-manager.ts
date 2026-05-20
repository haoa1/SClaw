import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { StockScreenerPlugin } from '../types';

export class PluginManager extends EventEmitter {
  private pluginsDir: string;
  private plugins: Map<string, StockScreenerPlugin> = new Map();
  private watcher: fs.FSWatcher | null = null;

  constructor(pluginsDir: string) {
    super();
    this.pluginsDir = pluginsDir;
  }

  /** 扫描并加载所有插件 */
  async loadAll(): Promise<void> {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      console.log(`[PluginManager] Created plugins directory: ${this.pluginsDir}`);
      return;
    }

    const entries = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        await this.loadPlugin(entry.name);
      }
    }
    console.log(`[PluginManager] Loaded ${this.plugins.size} plugins`);
  }

  /** 加载单个插件 */
  async loadPlugin(dirName: string): Promise<StockScreenerPlugin | null> {
    const pluginDir = path.join(this.pluginsDir, dirName);
    const indexPath = path.join(pluginDir, 'index.ts');
    const indexJsPath = path.join(pluginDir, 'index.js');
    const packagePath = path.join(pluginDir, 'package.json');

    let entryPath: string | null = null;
    if (fs.existsSync(indexPath)) entryPath = indexPath;
    else if (fs.existsSync(indexJsPath)) entryPath = indexJsPath;
    else if (fs.existsSync(packagePath)) {
      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      if (pkg.main) {
        const mainPath = path.join(pluginDir, pkg.main);
        if (fs.existsSync(mainPath)) entryPath = mainPath;
      }
    }

    if (!entryPath) {
      console.warn(`[PluginManager] No entry found for plugin: ${dirName}`);
      return null;
    }

    try {
      // Clear require cache for hot reload
      const resolvedPath = require.resolve(entryPath);
      delete require.cache[resolvedPath];

      const pluginModule = require(entryPath);
      const plugin = pluginModule.default || pluginModule;

      if (!this.validatePlugin(plugin)) {
        console.warn(`[PluginManager] Invalid plugin: ${dirName}`);
        return null;
      }

      this.plugins.set(plugin.id, plugin as StockScreenerPlugin);
      console.log(`[PluginManager] Loaded plugin: ${plugin.name} v${plugin.version} (${plugin.strategies.length} strategies)`);
      this.emit('plugin:loaded', plugin);
      return plugin as StockScreenerPlugin;
    } catch (err) {
      console.error(`[PluginManager] Failed to load plugin ${dirName}:`, err);
      return null;
    }
  }

  /** 卸载插件 */
  unloadPlugin(pluginId: string): boolean {
    const removed = this.plugins.delete(pluginId);
    if (removed) {
      console.log(`[PluginManager] Unloaded plugin: ${pluginId}`);
      this.emit('plugin:unloaded', pluginId);
    }
    return removed;
  }

  /** 校验插件格式 */
  private validatePlugin(plugin: any): plugin is StockScreenerPlugin {
    if (!plugin || typeof plugin !== 'object') return false;
    if (!plugin.id || !plugin.name || !plugin.version) return false;
    if (!Array.isArray(plugin.strategies)) return false;
    for (const s of plugin.strategies) {
      if (!s.id || !s.name || typeof s.execute !== 'function') return false;
    }
    return true;
  }

  /** 获取所有插件 */
  getAll(): StockScreenerPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** 获取单个插件 */
  get(pluginId: string): StockScreenerPlugin | undefined {
    return this.plugins.get(pluginId);
  }

  /** 启动目录监听（热加载） */
  startWatching(): void {
    if (this.watcher) return;

    this.watcher = fs.watch(this.pluginsDir, { recursive: true }, async (eventType, filename) => {
      if (!filename) return;

      const parts = filename.split(path.sep);
      const pluginDir = parts[0];

      // 延迟等待文件写入完成
      setTimeout(async () => {
        const pluginDirPath = path.join(this.pluginsDir, pluginDir);
        if (!fs.existsSync(pluginDirPath) || !fs.statSync(pluginDirPath).isDirectory()) return;

        // 检查是否是入口文件变化
        if (
          filename.endsWith('index.ts') ||
          filename.endsWith('index.js') ||
          filename.endsWith('package.json')
        ) {
          console.log(`[PluginManager] Detected change in plugin: ${pluginDir}, reloading...`);
          this.unloadPlugin(pluginDir);
          await this.loadPlugin(pluginDir);
        }
      }, 500);
    });

    console.log(`[PluginManager] Watching ${this.pluginsDir} for changes`);
    this.emit('watching:started');
  }

  /** 停止目录监听 */
  stopWatching(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.log('[PluginManager] Stopped watching');
      this.emit('watching:stopped');
    }
  }
}

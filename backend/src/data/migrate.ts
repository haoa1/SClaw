/**
 * 数据迁移脚本 — 将现有JSON缓存导入SQLite
 *
 * 用法: npx tsx src/data/migrate.ts
 */

import * as path from 'path';
import { LocalDatabase } from './local-database';
import { DataManager } from './data-manager';

async function main() {
  console.log('=== 数据迁移脚本 ===\n');

  const dataDir = path.resolve(__dirname, '../../data');
  const db = new LocalDatabase(dataDir);

  const token = process.env.TUSHARE_TOKEN || '2f1bdb8c76da9b32cd3fd07968200666b6356aa03ec18a1c9f4a8bc3';
  const manager = new DataManager(db, {
    tushareToken: token,
    dataDir,
    migrateOnly: true,
  });

  // 1. 先迁移股票基本信息
  console.log('\n[Step 1] 同步股票名称...');
  const nameCount = await manager.syncStockNames();
  console.log(`  同步完成: ${nameCount} 只股票\n`);

  // 2. 迁移现有JSON缓存数据
  console.log('[Step 2] 迁移现有数据...');
  const rowCount = await manager.migrateExistingData();
  console.log(`  迁移完成: ${rowCount} 条记录\n`);

  // 3. 统计结果
  const stats = db.getStats();
  console.log('=== 数据库状态 ===');
  console.log(`  股票数量: ${stats.stocks}`);
  console.log(`  日K线记录: ${stats.dailyRecords}`);
  console.log(`  日期范围: ${stats.dateRange}`);
  console.log(`  数据库大小: ${stats.dbSizeMB} MB\n`);

  db.close();
  console.log('迁移完成!');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

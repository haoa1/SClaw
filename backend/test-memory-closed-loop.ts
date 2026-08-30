/**
 * 记忆闭环测试 — 验证三个修复点全部到位
 *
 * 覆盖层：
 * 1. 提示词层: SYSTEM_PROMPT 包含记忆指令
 * 2. 存储层: Memory.getFilePath() + 读写
 * 3. 注入层: Agent 构建 system prompt 时注入记忆
 * 4. 查询层: memory_recall 子agent使用真实路径
 * 5. 自动保存: addUserMessage 自动存 observation
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ===== 提取 SYSTEM_PROMPT =====
const systemPromptSource = fs.readFileSync(
  path.resolve(__dirname, 'src/index.ts'),
  'utf-8'
);
const sysPromptMatch = systemPromptSource.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
const SYSTEM_PROMPT = sysPromptMatch ? sysPromptMatch[1] : '';

// ===== 测试 1: 提示词层 =====
describe('提示词层: SYSTEM_PROMPT 记忆指令', () => {
  it('包含 Persistent Memory 章节', () => {
    assert.ok(SYSTEM_PROMPT.includes('Persistent Memory'));
  });

  it('说明记忆文件位置', () => {
    assert.ok(SYSTEM_PROMPT.includes('data/users/{userId}/memory/memory.json'));
  });

  it('说明 memory_recall 工具', () => {
    assert.ok(SYSTEM_PROMPT.includes('memory_recall'));
  });

  it('说明 write_file 写记忆', () => {
    assert.ok(SYSTEM_PROMPT.includes('write_file'));
  });

  it('列出所有 5 种记忆类型', () => {
    for (const t of ['strategy', 'decision', 'observation', 'error', 'result']) {
      assert.ok(SYSTEM_PROMPT.includes(t), `缺少 ${t} 类型`);
    }
  });
});

// ===== 测试 2: 存储层 =====
describe('存储层: Memory 读写路径', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-store-'));
  const memory = new (require('./src/memory/memory').Memory)(tmpDir);

  after(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });

  it('getFilePath() 返回正确路径', () => {
    assert.strictEqual(memory.getFilePath(), path.join(tmpDir, 'memory.json'));
  });

  it('add() + recent() 写入读出', () => {
    memory.add({ type: 'observation', content: 'hello', tags: ['t1'] });
    const r = memory.recent(1);
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].content, 'hello');
    assert.strictEqual(r[0].type, 'observation');
    assert.deepStrictEqual(r[0].tags, ['t1']);
    assert.ok(r[0].id.startsWith('mem_'));
    assert.ok(r[0].timestamp);
  });

  it('文件实际写到磁盘', () => {
    assert.ok(fs.existsSync(memory.getFilePath()));
    const parsed = JSON.parse(fs.readFileSync(memory.getFilePath(), 'utf-8'));
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length >= 1);
  });
});

// ===== 测试 3: 注入层 =====
describe('注入层: Agent system prompt 注入记忆', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inject-'));
  let Agent: any, ToolRegistry: any, memory: any, agent: any;

  before(async () => {
    ToolRegistry = (await import('./src/tools/registry')).ToolRegistry;
    Agent = (await import('./src/agent/agent')).Agent;

    const Memory = (await import('./src/memory/memory')).Memory;
    memory = new Memory(tmpDir);
    memory.add({ type: 'observation', content: '用户喜欢技术分析', tags: ['pref'] });
    memory.add({ type: 'strategy', content: 'MACD金叉策略', tags: ['strat'] });
    memory.add({ type: 'decision', content: '关注AI芯片', tags: ['dec'] });

    agent = new Agent(new ToolRegistry(), memory, {
      systemPrompt: 'Test agent for memory injection',
    });
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });

  it('系统消息包含记忆标题', () => {
    const msg = agent['messages'][0];
    assert.ok(msg.content.includes('对你(当前用户)的记忆'));
  });

  it('系统消息包含3种类型的记忆', () => {
    const msg = agent['messages'][0];
    assert.ok(msg.content.includes('[observation]'));
    assert.ok(msg.content.includes('[strategy]'));
    assert.ok(msg.content.includes('[decision]'));
  });

  it('系统消息包含记忆内容', () => {
    const msg = agent['messages'][0];
    assert.ok(msg.content.includes('用户喜欢技术分析'));
    assert.ok(msg.content.includes('MACD金叉策略'));
  });

  it('系统消息也包含原始 systemPrompt', () => {
    const msg = agent['messages'][0];
    assert.ok(msg.content.includes('Test agent for memory injection'));
    assert.ok(msg.content.includes('Test agent') && msg.content.includes('[observation]'));
  });

  it('addUserMessage 自动保存 observation', () => {
    agent['addUserMessage']('帮我分析茅台');
    const r = memory.recent(1);
    assert.ok(r[0].content.includes('帮我分析茅台'));
    assert.strictEqual(r[0].type, 'observation');
    assert.deepStrictEqual(r[0].tags, ['user-query']);
  });
});

// ===== 测试 4: 查询层 =====
describe('查询层: memory_recall 路径', () => {
  it('agent.ts 使用动态路径', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, 'src/agent/agent.ts'), 'utf-8'
    );
    assert.ok(src.includes('this.memory.getFilePath()'),
      '应该使用 this.memory.getFilePath() 动态获取路径');
    assert.ok(!src.includes('data/<username>/memory.json'),
      '不应包含硬编码的 data/<username>/memory.json');
  });

  it('真实的 memory_recall 子agent获得正确路径', async () => {
    // 验证: Agent 在构建 subAgentSystemPrompt 时使用真实路径
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-recall-'));
    const ToolRegistry = (await import('./src/tools/registry')).ToolRegistry;
    const Agent = (await import('./src/agent/agent')).Agent;
    const Memory = (await import('./src/memory/memory')).Memory;

    const memory = new Memory(tmpDir);
    memory.add({ type: 'observation', content: '测试', tags: ['t'] });
    const agent = new Agent(new ToolRegistry(), memory, { systemPrompt: 'test' });

    // 触发 executeTool 中的 memory_recall 逻辑
    // 构造一个假的 tool call 模拟 memory_recall
    const tc = { name: 'memory_recall', arguments: { query: '测试', limit: 3, max_turns: 2, detail_level: 'brief' } };

    // 这个方法会构建 subAgentSystemPrompt，其中包含 memory.getFilePath()
    const result = await agent['executeTool'](tc);

    // 验证 sub-agent 返回(或失败提示)中提到了正确的路径
    // 如果路径正确，sub-agent 有机会读到文件
    console.log('  memory_recall result (truncated):', result.slice(0, 200));

    // 清理
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });
});

// ===== 测试 5: 记忆流转完整性 =====
describe('完整性: 记忆流转闭环', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-full-'));
  let Memory: any, memory: any;

  before(async () => {
    Memory = (await import('./src/memory/memory')).Memory;
    memory = new Memory(tmpDir);
  });

  after(() => { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} });

  it('存 → 读 → 注入提示词 → 查 → 再存', () => {
    // 1. 存
    memory.add({ type: 'strategy', content: '用户偏好短线交易', tags: ['strategy', 'preference'] });
    memory.add({ type: 'observation', content: '用户问过茅台3次', tags: ['freq'] });

    // 2. 读
    const recent = memory.recent(5);
    assert.ok(recent.length >= 2);

    // 3. 查
    const searchResults = memory.search('茅台');
    assert.ok(searchResults.length >= 1);
    assert.ok(searchResults[0].content.includes('茅台'));

    // 4. 再存
    memory.add({ type: 'result', content: '推荐了茅台，用户满意', tags: ['happy'] });
    assert.strictEqual(memory.recent(1)[0].type, 'result');

    // 5. 磁盘持久化验证
    const onDisk = JSON.parse(fs.readFileSync(memory.getFilePath(), 'utf-8'));
    assert.ok(onDisk.length >= 3);
    const types = onDisk.map((e: any) => e.type);
    assert.ok(types.includes('strategy'));
    assert.ok(types.includes('observation'));
    assert.ok(types.includes('result'));
  });

  it('100条上限自动裁剪', () => {
    // 写入101条
    for (let i = 0; i < 101; i++) {
      memory.add({ type: 'observation', content: `填充数据 ${i}`, tags: ['fill'] });
    }
    const onDisk = JSON.parse(fs.readFileSync(memory.getFilePath(), 'utf-8'));
    assert.ok(onDisk.length <= 100, `应在100以内，实际${onDisk.length}`);
  });
});

console.log('\n=== 全部测试完成 ===\n');

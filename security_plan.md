# 股海操盘手安全加固计划

## 阶段 1：API Key 保护
**文件:** `backend/src/agent/llm.ts`
- [x] 构造函数读 key 后 `delete process.env["DEEPSEEK_API_KEY"]`
- [x] `delete process.env["OPENAI_API_KEY"]`

## 阶段 2：文件工具路径限制
**文件:** `backend/src/tools/file-tools.ts`
- [x] 定义 `PROJECT_ROOT` 和 `ALLOWED_PATHS`
- [x] `isPathAllowed()` — 校验目标路径在项目目录内
- [x] `BLOCKED_PATTERNS` — 禁止访问 .env /proc /etc /sys
- [x] 应用到 read_file, write_file
- [x] 应用到 glob (限制 cwd)
- [x] 应用到 grep (限制 path)

## 阶段 3：bash 工具防火墙
**文件:** `backend/src/tools/file-tools.ts`
- [x] 子进程环境清理（删除敏感变量）
- [x] 命令黑名单（rm -rf, fork bomb, curl|bash 等）
- [x] 输出打码（API key 模式匹配替换）

## 阶段 4：策略生成器防护
**文件:** `backend/src/tools/strategy-generator.ts`
- [x] `sanitizeExecuteFn()` — 禁止 process.env, require, child_process, eval, fetch 等
- [x] 路径遍历防护（pluginId 校验）

## 阶段 5：子代理权限收缩
**文件:** `backend/src/agent/agent.ts`
- [x] memory_recall 子代理只给 read_file + grep，去掉 bash 和 write_file

## 验证
- [x] TypeScript 编译无报错
- [x] 推送服务器
- [x] 重启服务并测试核心功能

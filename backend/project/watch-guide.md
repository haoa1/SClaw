# 👁️ 盯盘工具使用指南

## 工具名: `manage_watch`

一个工具、6个操作，管理所有实时监控任务。

---

## 1. 创建盯盘 (create)

```
条件: OR 逻辑（任一满足就报警）
```

| 条件类型 | 参数 | 示例 |
|:--------|:-----|:-----|
| 🔴 价格变动 | `direction`: up/down/either, `thresholdPercent`: 数值 | 跌超3% → `{"type":"price_change","direction":"down","thresholdPercent":3}` |
| 🔥 放量 | `ratio`: 量比倍数 | 量比超2倍 → `{"type":"volume_spike","ratio":2}` |
| 📊 价位突破 | `cross`: above/below, `price`: 价位 | 突破200元 → `{"type":"price_cross","cross":"above","price":200}` |
| 🏆 新高新低 | `period`: 52week, `direction`: high/low | 创52周新高 → `{"type":"new_high_low","period":"52week","direction":"high"}` |
| 🔗 复合条件 | `operator`: AND/OR, `conditions`: 条件数组 | 涨超5%且放量3倍 |

**示例：**
```
盯盘 博敏电子(603936)，监控跌超3%或量比超2倍
```

## 2. 查看盯盘 (list)

列出所有盯盘任务，含状态、股票数、条件、冷却时间。

## 3. 删除盯盘 (delete)

按 taskId 删除指定任务。

## 4. 启用/停用 (toggle)

按 taskId 启停，不改条件。

## 5. 查看上次报警 (result)

按 taskId 查看最近一次触发报警的记录。

## 6. 更新盯盘 (update)

按 taskId 修改监控股票、条件、间隔、冷却等参数。

---

## 盯盘建议参数

| 参数 | 默认值 | 说明 |
|:----|:-----:|:-----|
| `interval` | 60秒 | 固定间隔（当没有timeIntervals时使用） |
| `timeIntervals` | 无 | **分时段间隔**，可设置不同时段不同频率 |
| `cooldownSeconds` | 300秒(5分钟) | 防止重复报警，建议300~600秒 |

---

## 分时段间隔（timeIntervals）

支持不同交易时段设置不同的检查频率：

### 示例：早盘2分钟，下午30分钟

```json
[
  {"startTime":"09:30","endTime":"11:30","interval":120},
  {"startTime":"13:00","endTime":"15:00","interval":1800}
]
```

| 时段 | 频率 | 适用场景 |
|:----|:----:|:---------|
| 09:30~11:30 | 每2分钟（120s） | 早盘波动大，需要高频监控 |
| 13:00~15:00 | 每30分钟（1800s） | 下午震荡期，低频即可 |

### 其他常用配置

```
早盘密集监控：09:30~11:30 每1分钟
全天均衡监控：09:30~15:00 每5分钟
尾盘只盯关键点位：09:30~11:30 每5分钟，13:00~14:30 每10分钟，14:30~15:00 每1分钟
```

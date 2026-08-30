import json
with open("backend/data/chat/2.json") as f:
    data = json.load(f)
msgs = [m for m in data if m.get("role") == "assistant"]
for i, m in enumerate(msgs):
    c = m.get("content","")[:120]
    if any(k in c for k in ["选股","分析","打板","筹码","缠论","涨停","报告","模板","推理","推断","记忆","reason"]):
        print(f"#{i}: {c}")

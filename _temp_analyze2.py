import json
with open("backend/data/chat/2.json") as f:
    data = json.load(f)

# Find the last stock analysis message (long assistant messages with reasoning)
msgs = [(i, m) for i, m in enumerate(data) if m.get("role") == "assistant"]
for i, m in msgs[-10:]:
    c = m.get("content", "")
    if len(c) > 200:
        print(f"=== MSG #{i} ({len(c)} chars) ===")
        # Show the start - look for reasoning structure
        print(c[:300])
        print("...")
        print()

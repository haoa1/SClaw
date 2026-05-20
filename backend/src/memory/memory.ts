import * as fs from "fs";
import * as path from "path";

export interface MemoryEntry {
  id: string;
  timestamp: string;
  type: "strategy" | "decision" | "observation" | "error" | "result";
  content: string;
  tags: string[];
}

export class Memory {
  private entries: MemoryEntry[] = [];
  private filePath: string;
  private maxEntries: number = 100;

  constructor(memoryDir: string) {
    this.filePath = path.join(memoryDir, "memory.json");
    this.load();
  }

  add(entry: Omit<MemoryEntry, "id" | "timestamp">): string {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: MemoryEntry = {
      id,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
    return id;
  }

  search(query: string, limit: number = 5): MemoryEntry[] {
    const q = query.toLowerCase();
    const scored = this.entries
      .map((e) => {
        let score = 0;
        const text = `${e.content} ${e.tags.join(" ")} ${e.type}`.toLowerCase();
        if (text.includes(q)) score += 10;
        for (const word of q.split(/\s+/)) {
          if (text.includes(word)) score += 3;
        }
        return { entry: e, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => s.entry);
  }

  recent(limit: number = 10): MemoryEntry[] {
    return this.entries.slice(-limit).reverse();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        this.entries = JSON.parse(data);
      }
    } catch {
      this.entries = [];
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8");
    } catch {
      // silently fail on save errors
    }
  }
}

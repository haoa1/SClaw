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

  /** Compute text similarity (handles both English and CJK) */
  private static textSimilarity(a: string, b: string): number {
    // For CJK text: use character bigram containment
    const hasCJK = (s: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);
    if (hasCJK(a) || hasCJK(b)) {
      // Character bigram containment (intersection / min) to handle length differences
      // e.g., "做短线" ⊆ "我偏好做短线止损5%"
      const bigramsA = new Set<string>();
      const bigramsB = new Set<string>();
      for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
      for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
      if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
      let intersection = 0;
      for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
      const smaller = Math.min(bigramsA.size, bigramsB.size);
      return smaller === 0 ? 0 : intersection / smaller;
    }
    // English text: word-level containment
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
    if (wordsA.size === 0 || wordsB.size === 0) return 0;
    let intersection = 0;
    for (const w of wordsA) if (wordsB.has(w)) intersection++;
    const smaller = Math.min(wordsA.size, wordsB.size);
    return smaller === 0 ? 0 : intersection / smaller;
  }

  /** Merge two tag arrays (deduped union) */
  private static mergeTags(oldTags: string[], newTags: string[]): string[] {
    return Array.from(new Set([...oldTags, ...newTags]));
  }

  add(entry: Omit<MemoryEntry, "id" | "timestamp">): string {
    const now = new Date().toISOString();

    // Dedup: check existing entries of same type for high similarity
    const SIMILARITY_THRESHOLD = 0.6;
    for (const existing of this.entries) {
      if (existing.type !== entry.type) continue;
      const sim = Memory.textSimilarity(existing.content, entry.content);
      if (sim >= SIMILARITY_THRESHOLD) {
        // Update existing entry (refresh timestamp, merge tags, update content)
        existing.timestamp = now;
        existing.content = entry.content;
        if (entry.tags && entry.tags.length > 0) {
          existing.tags = Memory.mergeTags(existing.tags, entry.tags);
        }
        this.save();
        return existing.id;
      }
    }

    // No duplicate found — add new entry
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: MemoryEntry = {
      id,
      timestamp: now,
      ...entry,
    };
    this.entries.push(full);
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }
    this.save();
    return id;
  }

  /** Update an existing entry by ID (partial update: content, tags, timestamp) */
  update(id: string, updates: { content?: string; tags?: string[]; type?: MemoryEntry["type"] }): boolean {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx === -1) return false;
    const entry = this.entries[idx];
    if (updates.type) entry.type = updates.type;
    if (updates.content !== undefined) entry.content = updates.content;
    if (updates.tags) entry.tags = updates.tags;
    entry.timestamp = new Date().toISOString();
    this.save();
    return true;
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

  /** Get the full path to the memory file on disk */
  getFilePath(): string {
    return this.filePath;
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

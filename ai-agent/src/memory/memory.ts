import * as fs from "fs";
import * as path from "path";
export class Memory {
  private entries: any[] = [];
  private filePath: string;
  constructor(memoryDir: string) {
    this.filePath = path.join(memoryDir, "memory.json");
    try { if (fs.existsSync(this.filePath)) this.entries = JSON.parse(fs.readFileSync(this.filePath, "utf-8")); } catch { this.entries = []; }
  }
  add(entry: any): string {
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.entries.push({ id, timestamp: new Date().toISOString(), ...entry });
    if (this.entries.length > 100) this.entries = this.entries.slice(-100);
    try { fs.mkdirSync(path.dirname(this.filePath), { recursive: true }); fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), "utf-8"); } catch {}
    return id;
  }
  search(query: string, limit = 5): any[] {
    const q = query.toLowerCase();
    return this.entries.map((e: any) => {
      let score = 0; const text = `${e.content} ${(e.tags||[]).join(" ")} ${e.type||""}`.toLowerCase();
      if (text.includes(q)) score += 10;
      for (const w of q.split(/\s+/)) { if (text.includes(w)) score += 3; }
      return { entry: e, score };
    }).filter((s: any) => s.score > 0).sort((a: any, b: any) => b.score - a.score).slice(0, limit).map((s: any) => s.entry);
  }
  recent(limit = 10): any[] { return this.entries.slice(-limit).reverse(); }
}

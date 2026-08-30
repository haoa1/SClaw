/**
 * Memory Organization — daily dedup/merge/cleanup task.
 *
 * Runs daily via cron. For each user:
 * 1. Loads all memory entries
 * 2. Finds similar entries within same type (textSimilarity >= 0.6)
 * 3. Merges newer into older (keep latest content, union tags)
 * 4. Limits max entries per type (prevents unbounded growth)
 */

import * as fs from "fs";
import * as path from "path";
import { MemoryEntry } from "./memory";

/** Text similarity — containment-aware for length differences */
function textSimilarity(a: string, b: string): number {
  const hasCJK = (s: string) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(s);
  if (hasCJK(a) || hasCJK(b)) {
    const bigramsA = new Set<string>();
    const bigramsB = new Set<string>();
    for (let i = 0; i < a.length - 1; i++) bigramsA.add(a.slice(i, i + 2));
    for (let i = 0; i < b.length - 1; i++) bigramsB.add(b.slice(i, i + 2));
    if (bigramsA.size === 0 || bigramsB.size === 0) return 0;
    let intersection = 0;
    for (const bg of bigramsA) if (bigramsB.has(bg)) intersection++;
    // Use containment (intersection / min) to handle length differences
    // e.g., "做短线持股不超过3天" ⊆ "我偏好做短线持股不超过3天止损5%"
    const smaller = Math.min(bigramsA.size, bigramsB.size);
    return smaller === 0 ? 0 : intersection / smaller;
  }
  const wordsA = new Set(a.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.toLowerCase().split(/\s+/).filter(w => w.length > 1));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const smaller = Math.min(wordsA.size, wordsB.size);
  return smaller === 0 ? 0 : intersection / smaller;
}

const SIMILARITY_THRESHOLD = 0.65;

/** Max entries per type — prevent unbounded growth */
const MAX_PER_TYPE: Record<string, number> = {
  observation: 100,
  strategy: 50,
  decision: 50,
  result: 50,
  error: 20,
};

/**
 * Organize memory for a single user.
 * Runs dedup + merge + limit in one pass.
 */
export function organizeUserMemory(memoryPath: string): { removed: number; merged: number } {
  if (!fs.existsSync(memoryPath)) {
    return { removed: 0, merged: 0 };
  }

  let entries: MemoryEntry[];
  try {
    entries = JSON.parse(fs.readFileSync(memoryPath, "utf-8"));
  } catch {
    return { removed: 0, merged: 0 };
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return { removed: 0, merged: 0 };
  }

  let merged = 0;
  let removed = 0;

  // Sort by timestamp (oldest first) so we merge newer into parent
  entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  // Phase 1: Dedup — find similar entries of same type, merge into first occurrence
  const keep: MemoryEntry[] = [];
  const consumed = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    if (consumed.has(entries[i].id)) continue;

    const anchor = entries[i];
    const mergedTags = new Set(anchor.tags);

    for (let j = i + 1; j < entries.length; j++) {
      if (consumed.has(entries[j].id)) continue;
      if (entries[j].type !== anchor.type) continue;

      const sim = textSimilarity(anchor.content, entries[j].content);
      if (sim >= SIMILARITY_THRESHOLD) {
        // Merge: use newer content, union tags
        consumed.add(entries[j].id);
        merged++;

        // Keep the entry with more content (usually the newer one has more details)
        if (entries[j].content.length > anchor.content.length) {
          anchor.content = entries[j].content;
          anchor.timestamp = entries[j].timestamp;
        } else {
          anchor.timestamp = entries[j].timestamp; // update to newest timestamp
        }
        for (const tag of entries[j].tags) {
          mergedTags.add(tag);
        }
      }
    }

    anchor.tags = Array.from(mergedTags);
    keep.push(anchor);
  }

  // Phase 2: Limit per type
  const byType = new Map<string, MemoryEntry[]>();
  for (const entry of keep) {
    const list = byType.get(entry.type) || [];
    list.push(entry);
    byType.set(entry.type, list);
  }

  const final: MemoryEntry[] = [];
  for (const [type, list] of byType) {
    // Sort by recency for limiting (keep newest)
    list.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const max = MAX_PER_TYPE[type] || 100;
    if (list.length > max) {
      removed += list.length - max;
      final.push(...list.slice(0, max));
    } else {
      final.push(...list);
    }
  }

  // Save if anything changed
  if (merged > 0 || removed > 0) {
    fs.writeFileSync(memoryPath, JSON.stringify(final, null, 2), "utf-8");
  }

  return { removed, merged };
}

/**
 * Organize memory for all users.
 * Scans all users memory files
 */
export function organizeAllUsersMemory(dataDir: string): { totalRemoved: number; totalMerged: number; userCount: number } {
  const usersDir = path.join(dataDir, "users");
  if (!fs.existsSync(usersDir)) {
    return { totalRemoved: 0, totalMerged: 0, userCount: 0 };
  }

  let totalRemoved = 0;
  let totalMerged = 0;
  let userCount = 0;

  const userIds = fs.readdirSync(usersDir);
  for (const userId of userIds) {
    const memoryPath = path.join(usersDir, userId, "memory", "memory.json");
    if (!fs.existsSync(memoryPath)) continue;

    const result = organizeUserMemory(memoryPath);
    if (result.merged > 0 || result.removed > 0) {
      console.log(`[MemoryOrganize] User ${userId}: merged ${result.merged}, removed ${result.removed}`);
    }
    totalRemoved += result.removed;
    totalMerged += result.merged;
    userCount++;
  }

  return { totalRemoved, totalMerged, userCount };
}

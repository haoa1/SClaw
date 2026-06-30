import { ToolRegistry } from "./registry";
import * as fs from "fs"; import * as path from "path"; import { execSync } from "child_process";
export function registerFileTools(registry: ToolRegistry): void {
  registry.register("read_file", async (a: any) => { try { return fs.readFileSync(a.file_path, "utf-8"); } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } });
  registry.register("write_file", async (a: any) => { try { fs.mkdirSync(path.dirname(a.file_path), { recursive: true }); fs.writeFileSync(a.file_path, a.content, "utf-8"); return "OK"; } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "write_file", description: "Write a file", parameters: { type: "object", properties: { file_path: { type: "string" }, content: { type: "string" } }, required: ["file_path", "content"] } });
  registry.register("bash", async (a: any) => { try { return execSync(a.command, { timeout: 30000, encoding: "utf-8" }); } catch (e: any) { return `Error: ${e.message}`; } },
    { name: "bash", description: "Run bash command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } });
  registry.register("glob", async (a: any) => { try { return execSync(`find ${a.path||'.'} -name "${a.pattern}" -not -path "*/node_modules/*" 2>/dev/null | head -50`, { encoding: "utf-8" }); } catch { return ""; } },
    { name: "glob", description: "Find files", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } });
  registry.register("grep", async (a: any) => { try { return execSync(`grep -r "${a.pattern}" ${a.path||'.'} --include="*.ts" --include="*.js" 2>/dev/null | head -100`, { encoding: "utf-8" }); } catch { return ""; } },
    { name: "grep", description: "Search files", parameters: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } });
}

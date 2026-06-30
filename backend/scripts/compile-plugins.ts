/**
 * Compile all plugin .ts files to .js using tsx.
 * Run: npx tsx scripts/compile-plugins.ts
 */
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const pluginDirs = [
  '/root/sclaw/plugins/common',
  '/root/sclaw/plugins/users',
];

function compilePlugins(dir: string): void {
  const items = fs.readdirSync(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    if (!fs.statSync(fullPath).isDirectory()) continue;

    const tsFile = path.join(fullPath, 'index.ts');
    const jsFile = path.join(fullPath, 'index.js');

    if (fs.existsSync(tsFile) && !fs.existsSync(jsFile)) {
      try {
        // Try using tsx to compile the .ts to .js
        // tsx can't directly compile, so we'll use a different approach:
        // Read the .ts file, strip TypeScript syntax, write .js
        const content = fs.readFileSync(tsFile, 'utf-8');
        
        // Simple approach: remove type annotations and import/export
        let jsContent = content
          // Remove type annotations after variable names: `const x: Type =` -> `const x =`
          .replace(/(\b\w+)\s*:\s*(\w+(?:<[^>]*>)?(?:\s*\|\s*\w+(?:<[^>]*>)?)*)\s*(?=[=;,)])/g, '$1')
          // Remove import statements
          .replace(/import\s+.*?from\s+['"][^'"]+['"]\s*;?\n?/g, '')
          // Remove export default -> module.exports
          .replace(/\bexport\s+default\s+/g, 'module.exports = ')
          // Remove export { ... }
          .replace(/\bexport\s+\{[^}]*\}\s*;?\n?/g, '')
          // Remove type imports like `import { Type } from '...'`
          .replace(/^import\s+type\s+.*$/gm, '')
          // Remove interface declarations
          .replace(/^interface\s+\w+[^{]*\{[^}]*\}\s*$/gm, '')
          // Remove `as const` 
          .replace(/\s+as\s+const/g, '')
          // Remove type annotations in function params: `(data: StockData[])` -> `(data)`
          .replace(/\(([^)]*)\)\s*(?::\s*\w+(?:<[^>]*>)?)?\s*\{/g, (match, params) => {
            const cleaned = params.replace(/(\b\w+)\s*:\s*[^,)]+/g, '$1');
            return `(${cleaned}) {`;
          });
        
        fs.writeFileSync(jsFile, jsContent, 'utf-8');
        const size = fs.statSync(jsFile).size;
        console.log(`  Compiled: ${item}/index.ts -> index.js (${size} bytes)`);
      } catch (e: any) {
        console.error(`  FAILED: ${item}: ${e.message}`);
      }
    }
  }
}

console.log('Compiling plugins...');
for (const d of pluginDirs) {
  if (fs.existsSync(d)) {
    console.log(`Scanning: ${d}`);
    compilePlugins(d);
  }
}
console.log('Done!');

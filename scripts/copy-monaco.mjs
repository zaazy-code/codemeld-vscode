import { access, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const source = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const target = path.join(root, 'dist', 'monaco', 'vs');

try {
  await access(source);
} catch {
  console.error(`Monaco runtime was not found at: ${source}`);
  console.error('Run npm install before packaging CodeMeld.');
  process.exit(1);
}

await rm(target, { recursive: true, force: true });
await mkdir(path.dirname(target), { recursive: true });
await cp(source, target, { recursive: true });

console.log(`Copied Monaco runtime to ${path.relative(root, target)}`);

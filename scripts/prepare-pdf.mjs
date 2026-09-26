import { cpSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const target = new URL(`../public/pdfjs/${folder}/`, import.meta.url);
  mkdirSync(target, { recursive: true });
  cpSync(join(root, folder), target, { recursive: true });
}
console.log('PDF offline resources ready.');

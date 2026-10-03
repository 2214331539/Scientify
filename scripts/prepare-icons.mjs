import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// Tauri 2's CachedIcon uses ICO entry 0 for the runtime window icon.
// Keep original PNG payloads, but put the highest-resolution frame first.
const source = new URL('../src-tauri/icons/source/', import.meta.url);
const original = readFileSync(new URL('scientify.ico', source));
if (original.readUInt16LE(0) !== 0 || original.readUInt16LE(2) !== 1)
  throw new Error('Expected a Windows ICO source.');
const frames = new Map();
for (let i = 0; i < original.readUInt16LE(4); i++) {
  const offset = 6 + 16 * i;
  const size = original[offset] || 256;
  const length = original.readUInt32LE(offset + 8);
  const start = original.readUInt32LE(offset + 12);
  if (start + length > original.length) throw new Error('Truncated ICO frame.');
  frames.set(size, original.subarray(start, start + length));
}
for (const size of [96, 192])
  frames.set(size, readFileSync(new URL(`scientify-${size}.png`, source)));
const ordered = [...frames].sort(([a], [b]) => b - a);
const header = Buffer.alloc(6 + 16 * ordered.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(ordered.length, 4);
let position = header.length;
ordered.forEach(([size, png], i) => {
  if (
    png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
    png.readUInt32BE(16) !== size ||
    png.readUInt32BE(20) !== size
  )
    throw new Error(`Invalid ${size}px PNG frame.`);
  const offset = 6 + 16 * i;
  header[offset] = header[offset + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, offset + 4);
  header.writeUInt16LE(32, offset + 6);
  header.writeUInt32LE(png.length, offset + 8);
  header.writeUInt32LE(position, offset + 12);
  position += png.length;
});
if (ordered[0]?.[0] !== 256) throw new Error('The runtime icon must start with a 256px frame.');
const output = new URL('../src-tauri/icons/icon.ico', import.meta.url);
const bytes = Buffer.concat([header, ...ordered.map(([, png]) => png)]);
if (!existsSync(output) || !readFileSync(output).equals(bytes)) writeFileSync(output, bytes);
console.log(
  `Windows icon ready: ${ordered.map(([size]) => size).join(', ')}px; original PNG frames preserved.`,
);

// ICNS accepts the same lossless PNG payloads; no image conversion is needed.
const chunks = [
  [128, 'ic07'],
  [256, 'ic08'],
].map(([size, type]) => {
  const png = frames.get(size);
  if (!png) throw new Error(`Missing ${size}px macOS icon frame`);
  const chunk = Buffer.alloc(8);
  chunk.write(type, 0, 'ascii');
  chunk.writeUInt32BE(8 + png.length, 4);
  return Buffer.concat([chunk, png]);
});
const icns = Buffer.alloc(8);
icns.write('icns', 0, 'ascii');
icns.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
writeFileSync(
  new URL('../src-tauri/icons/icon.icns', import.meta.url),
  Buffer.concat([icns, ...chunks]),
);
writeFileSync(new URL('../src-tauri/icons/icon.png', import.meta.url), frames.get(256));

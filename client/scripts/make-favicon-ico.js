#!/usr/bin/env node
/**
 * Wraps public/favicon.png in an .ico container.
 *
 * The site declares SVG and PNG icons in <head>, which every current browser
 * honours. Crawlers are the problem: Google asks for /favicon.ico by name
 * before reading the HTML, and because no such file existed, the SPA catch-all
 * answered with index.html -- HTTP 200, content-type text/html. Not a 404 that
 * would fall back to the declared icons, but a valid response that is not an
 * image, so the result was no icon beside the search result and nothing in the
 * logs suggesting why.
 *
 * No dependency, because ICO is a container and this is the one case where it
 * costs nothing: since Vista the format may hold a PNG verbatim, so the file is
 * a 22-byte header followed by the bytes already on disk. Pulling in an image
 * library to concatenate two buffers is not a trade worth making.
 *
 *   ICONDIR        6 bytes   reserved, type=1 (icon), image count
 *   ICONDIRENTRY  16 bytes   dimensions, colour info, payload size and offset
 *   payload                  the PNG, unmodified
 *
 * Dimensions are read from the PNG's IHDR rather than assumed, so re-running
 * this after changing the source icon stays correct. 256 is encoded as 0, which
 * is the format's way of saying "not 1-255".
 */

// ESM, because client/package.json sets "type": "module" and a .js file there
// is parsed as one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SRC = path.join(PUBLIC_DIR, 'favicon.png');
const OUT = path.join(PUBLIC_DIR, 'favicon.ico');

const png = fs.readFileSync(SRC);

// PNG signature is 8 bytes, then the IHDR chunk: 4 length + 4 type, then the
// width and height as big-endian 32-bit integers.
if (png.readUInt32BE(0) !== 0x89504e47) {
  console.error(`${SRC} is not a PNG.`);
  process.exit(1);
}
const width = png.readUInt32BE(16);
const height = png.readUInt32BE(20);

if (width > 256 || height > 256) {
  console.error(`ICO cannot hold ${width}x${height}; 256x256 is the maximum.`);
  process.exit(1);
}

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);   // reserved
header.writeUInt16LE(1, 2);   // 1 = icon (2 would be a cursor)
header.writeUInt16LE(1, 4);   // one image in this file

const entry = Buffer.alloc(16);
entry.writeUInt8(width === 256 ? 0 : width, 0);
entry.writeUInt8(height === 256 ? 0 : height, 1);
entry.writeUInt8(0, 2);       // palette size; 0 for truecolour
entry.writeUInt8(0, 3);       // reserved
entry.writeUInt16LE(1, 4);    // colour planes
entry.writeUInt16LE(32, 6);   // bits per pixel
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);  // payload offset: 6 header + 16 entry

fs.writeFileSync(OUT, Buffer.concat([header, entry, png]));

console.log(`favicon.ico written: ${width}x${height}, ${fs.statSync(OUT).size} bytes`);

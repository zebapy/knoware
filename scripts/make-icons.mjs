// Draws the pixel-blob app icon and tray frames as PNGs, with no dependencies.
// Usage: node scripts/make-icons.mjs && npx tauri icon src-tauri/icons/app-icon.png
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};
function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const TEAL = ['#2b7f9e', '#3fb8c4', '#7fe3dc', '#5a8cf0'];
const AMBER = ['#c46a2c', '#f2b24c', '#ffe08a', '#f07a5a'];
const INK = '#0b0c1c';

// A 16x16 blob sprite: returns a hex color or null for each cell.
function sprite(pal, { dy = 0, squash = 0, bang = false } = {}) {
  return (x, y) => {
    const cx = 7.5, cy = 9.5 + dy, rx = 7 + squash, ry = 5.6 - squash;
    const ex = (x - cx) / rx, ey = (y - cy) / ry, d = ex * ex + ey * ey;
    if (bang && x >= 7 && x <= 8 && (y <= 1 + dy || y === 3 + dy) && y >= 0) return pal[2];
    if (d > 1) return null;
    if (d > 0.7) return INK;
    const eyeY = Math.round(cy - 1);
    if ((x === 5 || x === 10) && (y === eyeY || y === eyeY + 1)) return INK;
    if ((x === 3 || x === 4) && y === eyeY - 2) return '#e8f6ff';
    // Diagonal 4-tone shimmer bands, like the in-app palette cycling.
    const band = Math.floor((x + y) / 3) % 4;
    const c = pal[[1, 2, 1, 0][band]];
    return y > cy + 2 ? mix(c, INK, 0.3) : c;
  };
}
const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');

function render(size, cell, bg, area = size, offset = 0) {
  const scale = area / 16;
  return png(size, (x, y) => {
    const sx = (x - offset) / scale, sy = (y - offset) / scale;
    const c = sx >= 0 && sy >= 0 && sx < 16 && sy < 16 ? cell(Math.floor(sx), Math.floor(sy)) : null;
    if (c) return [...hex(c), 255];
    return bg ? bg(x, y) : [0, 0, 0, 0];
  });
}

const dir = 'src-tauri/icons/';
const appBg = (x, y) => {
  const s = 1024, r = 200, m = 64;
  const qx = Math.max(m + r - x, x - (s - m - r), 0), qy = Math.max(m + r - y, y - (s - m - r), 0);
  if (x < m || y < m || x >= s - m || y >= s - m || qx * qx + qy * qy > r * r) return [0, 0, 0, 0];
  return [...hex(y < 512 ? '#151834' : '#1a1c3c'), 255];
};
writeFileSync(dir + 'app-icon.png', render(1024, sprite(TEAL), appBg, 704, 160));
writeFileSync(dir + 'tray.png', render(32, sprite(TEAL)));
writeFileSync(dir + 'tray-alert-a.png', render(32, sprite(AMBER, { dy: 0, squash: 0.6, bang: true })));
writeFileSync(dir + 'tray-alert-b.png', render(32, sprite(AMBER, { dy: -2, bang: true })));
console.log('icons written to', dir);

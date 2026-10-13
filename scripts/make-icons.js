// Генерирует PNG-иконки приложения (домик с сердцем) без внешних зависимостей.
// Запуск: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [15, 118, 110];
const FG = [255, 255, 255];
const HEART = [241, 70, 53];

// Фигуры в координатах 0..1; содержимое в центральных 60% — безопасная зона для maskable-иконок
const inPoly = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const roof = [[0.5, 0.2], [0.8, 0.47], [0.2, 0.47]];
const body = [[0.27, 0.45], [0.73, 0.45], [0.73, 0.78], [0.27, 0.78]];
const inHeart = (x, y) => {
  // сердце по центру дома
  const s = 0.13;
  const u = (x - 0.5) / s;
  const v = (0.6 - y) / s + 0.25;
  return Math.pow(u * u + v * v - 1, 3) - u * u * v * v * v <= 0;
};

function color(x, y) {
  if (inHeart(x, y)) return HEART;
  if (inPoly(x, y, roof) || inPoly(x, y, body)) return FG;
  return BG;
}

function render(size) {
  const SS = 4; // сглаживание
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = color((px + (sx + 0.5) / SS) / size, (py + (sy + 0.5) / SS) / size);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const n = SS * SS;
      raw[o] = Math.round(r / n);
      raw[o + 1] = Math.round(g / n);
      raw[o + 2] = Math.round(b / n);
      raw[o + 3] = 255;
    }
  }
  return png(size, size, raw);
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
  fs.writeFileSync(path.join(out, name), render(size));
  console.log('icons/' + name);
}

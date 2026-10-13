'use strict';

// Gera os icones do app (PNG RGBA) sem dependencias: escudo verde com um "check" branco
// sobre fundo #101418. Anti-aliasing por supersampling 4x4.
//   app/icon.png       80x80
//   app/largeIcon.png  130x130
//   app/splash.png     1920x1080 (escudo de ~360 px centralizado)

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const APP_DIR = path.join(__dirname, '..', 'app');

const BACKGROUND = [0x10, 0x14, 0x18];
const SHIELD_LIGHT = [0x2e, 0xcc, 0x71]; // metade esquerda
const SHIELD_DARK = [0x27, 0xae, 0x60]; // metade direita
const CHECK = [0xff, 0xff, 0xff];
const SUBSAMPLES = 4;

// --- PNG ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // filtros adaptativos padrao
  ihdr[12] = 0; // sem entrelacamento

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filtro "None"
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- Geometria (escudo no espaco 24x24 do icone "shield" do Material) ---

function cubic(p0, p1, p2, p3, steps) {
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push([
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return pts;
}

// M12 1 L21 5 V11 C21 16.55 17.16 21.74 12 23 C6.84 21.74 3 16.55 3 11 V5 Z
const SHIELD = [
  [12, 1],
  [21, 5],
  [21, 11],
  ...cubic([21, 11], [21, 16.55], [17.16, 21.74], [12, 23], 32),
  ...cubic([12, 23], [6.84, 21.74], [3, 16.55], [3, 11], 32),
  [3, 5],
];
const SHIELD_TOP = 1;
const SHIELD_BOTTOM = 23;
const SHIELD_CENTER = [12, 12];

const CHECK_POINTS = [[7.6, 12.3], [10.6, 15.3], [16.6, 9.3]];
const CHECK_HALF_WIDTH = 1.25;

// Intervalos [x0, x1) dentro do poligono na linha y (regra par-impar).
function rowSpans(poly, y) {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if ((a[1] <= y && b[1] > y) || (b[1] <= y && a[1] > y)) {
      xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
  }
  xs.sort((p, q) => p - q);
  const spans = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
  return spans;
}

function inSpans(spans, x) {
  for (const s of spans) if (x >= s[0] && x < s[1]) return true;
  return false;
}

function distToSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - px;
  const ey = a[1] + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function inCheck(x, y) {
  for (let i = 0; i + 1 < CHECK_POINTS.length; i++) {
    if (distToSegment(x, y, CHECK_POINTS[i], CHECK_POINTS[i + 1]) <= CHECK_HALF_WIDTH) return true;
  }
  return false;
}

// --- Rasterizacao ---

function createImage(width, height, color) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

// Desenha o escudo com altura `size` px centrado em (cx, cy).
function drawShield(img, cx, cy, size) {
  const scale = size / (SHIELD_BOTTOM - SHIELD_TOP);
  const toShieldX = (px) => (px - cx) / scale + SHIELD_CENTER[0];
  const toShieldY = (py) => (py - cy) / scale + SHIELD_CENTER[1];
  const x0 = Math.max(0, Math.floor(cx - size / 2));
  const x1 = Math.min(img.width, Math.ceil(cx + size / 2));
  const y0 = Math.max(0, Math.floor(cy - size / 2));
  const y1 = Math.min(img.height, Math.ceil(cy + size / 2));
  const n = SUBSAMPLES;

  for (let py = y0; py < y1; py++) {
    const rows = [];
    for (let sy = 0; sy < n; sy++) {
      const y = toShieldY(py + (sy + 0.5) / n);
      rows.push({ y, spans: rowSpans(SHIELD, y) });
    }
    for (let px = x0; px < x1; px++) {
      let light = 0;
      let dark = 0;
      let check = 0;
      for (const row of rows) {
        for (let sx = 0; sx < n; sx++) {
          const x = toShieldX(px + (sx + 0.5) / n);
          if (!inSpans(row.spans, x)) continue;
          if (inCheck(x, row.y)) check++;
          else if (x < SHIELD_CENTER[0]) light++;
          else dark++;
        }
      }
      if (light + dark + check === 0) continue;
      // Media ponderada das amostras (cobertura de cada cor) sobre o fundo atual.
      const total = n * n;
      const rest = total - light - dark - check;
      const i = (py * img.width + px) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const sum = img.data[i + ch] * rest + SHIELD_LIGHT[ch] * light + SHIELD_DARK[ch] * dark + CHECK[ch] * check;
        img.data[i + ch] = Math.round(sum / total);
      }
    }
  }
}

function makeImage(width, height, shieldSize) {
  const img = createImage(width, height, BACKGROUND);
  drawShield(img, width / 2, height / 2, shieldSize);
  return encodePng(width, height, img.data);
}

const OUTPUTS = [
  { file: 'icon.png', width: 80, height: 80, shield: 68 },
  { file: 'largeIcon.png', width: 130, height: 130, shield: 110 },
  { file: 'splash.png', width: 1920, height: 1080, shield: 360 },
];

function main() {
  for (const out of OUTPUTS) {
    const png = makeImage(out.width, out.height, out.shield);
    const target = path.join(APP_DIR, out.file);
    fs.writeFileSync(target, png);
    console.log(`${path.relative(process.cwd(), target)}: ${out.width}x${out.height}, ${png.length} bytes`);
  }
}

main();

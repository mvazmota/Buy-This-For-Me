'use strict';

/**
 * Generate the extension PNG icons and the dashboard favicon from one cart
 * design, without any dependencies (node:zlib only).
 *
 * Usage: node scripts/make-icons.js
 *
 * Outputs:
 *   extension/icons/icon-{16,32,48,128}.png  (MV3 icons, must be PNG)
 *   public/favicon.svg                       (same cart, vector)
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ICON_DIR = path.join(__dirname, '..', 'extension', 'icons');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;

// Flat design: white cart on a rounded #2563eb square.
const BACKGROUND = [37, 99, 235]; // #2563eb
const CART = [255, 255, 255]; // #ffffff

/** Cart geometry in unit coordinates (0..1, y grows downwards). */
const SHAPE = {
  radius: 0.22,
  handle: { width: 0.055, points: [[0.13, 0.28], [0.27, 0.28], [0.32, 0.37]] },
  basket: [[0.3, 0.37], [0.87, 0.37], [0.76, 0.63], [0.41, 0.63]],
  wheels: [{ x: 0.46, y: 0.77, r: 0.055 }, { x: 0.73, y: 0.77, r: 0.055 }],
  strokeCap: 0.055 / 2,
};

function insideRoundedSquare(x, y, radius) {
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const crosses = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function insideCart(x, y) {
  if (insidePolygon(x, y, SHAPE.basket)) return true;

  const { points, width } = SHAPE.handle;
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    if (distanceToSegment(x, y, ax, ay, bx, by) <= width / 2) return true;
  }

  return SHAPE.wheels.some((wheel) => Math.hypot(x - wheel.x, y - wheel.y) <= wheel.r);
}

/** Render one icon as straight-alpha RGBA pixels with 4x4 supersampling. */
function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let backgroundHits = 0;
      let cartHits = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const x = (px + (sx + 0.5) / SUPERSAMPLE) / size;
          const y = (py + (sy + 0.5) / SUPERSAMPLE) / size;
          if (!insideRoundedSquare(x, y, SHAPE.radius)) continue;
          backgroundHits += 1;
          if (insideCart(x, y)) cartHits += 1;
        }
      }

      const offset = (py * size + px) * 4;
      if (backgroundHits === 0) continue;

      const cartRatio = cartHits / backgroundHits;
      for (let channel = 0; channel < 3; channel += 1) {
        const value = BACKGROUND[channel] * (1 - cartRatio) + CART[channel] * cartRatio;
        pixels[offset + channel] = Math.round(value);
      }
      // Coverage-weighted alpha keeps the rounded corners smooth.
      pixels[offset + 3] = Math.round((backgroundHits / samples) * 255);
    }
  }

  return pixels;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/** Encode straight-alpha RGBA pixels as an 8-bit truecolour PNG. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // compression
  header[11] = 0; // filter
  header[12] = 0; // interlace

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let row = 0; row < size; row += 1) {
    raw[row * (stride + 1)] = 0; // filter type: none
    pixels.copy(raw, row * (stride + 1) + 1, row * stride, (row + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function round(value) {
  return Number(value.toFixed(2));
}

/** Same cart geometry as an SVG favicon for the dashboard. */
function buildFaviconSvg(size = 64) {
  const point = ([x, y]) => `${round(x * size)} ${round(y * size)}`;
  const [start, ...rest] = SHAPE.handle.points;
  const handlePath = [
    `M${point(start)}`,
    ...rest.map((p) => `L${point(p)}`),
  ].join(' ');
  const basketPoints = SHAPE.basket.map(point).join(' ');
  const wheels = SHAPE.wheels
    .map((wheel) => `  <circle cx="${round(wheel.x * size)}" cy="${round(wheel.y * size)}" r="${round(wheel.r * size)}" fill="#ffffff"/>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Shopping cart">
  <rect width="${size}" height="${size}" rx="${round(SHAPE.radius * size)}" fill="#2563eb"/>
  <path d="${handlePath}" fill="none" stroke="#ffffff" stroke-width="${round(SHAPE.handle.width * size)}" stroke-linecap="round" stroke-linejoin="round"/>
  <polygon points="${basketPoints}" fill="#ffffff"/>
${wheels}
</svg>
`;
}

function main() {
  fs.mkdirSync(ICON_DIR, { recursive: true });

  for (const size of SIZES) {
    const target = path.join(ICON_DIR, `icon-${size}.png`);
    fs.writeFileSync(target, encodePng(size, renderIcon(size)));
    console.log(`wrote ${path.relative(process.cwd(), target)} (${size}x${size})`);
  }

  const favicon = path.join(PUBLIC_DIR, 'favicon.svg');
  fs.writeFileSync(favicon, buildFaviconSvg());
  console.log(`wrote ${path.relative(process.cwd(), favicon)}`);
}

if (require.main === module) {
  main();
}

module.exports = { encodePng, renderIcon, buildFaviconSvg, SHAPE };

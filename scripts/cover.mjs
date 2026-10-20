// -----------------------------------------------------------------------------
// Generates cover.png (800×534, the store size): a dark purple gradient, the
// front of a black AV receiver (a wide lit display with a dB reading, two
// knobs, a row of buttons) and three zone lights. Plain Node (zlib), no
// dependency. Run: npm run cover
// -----------------------------------------------------------------------------

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const WIDTH = 800;
const HEIGHT = 534;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));
/** Antialiased coverage of a signed distance (negative inside). */
const inside = (distance) => Math.min(1, Math.max(0, 0.5 - distance));

/** Signed distance to a rounded rectangle centred on (cx, cy). */
function roundRect(x, y, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

const BG_TOP = [30, 18, 48];
const BG_BOTTOM = [8, 6, 14];
const BODY = [26, 26, 30];
const BODY_LIGHT = [58, 58, 66];
const DISPLAY = [6, 10, 12];
const LCD = [96, 220, 255];
const KNOB = [44, 44, 50];
const KNOB_LIGHT = [150, 150, 160];
const ZONE_ON = [255, 176, 64];
const ZONE_OFF = [70, 60, 50];

/** Seven-segment digits of "-20.0 dB", as lit bars. */
const SEGMENTS = {
  '-': ['g'],
  2: ['a', 'b', 'g', 'e', 'd'],
  0: ['a', 'b', 'c', 'd', 'e', 'f'],
};

function segment(x, y, ox, oy, name) {
  const w = 22;
  const h = 40;
  const t = 4;
  const bars = {
    a: [ox + w / 2, oy, w / 2 - 2, t / 2],
    g: [ox + w / 2, oy + h / 2, w / 2 - 2, t / 2],
    d: [ox + w / 2, oy + h, w / 2 - 2, t / 2],
    f: [ox, oy + h / 4, t / 2, h / 4 - 2],
    b: [ox + w, oy + h / 4, t / 2, h / 4 - 2],
    e: [ox, oy + (3 * h) / 4, t / 2, h / 4 - 2],
    c: [ox + w, oy + (3 * h) / 4, t / 2, h / 4 - 2],
  };
  const [cx, cy, hw, hh] = bars[name];
  return roundRect(x, y, cx, cy, hw, hh, 2);
}

function pixel(x, y) {
  let color = mix(BG_TOP, BG_BOTTOM, y / HEIGHT);
  // Soft shadow under the receiver.
  const shadow = Math.hypot((x - 400) / 340, (y - 372) / 18);
  color = mix(color, [0, 0, 0], (1 - shadow) * 0.8);
  // The body, lighter at the top edge.
  const body = roundRect(x, y, 400, 270, 320, 92, 12);
  color = mix(color, mix(BODY_LIGHT, BODY, (y - 178) / 40), inside(body));
  // The display.
  color = mix(color, DISPLAY, inside(roundRect(x, y, 400, 250, 150, 40, 6)));
  // "-20.0" in seven segments, and a "dB" bar.
  const digits = [
    ['-', 300],
    [2, 336],
    [0, 372],
    [0, 424],
  ];
  for (const [digit, ox] of digits) {
    for (const name of SEGMENTS[digit]) {
      color = mix(color, LCD, inside(segment(x, y, ox, 230, name)) * 0.95);
    }
  }
  color = mix(color, LCD, inside(Math.hypot(x - 406, y - 270) - 3));
  color = mix(color, LCD, inside(roundRect(x, y, 482, 262, 18, 6, 3)) * 0.8);
  // Two knobs: input (left), volume (right).
  for (const [kx, r] of [
    [148, 48],
    [652, 58],
  ]) {
    const d = Math.hypot(x - kx, y - 262);
    color = mix(color, [10, 10, 12], inside(d - r - 5));
    const angle = Math.atan2(y - 262, x - kx);
    const sheen = 0.5 + 0.5 * Math.cos(angle * 2 + 0.8);
    color = mix(color, mix(KNOB, KNOB_LIGHT, sheen * (1 - d / r) * 0.8 + 0.1), inside(d - r));
    const mx = kx + Math.cos(-2.3) * (r - 14);
    const my = 262 + Math.sin(-2.3) * (r - 14);
    color = mix(color, LCD, inside(Math.hypot(x - mx, y - my) - 4));
  }
  // A row of buttons under the display.
  for (let i = 0; i < 8; i += 1) {
    color = mix(color, [12, 12, 14], inside(roundRect(x, y, 274 + i * 36, 322, 12, 5, 3)));
  }
  // Three zone lights above the receiver: main, zone 2 on; zone 3 off.
  for (const [i, on] of [
    [0, true],
    [1, true],
    [2, false],
  ]) {
    const lx = 340 + i * 60;
    const d = Math.hypot(x - lx, y - 120);
    if (on) {
      color = mix(color, ZONE_ON, Math.max(0, 1 - d / 36) * 0.35);
    }
    color = mix(color, on ? ZONE_ON : ZONE_OFF, inside(d - 11));
  }
  return color;
}

const raw = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
for (let y = 0; y < HEIGHT; y += 1) {
  const row = y * (WIDTH * 3 + 1);
  raw[row] = 0;
  for (let x = 0; x < WIDTH; x += 1) {
    const [r, g, b] = pixel(x, y);
    raw.set([r, g, b], row + 1 + x * 3);
  }
}

const header = Buffer.alloc(13);
header.writeUInt32BE(WIDTH, 0);
header.writeUInt32BE(HEIGHT, 4);
header[8] = 8; // bit depth
header[9] = 2; // RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', header),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(new URL('../cover.png', import.meta.url), png);
console.log(`cover.png: ${WIDTH}×${HEIGHT}, ${png.length} bytes`);

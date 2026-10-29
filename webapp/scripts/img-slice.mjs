// JPEG 切图/缩放工具（零依赖 PNG 编码，供人工/视觉核对图纸用）
//   node scripts/img-slice.mjs <jpg> <outdir> --overview 1240
//   node scripts/img-slice.mjs <jpg> <outdir> --crop 100,200,800,600 --scale 2 --name t1
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { resolve } from 'node:path';
import jpeg from 'jpeg-js';

const [, , jpgPath, outDir = 'docs/slices', ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) args[rest[i].replace(/^--/, '')] = rest[i + 1];

function crc32(buf) {
  let c;
  const table = crc32.t || (crc32.t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const raw = jpeg.decode(readFileSync(resolve(jpgPath)), { useTArray: true, formatAsRGBA: true });
const W = raw.width, H = raw.height;
console.log(`source ${W} x ${H}`);
mkdirSync(outDir, { recursive: true });

// 取样：最近邻缩放
function cropScale(sx, sy, cw, ch, scale) {
  const ow = Math.round(cw * scale);
  const oh = Math.round(ch * scale);
  const out = Buffer.alloc(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const syy = Math.min(H - 1, Math.round(sy + y / scale));
    for (let x = 0; x < ow; x++) {
      const sxx = Math.min(W - 1, Math.round(sx + x / scale));
      const si = (syy * W + sxx) * 4;
      const di = (y * ow + x) * 4;
      out[di] = raw.data[si];
      out[di + 1] = raw.data[si + 1];
      out[di + 2] = raw.data[si + 2];
      out[di + 3] = 255;
    }
  }
  return { buf: out, w: ow, h: oh };
}

if (args.overview) {
  const targetW = parseInt(args.overview, 10);
  const s = targetW / W;
  const r = cropScale(0, 0, W, H, s);
  const name = args.name ? `${args.name}.png` : 'overview.png';
  writeFileSync(resolve(outDir, name), encodePng(r.buf, r.w, r.h));
  console.log('overview ->', resolve(outDir, name), r.w, 'x', r.h);
  process.exit(0);
}

if (args.crop) {
  const [x, y, w, h] = args.crop.split(',').map(Number);
  const scale = args.scale ? parseFloat(args.scale) : 1;
  const r = cropScale(x, y, w, h, scale);
  const name = args.name ? `${args.name}.png` : `crop_${x}_${y}.png`;
  writeFileSync(resolve(outDir, name), encodePng(r.buf, r.w, r.h));
  console.log('crop ->', resolve(outDir, name), r.w, 'x', r.h, `(origin ${x},${y} scale ${scale})`);
}

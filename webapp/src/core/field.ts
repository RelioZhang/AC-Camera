/**
 * 声场与色彩算法 —— 支持**任意位置测点**（不再依赖规则网格）。
 *
 * 模型沿用旧版「能量叠加 + 距离衰减」：
 *   E(p) = 10·log10( Σ 10^((v_i − α·d(p,i)) / 10) )
 * α（dB/m）由测点的典型间距自动推导（默认等效 6 dB/倍距），
 * 点距不规则时也能得到合理衰减，而不是死板的“每格 6 dB”。
 *
 * 计算域 = 测点包围盒外扩 margin（不超出图纸范围），
 * 等声压级图只覆盖实际普查区域，不会把空白地带涂满颜色。
 */

export interface PointValue {
  x: number;
  y: number;
  value: number;
}

/**
 * 成图范围：
 *  - paper  ：整幅图纸（并上底图溢出部分），远处自然衰减到底噪下限
 *  - points ：仅测点包围盒外扩，图面更集中在普查区
 */
export type FieldScope = 'paper' | 'points';

export interface Domain {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export interface FieldResult {
  values: Float64Array;
  resX: number;
  resY: number;
  /** 场的物理范围（米，相对图纸左上角） */
  domain: Domain;
  min: number;
  max: number;
}

export interface SplPoint {
  x: number;
  y: number;
  spl: number;
}

const RES_X = 160;
const DEFAULT_SPACING = 10;

/** 测点典型间距：最近邻距离的中位数，用于把「6 dB/倍距」换算成 dB/m。 */
export function typicalSpacing(points: SplPoint[], fallback = DEFAULT_SPACING): number {
  if (points.length < 2) return fallback;
  const d: number[] = [];
  for (let i = 0; i < points.length; i++) {
    let best = Infinity;
    for (let j = 0; j < points.length; j++) {
      if (i === j) continue;
      const dd = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y);
      if (dd < best) best = dd;
    }
    if (Number.isFinite(best) && best > 1e-6) d.push(best);
  }
  if (d.length === 0) return fallback;
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] || fallback;
}

/**
 * 计算域。
 * @param opts.scope  'paper'（默认）铺满整幅图纸；'points' 只用测点包围盒
 * @param opts.cover  底图溢出纸张时的外接矩形，用于保证彩图覆盖整幅底图
 */
export function fieldDomain(
  points: SplPoint[],
  world: { w: number; h: number },
  opts: { scope?: FieldScope; marginRatio?: number; cover?: Domain | null } = {},
): Domain | null {
  if (points.length === 0) return null;
  const scope = opts.scope ?? 'paper';

  if (scope === 'paper') {
    let x0 = 0;
    let y0 = 0;
    let x1 = world.w;
    let y1 = world.h;
    const cv = opts.cover;
    if (cv && cv.w > 0 && cv.h > 0) {
      x0 = Math.min(x0, cv.x0);
      y0 = Math.min(y0, cv.y0);
      x1 = Math.max(x1, cv.x0 + cv.w);
      y1 = Math.max(y1, cv.y0 + cv.h);
    }
    return { x0, y0, w: Math.max(1e-3, x1 - x0), h: Math.max(1e-3, y1 - y0) };
  }

  const marginRatio = opts.marginRatio ?? 0.12;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  // 单点 / 一列 / 一行测点时保证域有厚度，否则等值线无法成形
  const spanX = Math.max(maxX - minX, world.w * 0.08);
  const spanY = Math.max(maxY - minY, world.h * 0.08);
  const padX = Math.max(spanX * marginRatio, world.w * 0.04);
  const padY = Math.max(spanY * marginRatio, world.h * 0.04);
  const x0 = Math.max(0, minX - padX);
  const y0 = Math.max(0, minY - padY);
  const x1 = Math.min(world.w, maxX + padX);
  const y1 = Math.min(world.h, maxY + padY);
  return { x0, y0, w: Math.max(1e-3, x1 - x0), h: Math.max(1e-3, y1 - y0) };
}

function computeResY(domain: Domain, resX: number): number {
  if (domain.h <= 0) return resX;
  return Math.max(2, Math.round((resX * domain.h) / domain.w));
}

/** 无底噪时的下限：最安静测点以下的自然衰减包络 */
export const DECAY_SPAN = 18;

export function computeSplFieldPoints(
  points: SplPoint[],
  domain: Domain,
  backgroundNoiseDb = 0,
  attenuationPerMeter?: number,
  resX = RES_X,
): FieldResult | null {
  if (points.length === 0) return null;
  const bg = backgroundNoiseDb;
  const resY = computeResY(domain, resX);
  const values = new Float64Array(resX * resY);

  const spacing = typicalSpacing(points);
  const atten = attenuationPerMeter && attenuationPerMeter > 0
    ? attenuationPerMeter
    : 6.0 / Math.max(1e-3, spacing);
  const k = (atten * Math.LN10) / 10;

  const amps = points.map((p) => Math.pow(10, Math.max(0, p.spl - bg) / 10));
  let minMeasured = Infinity;
  for (const p of points) if (p.spl < minMeasured) minMeasured = p.spl;
  const floor = bg > 0 ? bg : Math.max(0, minMeasured - DECAY_SPAN);

  let smin = Infinity;
  let smax = -Infinity;
  for (let gy = 0; gy < resY; gy++) {
    const y = domain.y0 + ((gy + 0.5) / resY) * domain.h;
    for (let gx = 0; gx < resX; gx++) {
      const x = domain.x0 + ((gx + 0.5) / resX) * domain.w;
      let energy = 0;
      for (let i = 0; i < points.length; i++) {
        const d = Math.hypot(x - points[i].x, y - points[i].y);
        energy += amps[i] * Math.exp(-k * d);
      }
      const v0 = energy > 0 ? 10 * Math.log10(energy) + bg : floor;
      const v = Math.max(v0, floor);
      values[gy * resX + gx] = v;
      if (v < smin) smin = v;
      if (v > smax) smax = v;
    }
  }
  return { values, resX, resY, domain, min: smin, max: smax };
}

// ───────────────────────── colormap ─────────────────────────

const STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [49, 54, 149],
  [69, 170, 200],
  [60, 180, 75],
  [245, 205, 50],
  [220, 50, 47],
];

export const MIN_PALETTE_STEPS = 64;
export const MAX_PALETTE_STEPS = 256;

export function colormap(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t));
  const n = STOPS.length - 1;
  const pos = x * n;
  const i = Math.min(n - 1, Math.max(0, Math.floor(pos)));
  const f = pos - i;
  const c0 = STOPS[i];
  const c1 = STOPS[i + 1];
  return [
    Math.min(255, Math.max(0, Math.round(c0[0] + (c1[0] - c0[0]) * f))),
    Math.min(255, Math.max(0, Math.round(c0[1] + (c1[1] - c0[1]) * f))),
    Math.min(255, Math.max(0, Math.round(c0[2] + (c1[2] - c0[2]) * f))),
  ];
}

/** 色带中心色，再量化到调色板步数（与 Kotlin bandColor 一致）。 */
export function bandColor(band: number, bands: number, steps: number): [number, number, number] {
  if (bands < 2) return colormap(0);
  const b = Math.min(bands - 1, Math.max(0, band));
  let t = (b + 0.5) / bands;
  if (steps >= 2) {
    const st = Math.min(MAX_PALETTE_STEPS, Math.max(MIN_PALETTE_STEPS, steps));
    t = Math.round(t * st) / st;
  }
  return colormap(t);
}

export function bandColors(bands: number, steps = bands): [number, number, number][] {
  const n = bands >= 2 ? bands : 1;
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) out.push(bandColor(i, bands, steps));
  return out;
}

export function quantizeStep(bands: number): number {
  return Math.min(MAX_PALETTE_STEPS, Math.max(MIN_PALETTE_STEPS, bands));
}

/**
 * 渲染色场为 ImageData。
 * @param feather 边缘羽化比例（0~0.5）：0 表示硬边；0.12 表示最外 12% 宽度渐隐，
 *                避免彩图在测点包围盒处出现生硬切口。
 */
export function renderFieldImageData(
  field: FieldResult,
  colorBands: number,
  alpha: number,
  feather = 0,
): ImageData {
  const { values, resX, resY, min, max } = field;
  const img = new ImageData(resX, resY);
  const range = max - min > 1e-6 ? max - min : 1.0;
  const bands = colorBands >= 2 ? colorBands : 0;
  const steps = bands > 0 ? quantizeStep(bands) : 0;
  const aBase = alpha * 255;
  const f = Math.min(0.5, Math.max(0, feather));
  const fx = f * resX;
  const fy = f * resY;
  for (let i = 0; i < values.length; i++) {
    const t = Math.min(1, Math.max(0, (values[i] - min) / range));
    let rgb: [number, number, number];
    if (bands === 0) {
      rgb = colormap(t);
    } else {
      const band = Math.min(bands - 1, Math.max(0, Math.floor(t * bands)));
      rgb = bandColor(band, bands, steps);
    }
    // 边缘羽化：按到四边的最小距离做 smoothstep 渐隐
    let edge = 1;
    if (f > 0) {
      const gx = i % resX;
      const gy = (i - gx) / resX;
      const dx = Math.min(gx, resX - 1 - gx) / fx;
      const dy = Math.min(gy, resY - 1 - gy) / fy;
      const t = Math.min(1, Math.max(0, Math.min(dx, dy)));
      edge = t * t * (3 - 2 * t);
    }
    img.data[i * 4] = rgb[0];
    img.data[i * 4 + 1] = rgb[1];
    img.data[i * 4 + 2] = rgb[2];
    img.data[i * 4 + 3] = Math.round(aBase * edge);
  }
  return img;
}

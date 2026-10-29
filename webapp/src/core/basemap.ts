/**
 * 底图在「图纸米制坐标」中的落位计算。
 *
 * 关键点：落位只由项目数据（图纸 W/H、底图宽高比、缩放、偏移）决定，
 * **与画布像素尺寸无关**。因此：
 *   - 底图在桌面与手机上的相对位置完全一致；
 *   - 点位可以用「底图归一化坐标 (u,v)」锚定，跨设备重开也不会错位。
 *
 * contain-fit 的参照框是纸面 W×H（不是画布），缩放绕纸面中心，偏移按纸面宽高的比例。
 */
import type { Project } from './types';
import { worldSize } from './types';

export interface RectM {
  left: number;
  top: number;
  width: number;
  height: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}

/** 底图（图片 / DXF）在米制坐标中的矩形。aspect = 底图宽 / 高。 */
export function baseMapRectMeters(p: Project, aspect: number): RectM {
  const { w: W, h: H } = worldSize(p);
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : W / H;

  // contain fit：整幅底图塞进 W×H 纸面
  let w = W;
  let h = W / a;
  if (h > H) {
    h = H;
    w = H * a;
  }
  if (!(w > 0.0001) || !(h > 0.0001)) {
    w = W;
    h = H;
  }

  const s = clamp(p.baseMapScale ?? 1, 0.2, 5);
  const offX = clamp(p.baseMapOffsetX ?? 0, -0.5, 0.5);
  const offY = clamp(p.baseMapOffsetY ?? 0, -0.5, 0.5);

  const cx = W / 2 + offX * W;
  const cy = H / 2 + offY * H;
  const sw = w * s;
  const sh = h * s;
  return { left: cx - sw / 2, top: cy - sh / 2, width: sw, height: sh };
}

/** 底图归一化坐标 (u,v) ∈ 0..1（左上为原点）→ 图纸米制坐标。 */
export function anchorToMeters(
  p: Project,
  aspect: number,
  u: number,
  v: number,
): { x: number; y: number } {
  const r = baseMapRectMeters(p, aspect);
  return { x: r.left + u * r.width, y: r.top + v * r.height };
}

/** 图纸米制坐标 → 底图归一化坐标（反解；底图未就位时返回 null）。 */
export function metersToAnchor(
  p: Project,
  aspect: number,
  x: number,
  y: number,
): { u: number; v: number } | null {
  const r = baseMapRectMeters(p, aspect);
  if (!(r.width > 0.0001) || !(r.height > 0.0001)) return null;
  return { u: (x - r.left) / r.width, v: (y - r.top) / r.height };
}

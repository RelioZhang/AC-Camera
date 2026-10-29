/**
 * 噪声源识别（任意位置测点版）：
 * 取每个测点最近的 k 个邻居，若该点声压级严格高于所有邻居且达到阈值，
 * 判为疑似噪声源。相比旧版 8 邻域，这个规则不依赖规则网格，
 * 测点疏密不均时同样稳定（k 随点数自适应，最多 6 个）。
 */
import type { Measurement } from './types';

export interface NoiseSource {
  id: string;
  x: number;
  y: number;
  spl: number;
}

export function detectNoiseSources(
  measurements: Measurement[],
  thresholdDb: number,
  backgroundNoiseDb = 0.0,
  k = 6,
): NoiseSource[] {
  if (measurements.length === 0) return [];
  const n = measurements.length;
  const kk = Math.max(1, Math.min(k, n - 1));
  const sources: NoiseSource[] = [];

  for (let i = 0; i < n; i++) {
    const m = measurements[i];
    if (m.spl < thresholdDb) continue;
    if (m.spl - backgroundNoiseDb <= 0) continue;

    if (n > 1) {
      const dist: Array<{ d: number; j: number }> = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        dist.push({ d: Math.hypot(m.x - measurements[j].x, m.y - measurements[j].y), j });
      }
      dist.sort((a, b) => a.d - b.d);
      let isMax = true;
      for (let t = 0; t < Math.min(kk, dist.length); t++) {
        if (measurements[dist[t].j].spl > m.spl) { isMax = false; break; }
      }
      if (!isMax) continue;
    }

    sources.push({ id: m.id, x: m.x, y: m.y, spl: m.spl });
  }

  return sources.sort((a, b) => b.spl - a.spl);
}

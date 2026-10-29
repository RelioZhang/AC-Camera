/**
 * 成图范围（计算域）回归测试。
 * 回归点：测点集中在很小一块时，整幅图纸模式下等压级图必须覆盖整张图纸
 * （用户反馈「曲线只在一小块生成，没有覆盖整个底图」）。
 *
 *   node scripts/test-field-domain.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const outfile = join(mkdtempSync(join(tmpdir(), 'na-field-')), 'field.mjs');
await build({
  entryPoints: [resolve('src/core/field.ts')],
  bundle: true, format: 'esm', outfile, logLevel: 'silent',
});
const { fieldDomain, computeSplFieldPoints } = await import(pathToFileURL(outfile).href);

let fail = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + detail}`);
  if (!cond) fail++;
};
const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

const world = { w: 90, h: 126 };          // 与演示项目一致
// 9 个挤在中心 10 m 见方的测点（复现用户场景）
const clustered = [];
for (let i = 0; i < 9; i++) {
  clustered.push({ x: 42 + (i % 3) * 5, y: 56 + Math.floor(i / 3) * 5, spl: 80 + i });
}

console.log('\n[1] 整幅图纸模式：无论测点多集中，域都铺满图纸');
{
  const d = fieldDomain(clustered, world, { scope: 'paper' });
  check('x0/y0 = 0', near(d.x0, 0) && near(d.y0, 0), JSON.stringify(d));
  check('宽高 = 图纸尺寸', near(d.w, world.w) && near(d.h, world.h), JSON.stringify(d));
}

console.log('\n[2] 仅测点区域模式：域收缩到包围盒外扩');
{
  const d = fieldDomain(clustered, world, { scope: 'points' });
  check('域明显小于图纸', d.w < world.w * 0.5 && d.h < world.h * 0.5, JSON.stringify(d));
  check('域包住全部测点', clustered.every((p) => p.x >= d.x0 && p.x <= d.x0 + d.w && p.y >= d.y0 && p.y <= d.y0 + d.h));
}

console.log('\n[3] 底图溢出纸面时，域要包住底图');
{
  const cover = { x0: -20, y0: -10, w: 140, h: 160 };   // 底图比纸面大得多
  const d = fieldDomain(clustered, world, { scope: 'paper', cover });
  check('左/上扩到 -20/-10', near(d.x0, -20) && near(d.y0, -10), JSON.stringify(d));
  check('右/下扩到 120/150', near(d.x0 + d.w, 120) && near(d.y0 + d.h, 150), JSON.stringify(d));
}

console.log('\n[4] 大域上仍能算出有意义的场（不是全平）');
{
  const d = fieldDomain(clustered, world, { scope: 'paper' });
  const f = computeSplFieldPoints(clustered, d, 55);
  const span = f.max - f.min;
  check('极差 > 10 dB', span > 10, `min=${f.min.toFixed(1)} max=${f.max.toFixed(1)}`);
  check('分辨率随域放大', f.resX >= 160, `resX=${f.resX} resY=${f.resY}`);
  // 远端应回落到下限（底噪），近端应接近峰值
  const corner = f.values[0];
  check('远角接近底噪下限', corner <= 55.5, `corner=${corner.toFixed(2)}`);
}

console.log(fail === 0 ? '\nALL PASS\n' : `\n${fail} FAILED\n`);
process.exit(fail === 0 ? 0 : 1);

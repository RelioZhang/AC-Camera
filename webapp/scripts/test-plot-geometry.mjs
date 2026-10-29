/**
 * 画布几何回归测试（Node 内跑，不需要浏览器）。
 * 验证：定标把底图放大后（内容超出纸面）仍能缩小 + 平移到底图边界，
 * 且「适应全图」能把内容完整放进视口。
 *
 *   node scripts/test-plot-geometry.mjs
 */
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ── 最小 DOM 桩 ──
const noop = () => {};
const fakeCtx = new Proxy({}, {
  get: (_t, k) => (k === 'canvas' ? null : noop),
  set: () => true,
});

function makeCanvas() {
  const canvas = {
    className: '',
    width: 800,
    height: 600,
    style: {},
    parentElement: {
      clientWidth: 400,
      clientHeight: 600,
      appendChild: noop,
    },
    addEventListener: noop,
    setPointerCapture: noop,
    getContext: () => fakeCtx,
  };
  return canvas;
}

globalThis.document = { createElement: () => makeCanvas() };
globalThis.devicePixelRatio = 1;
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.window = globalThis;

const outdir = mkdtempSync(join(tmpdir(), 'na-plot-'));
const outfile = join(outdir, 'plot.mjs');
await build({
  entryPoints: [resolve('src/ui/plot.ts')],
  bundle: true,
  format: 'esm',
  outfile,
  logLevel: 'silent',
});
const { PlotCanvas, MIN_ZOOM } = await import(pathToFileURL(outfile).href);
writeFileSync(join(outdir, '.keep'), '');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}  ${detail}`);
  }
}
const near = (a, b, tol = 0.75) => Math.abs(a - b) <= tol;

function newPlot(content, aspect = 0.7) {
  const plot = new PlotCanvas({ clientWidth: 400, clientHeight: 600, appendChild: noop });
  plot.worldAspect = aspect;
  plot.contentRect = content;
  return plot;
}

console.log('\n[1] 内容未溢出：1:1 居中，不可拖动');
{
  const p = newPlot({ u0: 0, v0: 0, u1: 1, v1: 1 });
  const vp = p.viewport();
  const w = p.worldRect();
  check('默认缩放 1.0', p.transform.zoom === 1, `zoom=${p.transform.zoom}`);
  check('纸张居中于视口', near(w.left, vp.left) && near(w.top, vp.top), `world=${JSON.stringify(w)} vp=${JSON.stringify(vp)}`);
  p.zoomStep(1.25);
  check('可放大', p.transform.zoom > 1, `zoom=${p.transform.zoom}`);
}

console.log('\n[2] 底图溢出纸面（等价于两点定标把比例放大）：可缩小、可平移');
{
  // 底图 3 倍大、居中 => 内容范围约 -1..2
  const content = { u0: -1, v0: -1, u1: 2, v1: 2 };
  const p = newPlot(content);
  check('识别为溢出', p.contentOverflow());

  // 关键回归：以前 MIN_ZOOM=1 + clampPan 只允许 zoom>=1，导致永远看不到溢出部分
  p.fit();
  const vp = p.viewport();
  const world = p.worldRect();
  const z = p.transform.zoom;
  check('适应全图可以缩小到 1 倍以下', z < 1, `zoom=${z} (MIN=${MIN_ZOOM})`);
  check('缩小后内容宽度刚好放进视口', near((content.u1 - content.u0) * world.width, vp.width, 2),
    `contentW=${(content.u1 - content.u0) * world.width} vpW=${vp.width}`);

  const leftPx = world.left + content.u0 * world.width;
  const topPx = world.top + content.v0 * world.height;
  check('内容左/上边界落在视口内', leftPx >= vp.left - 1 && topPx >= vp.top - 1,
    `left=${leftPx} top=${topPx} vpLeft=${vp.left} vpTop=${vp.top}`);

  // 平移：放大后应能拖到内容最边缘
  p.transform.zoom = 2;
  p.transform.panX = 0;
  p.transform.panY = 0;
  // 用 zoomStep 触发 clampPan（内部会夹紧）
  p.zoomStep(1.0001);
  const w2 = p.worldRect();
  const reachableLeft = w2.left + content.u0 * w2.width;
  check('放大后左边界仍可达（不再被纸面锁死）', reachableLeft <= vp.left + 1,
    `contentLeftPx=${reachableLeft}`);
}

console.log('\n[3] 缩到最小时不允许出现「内容比视口还小且跑到一边」');
{
  const content = { u0: 0, v0: 0, u1: 1, v1: 1 };
  const p = newPlot(content);
  for (let i = 0; i < 10; i++) p.zoomStep(0.8);
  check('不小于 MIN_ZOOM', p.transform.zoom >= MIN_ZOOM - 1e-9, `zoom=${p.transform.zoom}`);
  const vp = p.viewport();
  const w = p.worldRect();
  const cxContent = w.left + w.width / 2;
  const cxVp = vp.left + vp.width / 2;
  check('缩到最小时内容水平居中', near(cxContent, cxVp, 1.5), `contentCx=${cxContent} vpCx=${cxVp}`);
}

console.log('\n[4] 内容比视口略大时可拖到边缘，并保留 15% 余量');
{
  // 内容 1.2 倍视口：既能拖动，也不至于拖到"全空"
  const p = newPlot({ u0: -0.1, v0: -0.1, u1: 1.1, v1: 1.1 });
  const vp = p.viewport();
  p.transform.panX = 99999;
  p.transform.panY = 99999;
  p.paint();                       // paint 内部会 clampPan
  const maxPanX = 0.1 * vp.width + 0.15 * vp.width;
  check('横向余量 = 内容外溢 + 15% 视口', near(p.transform.panX, maxPanX, 2),
    `panX=${p.transform.panX.toFixed(1)} expect=${maxPanX.toFixed(1)}`);
  check('纵向同样有余量', p.transform.panY > 0, `panY=${p.transform.panY}`);

  // 反向拖到另一个极限
  p.transform.panX = -99999;
  p.paint();
  const minPanX = vp.width - 1.1 * vp.width - 0.15 * vp.width;
  check('可拖到内容右边缘', near(p.transform.panX, minPanX, 2),
    `panX=${p.transform.panX.toFixed(1)} expect=${minPanX.toFixed(1)}`);
}

console.log('\n[4b] 内容装得下时必须居中（不能贴着一边）');
{
  const p = newPlot({ u0: 0, v0: 0, u1: 1, v1: 1 });
  p.transform.zoom = 0.76;         // 复现用户截图里的缩放
  p.transform.panY = 60;           // 被推下去的偏移
  p.paint();
  const vp = p.viewport();
  const w = p.worldRect();
  check('水平居中', near(w.left + w.width / 2, vp.left + vp.width / 2, 1.5),
    `contentCx=${(w.left + w.width / 2).toFixed(1)} vpCx=${(vp.left + vp.width / 2).toFixed(1)}`);
  check('垂直居中', near(w.top + w.height / 2, vp.top + vp.height / 2, 1.5),
    `contentCy=${(w.top + w.height / 2).toFixed(1)} vpCy=${(vp.top + vp.height / 2).toFixed(1)}`);
}

console.log('\n[5] 底图溢出且缩放不小于 1 时，内容仍可缩到看得全');
{
  const content = { u0: -2, v0: -2, u1: 3, v1: 3 };   // 5 倍
  const p = newPlot(content);
  p.fit();
  check('可缩到 0.2 或更低（MIN_ZOOM 已放宽）', p.transform.zoom <= 0.21, `zoom=${p.transform.zoom}`);
  const vp = p.viewport();
  const w = p.worldRect();
  const cw = (content.u1 - content.u0) * w.width;
  check('内容宽度不超出视口', cw <= vp.width * 1.01, `cw=${cw} vpW=${vp.width}`);
}

console.log(failures === 0 ? '\nALL PASS\n' : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);

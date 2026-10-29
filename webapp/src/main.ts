import './styles.css';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { newProject, newPointId, worldSize } from './core/types';
import type { Project, ProjectWithMeasurements, Measurement } from './core/types';
import { anchorToMeters, baseMapRectMeters } from './core/basemap';
import { bandColors, colormap, computeSplFieldPoints, fieldDomain, quantizeStep, renderFieldImageData } from './core/field';
import type { SplPoint, FieldScope, Domain } from './core/field';
import type { FieldResult } from './core/field';
import { contours, defaultLevels } from './core/contour';
import { readDxf } from './core/dxf';
import type { CadDrawing } from './core/dxf';
import { detectNoiseSources } from './core/noise';
import { load, save, exportJsonText, readJsonFile, storageHint, pickDataDir, supportsFsApi, migrate as migrateStore } from './core/storage';
import { setExportProvider } from './core/main-state';
import { PlotCanvas } from './ui/plot';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// ───────────────────────── 用户偏好 ─────────────────────────

type ToolbarMode = 'icon' | 'text' | 'both';

interface UiPrefs {
  showCalib: boolean;
  showPoints: boolean;
  showContours: boolean;
  showGridlines: boolean;
  /** 网格尺寸：场地总宽/总高的尺寸标注 */
  showDims: boolean;
  /** 底部距离比例尺 */
  showScaleBar: boolean;
  /** 等压级成图范围：整幅图纸 / 仅测点区域 */
  fieldScope: FieldScope;
  toolbarMode: ToolbarMode;
}

const PREFS_KEY = 'noiseatlas-ui-prefs-v1';

const prefs: UiPrefs = (() => {
  const def: UiPrefs = {
    showCalib: true, showPoints: true, showContours: true, showGridlines: true,
    showDims: true, showScaleBar: true, fieldScope: 'paper', toolbarMode: 'both',
  };
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...def, ...JSON.parse(raw) } : def;
  } catch {
    return def;
  }
})();

function savePrefs(): void {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
}

// ───────────────────────── state ─────────────────────────

let store: ProjectWithMeasurements[] = load();
let currentId: number | null = null;

// 记住上次打开的项目：重开应用直接进入上次的现场，不用再点一次
const LAST_PROJECT_KEY = 'noiseatlas-last-project';
try {
  const last = localStorage.getItem(LAST_PROJECT_KEY);
  if (last) {
    const id = Number(last);
    if (store.some((p) => p.project.id === id)) currentId = id;
  }
} catch { /* ignore */ }

function rememberCurrent(): void {
  try {
    if (currentId == null) localStorage.removeItem(LAST_PROJECT_KEY);
    else localStorage.setItem(LAST_PROJECT_KEY, String(currentId));
  } catch { /* ignore */ }
}
let activeTab: 'entry' | 'contour' | 'settings' = 'entry';

function current(): ProjectWithMeasurements | null {
  return store.find((p) => p.project.id === currentId) ?? null;
}

function touch(p: Project): void {
  p.updatedAt = Date.now();
}

function persist(): void {
  void save();
}

setExportProvider(() => JSON.stringify(sortStore(), null, 2));

function sortStore(): ProjectWithMeasurements[] {
  return [...store].sort((a, b) => b.project.updatedAt - a.project.updatedAt);
}

// ───────────────────────── base-map cache ─────────────────────────

interface Rect { left: number; top: number; width: number; height: number }

let bmCacheKey = '';
let bmImage: HTMLImageElement | null = null;
let bmCad: CadDrawing | null = null;

function basemapKey(p: Project): string {
  return `${p.id}:${p.backgroundImageData?.length ?? 0}:${p.backgroundDxfText?.length ?? 0}`;
}

function refreshBasemapCache(p: Project): void {
  const key = basemapKey(p);
  if (key === bmCacheKey) return;
  bmCacheKey = key;
  bmImage = null;
  bmCad = null;
  if (p.backgroundDxfText) {
    bmCad = readDxf(p.backgroundDxfText);
  } else if (p.backgroundImageData) {
    const img = new Image();
    img.src = p.backgroundImageData;
    img.decode().then(() => {
      bmImage = img;
      applyAnchors(current());
      updateContentRect(current());
      entryPlot.paint();
      contourPlot.paint();
    }).catch(() => { bmImage = null; });
  }
}

/** 当前底图的宽高比（图片用像素比，DXF 用包围盒比）；未导入时返回 0。 */
function basemapAspect(): number {
  if (bmCad && bmCad.aspectRatio > 0) return bmCad.aspectRatio;
  if (bmImage && bmImage.naturalWidth > 0 && bmImage.naturalHeight > 0) {
    return bmImage.naturalWidth / bmImage.naturalHeight;
  }
  return 0;
}

/**
 * 把带锚点（bu/bv）的测点按当前底图落位重算米制坐标。
 * 定标、底图对齐、图纸尺寸变化后都要调用，测点才会跟着底图走。
 */
function applyAnchors(item: ProjectWithMeasurements | null): void {
  if (!item) return;
  const aspect = basemapAspect();
  if (!(aspect > 0)) return;
  let changed = false;
  for (const m of item.measurements) {
    if (typeof m.bu === 'number' && typeof m.bv === 'number') {
      const q = anchorToMeters(item.project, aspect, m.bu, m.bv);
      if (Math.abs(q.x - m.x) > 1e-6 || Math.abs(q.y - m.y) > 1e-6) {
        m.x = q.x;
        m.y = q.y;
        changed = true;
      }
    }
  }
  if (changed) splFieldCache = null;
}

/** 底图在画布上的像素矩形（由米制落位换算，纸张比例固定后结果稳定）。 */
function basemapRectPx(world: Rect, p: Project): Rect | null {
  const aspect = basemapAspect();
  if (!(aspect > 0)) return null;
  const { w: W, h: H } = worldSize(p);
  const r = baseMapRectMeters(p, aspect);
  return {
    left: world.left + (r.left / W) * world.width,
    top: world.top + (r.top / H) * world.height,
    width: (r.width / W) * world.width,
    height: (r.height / H) * world.height,
  };
}

/**
 * 刷新两张画布的「可浏览内容范围」：纸张 ∪ 溢出底图。
 * 定标把底图放大后，若仍按纸面限制平移/缩放，底图超出部分就永远看不到，
 * 表现为「缩放只能到 1.0 倍、图纸也拖不动」。这里把边界放宽到内容实际范围。
 */
function updateContentRect(item: ProjectWithMeasurements | null): void {
  let u0 = 0, v0 = 0, u1 = 1, v1 = 1;
  if (item) {
    const aspect = basemapAspect();
    if (aspect > 0) {
      const ws = worldSize(item.project);
      const r = baseMapRectMeters(item.project, aspect);
      u0 = Math.min(0, r.left / ws.w);
      v0 = Math.min(0, r.top / ws.h);
      u1 = Math.max(1, (r.left + r.width) / ws.w);
      v1 = Math.max(1, (r.top + r.height) / ws.h);
    }
  }
  const c = { u0, v0, u1, v1 };
  entryPlot.contentRect = c;
  contourPlot.contentRect = c;
}

function drawBasemap(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  let dst: Rect | null = null;
  if (bmCad) {
    dst = basemapRectPx(world, p);
  } else if (bmImage && bmImage.naturalWidth > 0) {
    dst = basemapRectPx(world, p);
  }
  if (!dst) return;

  ctx.save();
  if (bmCad) {
    ctx.strokeStyle = '#1f3b66';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (const poly of bmCad.polylines) {
      for (let i = 0; i < poly.xs.length; i++) {
        const x = dst.left + poly.xs[i] * dst.width;
        const y = dst.top + poly.ys[i] * dst.height;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      if (poly.closed) ctx.closePath();
    }
    ctx.stroke();
  } else if (bmImage) {
    ctx.drawImage(bmImage, dst.left, dst.top, dst.width, dst.height);
  }
  ctx.restore();
}

// ───────────────────────── 图纸装饰 ─────────────────────────

function drawPaper(ctx: CanvasRenderingContext2D, world: Rect): void {
  ctx.save();
  ctx.fillStyle = '#fbfcfd';
  ctx.fillRect(world.left, world.top, world.width, world.height);
  ctx.strokeStyle = '#6d7681';
  ctx.lineWidth = 1;
  ctx.strokeRect(world.left + 0.5, world.top + 0.5, world.width - 1, world.height - 1);
  ctx.restore();
}

function niceStep(pxPerMeter: number, targetPx = 90): number {
  const meters = targetPx / Math.max(1e-9, pxPerMeter);
  const exp = Math.floor(Math.log10(meters));
  const base = Math.pow(10, exp);
  const f = meters / base;
  const nf = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
  return nf * base;
}

/** 米制参考网格（无测点约束，纯坐标系参考） */
function drawRefGrid(ctx: CanvasRenderingContext2D, world: Rect, ws: { w: number; h: number }, p: Project): void {
  const step = niceStep(world.width / ws.w, 70);
  if (!(step > 0)) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(70,84,100,0.14)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  for (let x = step; x < ws.w; x += step) {
    const px = world.left + (x / ws.w) * world.width;
    ctx.moveTo(px, world.top); ctx.lineTo(px, world.top + world.height);
  }
  for (let y = step; y < ws.h; y += step) {
    const py = world.top + (y / ws.h) * world.height;
    ctx.moveTo(world.left, py); ctx.lineTo(world.left + world.width, py);
  }
  ctx.stroke();
  ctx.restore();
}

function drawRulers(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const { w: wm, h: hm } = worldSize(p);
  if (!(wm > 0) || !(hm > 0)) return;
  const pxPerMeter = world.width / wm;
  const step = niceStep(pxPerMeter);

  ctx.save();
  ctx.strokeStyle = '#aeb7c2';
  ctx.fillStyle = '#dfe5ec';
  ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI", system-ui';

  ctx.beginPath();
  for (let m = 0; m <= wm + 1e-6; m += step) {
    const x = world.left + m * pxPerMeter;
    ctx.moveTo(x, world.top - 5); ctx.lineTo(x, world.top);
  }
  for (let m = 0; m <= hm + 1e-6; m += step) {
    const y = world.top + m * pxPerMeter;
    ctx.moveTo(world.left - 5, y); ctx.lineTo(world.left, y);
  }
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  for (let m = 0; m <= wm + 1e-6; m += step) {
    ctx.fillText(`${Math.round(m)}`, world.left + m * pxPerMeter, world.top - 7);
  }
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let m = step; m <= hm + 1e-6; m += step) {
    ctx.fillText(`${Math.round(m)}`, world.left - 8, world.top + m * pxPerMeter);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillStyle = '#9aa4b0';
  ctx.fillText('m', world.left + world.width + 4, world.top - 7);
  ctx.restore();
}


/** 网格尺寸标注：上方总宽尺寸线 + 左侧总高尺寸线（工程图纸习惯）。 */
function drawDimensions(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const { w: wm, h: hm } = worldSize(p);
  if (!(wm > 0) || !(hm > 0) || world.width < 120) return;

  ctx.save();
  ctx.lineWidth = 1;
  ctx.font = '10px "Segoe UI", system-ui';

  // ── 顶部：总宽 ──
  const y = world.top - 17;
  ctx.strokeStyle = '#8b95a1';
  ctx.beginPath();
  ctx.moveTo(world.left, y); ctx.lineTo(world.left + world.width, y);
  ctx.moveTo(world.left, y - 3); ctx.lineTo(world.left, y + 3);
  ctx.moveTo(world.left + world.width, y - 3); ctx.lineTo(world.left + world.width, y + 3);
  ctx.moveTo(world.left, y); ctx.lineTo(world.left, world.top - 11);
  ctx.moveTo(world.left + world.width, y); ctx.lineTo(world.left + world.width, world.top - 11);
  ctx.stroke();

  const wLabel = `${wm.toFixed(1)} m`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(wLabel).width;
  const cx = world.left + world.width / 2;
  ctx.fillStyle = 'rgba(240,243,247,0.94)';
  ctx.fillRect(cx - tw / 2 - 4, y - 7, tw + 8, 14);
  ctx.fillStyle = '#2f3945';
  ctx.fillText(wLabel, cx, y);

  // ── 左侧：总高（竖排） ──
  const x = world.left - 17;
  ctx.strokeStyle = '#8b95a1';
  ctx.beginPath();
  ctx.moveTo(x, world.top); ctx.lineTo(x, world.top + world.height);
  ctx.moveTo(x - 3, world.top); ctx.lineTo(x + 3, world.top);
  ctx.moveTo(x - 3, world.top + world.height); ctx.lineTo(x + 3, world.top + world.height);
  ctx.moveTo(x, world.top); ctx.lineTo(world.left - 11, world.top);
  ctx.moveTo(x, world.top + world.height); ctx.lineTo(world.left - 11, world.top + world.height);
  ctx.stroke();

  const hLabel = `${hm.toFixed(1)} m`;
  ctx.save();
  ctx.translate(x, world.top + world.height / 2);
  ctx.rotate(-Math.PI / 2);
  const hw = ctx.measureText(hLabel).width;
  ctx.fillStyle = 'rgba(240,243,247,0.94)';
  ctx.fillRect(-hw / 2 - 4, -7, hw + 8, 14);
  ctx.fillStyle = '#2f3945';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(hLabel, 0, 0);
  ctx.restore();

  ctx.restore();
}

function drawScaleBar(ctx: CanvasRenderingContext2D, world: Rect, worldMeters: number): void {
  if (!(worldMeters > 0)) return;
  const pxPerMeter = world.width / worldMeters;
  if (!(pxPerMeter > 0)) return;
  const meters = niceStep(pxPerMeter, 100);
  const barPx = meters * pxPerMeter;
  const x0 = world.left + 12;
  const y = world.top + world.height - 14;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 4.5;
  ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + barPx, y); ctx.stroke();
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x0, y); ctx.lineTo(x0 + barPx, y);
  ctx.moveTo(x0, y - 5); ctx.lineTo(x0, y + 5);
  ctx.moveTo(x0 + barPx / 2, y - 3); ctx.lineTo(x0 + barPx / 2, y + 3);
  ctx.moveTo(x0 + barPx, y - 5); ctx.lineTo(x0 + barPx, y + 5);
  ctx.stroke();
  ctx.fillStyle = '#1c2430';
  ctx.font = 'bold 11px "Segoe UI", system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(meters >= 1 ? `${meters} m` : `${meters.toFixed(1)} m`, x0, y - 7);
  ctx.restore();
}

function drawTitleBlock(ctx: CanvasRenderingContext2D, world: Rect, p: Project, stamp = 'NoiseAtlas'): void {
  const w = Math.min(240, world.width * 0.42);
  const h = 46;
  if (world.width < 320 || world.height < 200) return;
  const x = world.left + world.width - w - 8;
  const y = world.top + world.height - h - 8;
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.strokeStyle = '#8b95a1';
  ctx.lineWidth = 1;
  ctx.fillRect(x, y, w, h);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.strokeStyle = '#d6dbe1';
  ctx.beginPath();
  ctx.moveTo(x, y + 18); ctx.lineTo(x + w, y + 18);
  ctx.stroke();
  ctx.fillStyle = '#1c2430';
  ctx.font = 'bold 11px "Segoe UI", system-ui';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.name.slice(0, 24), x + 8, y + 9);
  ctx.font = '10px "Segoe UI", system-ui';
  ctx.fillStyle = '#5a6472';
  const ws = worldSize(p);
  ctx.fillText(`图纸 ${ws.w.toFixed(1)} × ${ws.h.toFixed(1)} m · 底噪 ${p.backgroundNoiseDb} dBA`, x + 8, y + 28);
  ctx.fillText(stamp, x + 8, y + 40);
  ctx.restore();
}

/** Odeon / Raynoise 式：声压级色标贴在图纸右侧，纵向、带分贝刻度。 */
function drawSplScale(
  ctx: CanvasRenderingContext2D,
  world: Rect,
  field: FieldResult | null,
  bands: number,
): void {
  const x = world.left + world.width + 12;
  const barW = 16;
  const barH = Math.min(world.height * 0.9, 420);
  const y0 = world.top + (world.height - barH) / 2;
  if (world.width < 120) return;

  ctx.save();
  // 底板
  ctx.fillStyle = 'rgba(252,253,254,0.96)';
  ctx.strokeStyle = '#8b95a1';
  ctx.lineWidth = 1;
  const padX = 6;
  ctx.fillRect(x - padX, y0 - 18, barW + padX * 2 + 34, barH + 34);
  ctx.strokeRect(x - padX + 0.5, y0 - 18.5, barW + padX * 2 + 34, barH + 34);

  // 色带（低值在下）
  const colors = bandColors(bands, quantizeStep(bands));
  const n = colors.length;
  const bandH = barH / n;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = colors[n - 1 - i];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(x, y0 + i * bandH, barW, Math.ceil(bandH) + 0.6);
  }
  ctx.strokeStyle = '#5c6672';
  ctx.strokeRect(x + 0.5, y0 + 0.5, barW - 1, barH - 1);

  // 刻度
  const lo = field ? field.min : 0;
  const hi = field ? field.max : 100;
  const ticks = 5;
  ctx.font = '10px "Segoe UI", system-ui';
  ctx.fillStyle = '#2b333d';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < ticks; i++) {
    const frac = i / (ticks - 1);           // 0 = 顶部 = 最高值
    const y = y0 + barH * frac;
    const val = hi - (hi - lo) * frac;
    ctx.strokeStyle = '#5c6672';
    ctx.beginPath();
    ctx.moveTo(x + barW, y); ctx.lineTo(x + barW + 4, y);
    ctx.stroke();
    ctx.fillText(val.toFixed(0), x + barW + 6, y);
  }
  // 单位与标题
  ctx.font = 'bold 10px "Segoe UI", system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText('dB', x + barW / 2, y0 - 6);
  ctx.font = '9px "Segoe UI", system-ui';
  ctx.fillStyle = '#6f7885';
  ctx.fillText('SPL', x + barW / 2, y0 - 16);
  ctx.restore();
}

// ───────────────────────── sidebar / tree ─────────────────────────

const projectListEl = document.getElementById('project-list')!;
const storageHintEl = document.getElementById('storage-hint')!;
const projectCountEl = document.getElementById('project-count')!;
const objTreeEl = document.getElementById('obj-tree')!;

function renderSidebar(): void {
  projectListEl.innerHTML = '';
  const list = sortStore();
  projectCountEl.textContent = String(list.length);
  for (const { project } of list) {
    const item = document.createElement('div');
    item.className = 'project-item' + (project.id === currentId ? ' active' : '');
    item.innerHTML = `<div class="p-name"></div><div class="p-meta"></div>
      <button class="p-del" title="删除项目">删除</button>`;
    item.querySelector('.p-name')!.textContent = project.name;
    const ws0 = worldSize(project);
    item.querySelector('.p-meta')!.textContent = `${ws0.w.toFixed(0)}×${ws0.h.toFixed(0)} m`;
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('p-del')) return;
      currentId = project.id;
      renderAll();
    });
    item.querySelector('.p-del')!.addEventListener('click', () => {
      if (!confirm(`确定删除项目「${project.name}」及其全部测点数据？`)) return;
      store = store.filter((x) => x.project.id !== project.id);
      if (currentId === project.id) currentId = null;
      persist();
      renderAll();
    });
    projectListEl.appendChild(item);
  }
  storageHintEl.textContent = storageHint();
  if (supportsFsApi()) {
    storageHintEl.style.cursor = 'pointer';
    storageHintEl.onclick = () => void pickDataDir().then(renderSidebar);
  }
}

interface TreeNode {
  level: number;
  icon: string;
  name: string;
  badge?: string;
  cmd?: string;
  active?: boolean;
}

function renderTree(item: ProjectWithMeasurements | null): void {
  objTreeEl.innerHTML = '';
  if (!item) {
    const empty = document.createElement('div');
    empty.className = 'tree-node lvl-1';
    empty.innerHTML = '<span class="caret"></span><span class="t-name">（未打开项目）</span>';
    objTreeEl.appendChild(empty);
    return;
  }
  const p = item.project;
  const field = getCachedField(item);
  const sources = item.measurements.filter((m) => m.isNoiseSource).length;
  const cal = p.baseMapCalibration;
  const ws = worldSize(p);
  const nodes: TreeNode[] = [
    { level: 0, icon: '▣', name: p.name, badge: `${ws.w.toFixed(0)}×${ws.h.toFixed(0)} m`, cmd: 'tab-settings' },
    {
      level: 1, icon: '▤', name: '底图',
      badge: p.backgroundDxfText ? 'CAD' : p.backgroundImageData ? '位图' : '未导入',
      cmd: 'basemap',
    },
    {
      level: 2, icon: '⟷', name: '比例定标',
      badge: cal ? `${cal.meters.toFixed(1)} m` : '未定标',
      cmd: 'calibrate',
    },
    {
      level: 1, icon: '·', name: '测点数据', badge: `${item.measurements.length} 点`,
      cmd: 'tab-entry', active: activeTab === 'entry',
    },
    {
      level: 2, icon: '≈', name: '等声压级曲线',
      badge: field ? `${field.min.toFixed(0)}–${field.max.toFixed(0)} dB` : '—',
      cmd: 'tab-contour', active: activeTab === 'contour',
    },
    { level: 1, icon: '◎', name: '分析结果', badge: sources ? `${sources} 源` : '' },
    { level: 2, icon: '◉', name: '噪声源', badge: sources ? `${sources} 处` : '未识别', cmd: 'noise' },
  ];

  for (const n of nodes) {
    const el = document.createElement('div');
    el.className = `tree-node lvl-${n.level}` + (n.cmd ? ' clickable' : '') + (n.active ? ' active' : '');
    el.innerHTML = `<span class="caret">${n.level === 0 ? '▾' : ''}</span>
      <span class="t-ico">${n.icon}</span>
      <span class="t-name"></span>
      <span class="t-badge"></span>`;
    el.querySelector('.t-name')!.textContent = n.name;
    const badge = el.querySelector('.t-badge') as HTMLElement;
    if (n.badge) badge.textContent = n.badge; else badge.remove();
    if (n.cmd) el.addEventListener('click', () => runCmd(n.cmd!));
    objTreeEl.appendChild(el);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

// ───────────────────────── workspace & tabs ─────────────────────────

const emptyEl = document.getElementById('empty-state')!;
const wsEl = document.getElementById('workspace')!;
const zoomReadoutEl = document.getElementById('zoom-readout')!;

function switchTab(tab: typeof activeTab): void {
  activeTab = tab;
  document.querySelectorAll('.viewtab').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
  });
  for (const page of document.querySelectorAll('.tab-page')) {
    (page as HTMLElement).hidden = page.id !== `tab-${tab}`;
  }
  if (tab === 'contour') contourPlot.resize();
  if (tab === 'entry') entryPlot.resize();
  document.querySelectorAll('#m-nav .m-tab[data-tab]').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === tab);
  });
  renderTree(current());
  updateStatus();
}

document.querySelectorAll('.viewtab').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(((btn as HTMLElement).dataset.tab as typeof activeTab) ?? 'entry'));
});

function activePlot(): PlotCanvas {
  return activeTab === 'contour' ? contourPlot : entryPlot;
}

document.querySelectorAll('[data-zoom]').forEach((b) => {
  b.addEventListener('click', () => {
    const k = (b as HTMLElement).dataset.zoom!;
    const plot = activePlot();
    if (k === 'fit') plot.fit();
    else plot.zoomStep(k === 'in' ? 1.25 : 1 / 1.25);
  });
});

// ───────────────────────── entry tab ─────────────────────────

const entryPlot = new PlotCanvas(document.getElementById('entry-canvas-wrap')!);

function reportZoom(z: number): void {
  zoomReadoutEl.textContent = `${z.toFixed(1)}×`;
  updateStatus();
}

entryPlot.onZoomChange = reportZoom;

function splColor(t: number): string {
  const [r, g, b] = colormap(t);
  return `rgb(${r},${g},${b})`;
}

entryPlot.setPainter((world) => {
  const item = current();
  if (!item) return;
  const ctx = entryPlot.ctx2d;
  const { project } = item;
  const ws = worldSize(project);

  drawPaper(ctx, world);
  drawBasemap(ctx, world, project);
  if (prefs.showGridlines) drawRefGrid(ctx, world, ws, project);

  // 任意位置测点：颜色按声压级映射，可拖动/编辑
  const vals = item.measurements.map((m) => m.spl);
  const min = vals.length ? Math.min(...vals) : 0;
  const max = vals.length ? Math.max(...vals, min + 1e-6) : 1;
  const rad = Math.max(5, Math.min(9, world.width / 60));
  for (const m of item.measurements) {
    const { x: px, y: py } = pointToPx(world, project, m);
    const t = (m.spl - min) / (max - min || 1);
    ctx.beginPath();
    ctx.arc(px, py, rad, 0, Math.PI * 2);
    ctx.fillStyle = splColor(t);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    // 值标注：点密集时只在放大后显示
    if (m.id === draggingId) {
      ctx.beginPath();
      ctx.arc(px, py, rad + 5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(26,111,181,0.9)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (item.measurements.length <= 70 || entryPlot.transform.zoom >= 1.6) {
      ctx.fillStyle = '#101418';
      ctx.font = 'bold 10px "Segoe UI", system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.spl.toFixed(0), px, py - rad - 2);
      if (m.label) {
        ctx.font = '9px "Segoe UI", system-ui';
        ctx.fillStyle = '#4a5563';
        ctx.textBaseline = 'top';
        ctx.fillText(m.label, px, py + rad + 3);
      }
    }
  }

  if (item.measurements.length === 0) {
    ctx.fillStyle = 'rgba(60,72,86,0.55)';
    ctx.font = '12px "Segoe UI", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('在底图上任意位置单击，录入该点的声压级', world.left + world.width / 2, world.top + world.height / 2);
  }

  drawRulers(ctx, world, project);
  if (prefs.showDims) drawDimensions(ctx, world, project);
  drawTitleBlock(ctx, world, project);
  if (prefs.showScaleBar) drawScaleBar(ctx, world, worldSize(project).w);
});

entryPlot.onHover = (u, v) => reportCoords(u, v);
// 任意位置拾取：命中已有测点则编辑，否则在点击处新增
entryPlot.rawTapMode = true;
entryPlot.onRawTap = (u, v) => {
  const item = current();
  if (!item) return;
  const { project } = item;
  // 只在「纸张 ∪ 底图」范围内落点：点在画布留白处属于误触
  const c = entryPlot.contentRect;
  if (u < c.u0 - 0.004 || u > c.u1 + 0.004 || v < c.v0 - 0.004 || v > c.v1 + 0.004) return;
  const pos = pxToMeters(entryPlot.worldRect(), project, u, v);
  const ws = worldSize(project);
  const hitR = Math.hypot(ws.w, ws.h) * 0.022;   // 命中半径（米）
  const hit = item.measurements.find((m) => Math.hypot(m.x - pos.x, m.y - pos.y) <= hitR);
  openPointDialog(item, hit ? hit.x : pos.x, hit ? hit.y : pos.y, hit);
};

/** 测点 → 声场计算用点集 */
function splPoints(item: ProjectWithMeasurements): SplPoint[] {
  return item.measurements.map((m) => ({ x: m.x, y: m.y, spl: m.spl }));
}

/** 在画布上按米坐标定位测点 */
function pointToPx(world: Rect, p: Project, m: { x: number; y: number }): { x: number; y: number } {
  const ws = worldSize(p);
  return {
    x: world.left + (m.x / ws.w) * world.width,
    y: world.top + (m.y / ws.h) * world.height,
  };
}

/** 画布像素 → 米（图纸坐标） */
function pxToMeters(world: Rect, p: Project, u: number, v: number): { x: number; y: number } {
  const ws = worldSize(p);
  return { x: u * ws.w, y: v * ws.h };
}

/**
 * 测点标注：数值在上、编号在下（与现场底图的标注习惯一致）。
 * 点太密或缩放太小时自动省略，避免糊成一片。
 */
function drawPointLabels(
  ctx: CanvasRenderingContext2D,
  world: Rect,
  p: Project,
  item: ProjectWithMeasurements,
  opts: { value: boolean; label: boolean; zoom: number },
): void {
  const n = item.measurements.length;
  if (n === 0) return;
  // 缩得太小时全部挤在一起没有可读性：数值按 0.5× 起、编号按 0.9× 起显示
  const showValue = opts.value && n <= 90 && (opts.zoom >= 0.5 || n <= 20);
  const showLabel = opts.label && n <= 90 && (opts.zoom >= 0.9 || n <= 12);
  if (!showValue && !showLabel) return;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  for (const m of item.measurements) {
    const { x: px, y: py } = pointToPx(world, p, m);
    if (px < world.left - 40 || px > world.left + world.width + 40) continue;
    if (py < world.top - 30 || py > world.top + world.height + 30) continue;

    if (showValue) {
      const txt = m.spl.toFixed(1).replace(/\.0$/, '');
      ctx.font = 'bold 10.5px "Segoe UI", system-ui';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(txt, px, py - 8);
      ctx.fillStyle = '#1f2733';
      ctx.fillText(txt, px, py - 8);
    }
    if (showLabel && m.label) {
      ctx.font = '9.5px "Segoe UI", system-ui';
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(m.label, px, py + 15);
      ctx.fillStyle = '#3a4450';
      ctx.fillText(m.label, px, py + 15);
    }
  }
  ctx.restore();
}

// ───────────────────────── 拖动测点 ─────────────────────────

let draggingId: string | null = null;

/** 命中测试：画布像素位置附近的测点（阈值 14px） */
function hitPoint(item: ProjectWithMeasurements, plot: PlotCanvas, px: number, py: number): Measurement | null {
  const world = plot.worldRect();
  let best: Measurement | null = null;
  let bestD = Infinity;
  for (const m of item.measurements) {
    const q = pointToPx(world, item.project, m);
    const d = Math.hypot(q.x - px, q.y - py);
    if (d < bestD) { bestD = d; best = m; }
  }
  return bestD <= 14 ? best : null;
}

/** 把画布像素换算成图纸米制坐标并夹在范围内 */
function movePointTo(item: ProjectWithMeasurements, plot: PlotCanvas, m: Measurement, px: number, py: number): void {
  const world = plot.worldRect();
  const ws = worldSize(item.project);
  const nx = ((px - world.left) / Math.max(1e-6, world.width)) * ws.w;
  const ny = ((py - world.top) / Math.max(1e-6, world.height)) * ws.h;
  m.x = Math.min(ws.w, Math.max(0, nx));
  m.y = Math.min(ws.h, Math.max(0, ny));
}

function bindPointDrag(plot: PlotCanvas): void {
  plot.onPointDragStart = (px, py) => {
    const item = current();
    if (!item || item.measurements.length === 0) return false;
    const hit = hitPoint(item, plot, px, py);
    if (!hit) return false;
    draggingId = hit.id;
    plot.canvas.style.cursor = 'grabbing';
    return true;
  };
  plot.onPointDragMove = (px, py) => {
    const item = current();
    if (!item || !draggingId) return;
    const m = item.measurements.find((x) => x.id === draggingId);
    if (!m) return;
    movePointTo(item, plot, m, px, py);
    plot.paint();
  };
  plot.onPointDragEnd = () => {
    const item = current();
    if (item && draggingId) {
      touch(item.project);
      persist();
      splFieldCache = null;
    }
    draggingId = null;
    renderAll();
  };
}

bindPointDrag(entryPlot);

// ───────────────────────── 通用表单弹窗 ─────────────────────────
// 安卓 WebView 不支持 window.prompt()（调用直接返回 null，界面毫无反应），
// 所有需要输入的地方统一走这个应用内弹窗。

interface FieldSpec {
  key: string;
  label: string;
  value?: string | number;
  type?: 'text' | 'number';
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

function showForm(title: string, fields: FieldSpec[], submitText = '确定'): Promise<Record<string, string> | null> {
  const fd = document.getElementById('form-dialog') as HTMLDialogElement;
  const body = document.getElementById('fd-body')!;
  const titleEl = document.getElementById('fd-title')!;
  const submit = document.getElementById('fd-submit') as HTMLButtonElement;

  const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

  titleEl.textContent = title;
  submit.textContent = submitText;
  body.innerHTML = fields.map((f) => {
    const type = f.type ?? 'text';
    const attrs = [
      'data-key="' + esc(f.key) + '"',
      'type="' + type + '"',
      'value="' + esc(f.value ?? '') + '"',
      f.min !== undefined ? 'min="' + f.min + '"' : '',
      f.max !== undefined ? 'max="' + f.max + '"' : '',
      f.step !== undefined ? 'step="' + f.step + '"' : '',
      f.placeholder ? 'placeholder="' + esc(f.placeholder) + '"' : '',
      'inputmode="' + (type === 'number' ? 'decimal' : 'text') + '"',
    ].filter(Boolean).join(' ');
    return '<label>' + esc(f.label) + '<input ' + attrs + ' /></label>';
  }).join('');

  return new Promise((resolve) => {
    const onClose = () => {
      fd.removeEventListener('close', onClose);
      if (fd.returnValue !== 'ok') {
        resolve(null);
        return;
      }
      const out: Record<string, string> = {};
      body.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((el) => {
        out[el.dataset.key!] = el.value;
      });
      resolve(out);
    };
    fd.addEventListener('close', onClose);
    fd.returnValue = '';
    fd.showModal();
    body.querySelector<HTMLInputElement>('input')?.focus();
  });
}

// 录入弹窗
const dlg = document.getElementById('point-dialog') as HTMLDialogElement;
let dialogTarget: { x: number; y: number; id?: string } | null = null;

function openPointDialog(item: ProjectWithMeasurements, x: number, y: number, existing?: Measurement): void {
  dialogTarget = { x, y, id: existing?.id };
  const { project } = item;
  const ws = worldSize(project);
  (document.getElementById('pd-title') as HTMLElement).textContent =
    `${existing ? '编辑测点' : '新增测点'} · x=${x.toFixed(2)} m  y=${y.toFixed(2)} m`
    + `　（图纸 ${ws.w.toFixed(1)}×${ws.h.toFixed(1)} m）`;
  (document.getElementById('pd-spl') as HTMLInputElement).value = existing ? String(existing.spl) : '';
  (document.getElementById('pd-label') as HTMLInputElement).value = existing?.label ?? '';
  (document.getElementById('pd-note') as HTMLInputElement).value = existing?.note ?? '';
  (document.getElementById('pd-clear') as HTMLElement).style.display = existing ? '' : 'none';
  dlg.showModal();
  const splInput = document.getElementById('pd-spl') as HTMLInputElement;
  splInput.focus();
  splInput.select();
}

document.getElementById('pd-save')!.addEventListener('click', () => {
  const item = current();
  if (!item || !dialogTarget) return;
  const v = parseFloat((document.getElementById('pd-spl') as HTMLInputElement).value);
  if (Number.isNaN(v)) { dlg.close(); return; }
  const note = (document.getElementById('pd-note') as HTMLInputElement).value;
  const label = (document.getElementById('pd-label') as HTMLInputElement).value.trim();
  const target = dialogTarget;
  const idx = target.id
    ? item.measurements.findIndex((m) => m.id === target.id)
    : item.measurements.findIndex((m) => Math.hypot(m.x - target.x, m.y - target.y) < 1e-6);
  const prev = idx >= 0 ? item.measurements[idx] : null;
  const meas: Measurement = {
    projectId: item.project.id,
    id: prev ? prev.id : newPointId(),
    x: target.x,
    y: target.y,
    spl: v,
    note,
    label: label || undefined,
    // 编辑已锚定的测点时保留锚点，避免它脱离底图
    ...(prev?.bu !== undefined && prev.bv !== undefined ? { bu: prev.bu, bv: prev.bv } : {}),
  };
  if (idx >= 0) item.measurements[idx] = meas; else item.measurements.push(meas);
  touch(item.project);
  persist();
  splFieldCache = null;
  renderAll();
  dlg.close();
});

document.getElementById('pd-clear')!.addEventListener('click', () => {
  const item = current();
  if (!item || !dialogTarget) return;
  const target = dialogTarget;
  item.measurements = item.measurements.filter((m) =>
    target.id ? m.id !== target.id : Math.hypot(m.x - target.x, m.y - target.y) > 1e-6);
  touch(item.project);
  persist();
  splFieldCache = null;
  renderAll();
  dlg.close();
});

// ───────────────────────── contour tab ─────────────────────────

const contourPlot = new PlotCanvas(document.getElementById('contour-canvas-wrap')!);
contourPlot.padRight = 92; // 右侧留出声压级色标

const alphaSlider = document.getElementById('alpha-slider') as HTMLInputElement;
const alphaLabel = document.getElementById('alpha-label')!;
const contourLegendEl = document.getElementById('contour-legend')!;
const bandChoicesEl = document.getElementById('band-choices')!;
const basemapHintEl = document.getElementById('basemap-hint')!;
const noiseHintEl = document.getElementById('noise-hint')!;
const contourStatsEl = document.getElementById('contour-stats')!;

contourPlot.onZoomChange = reportZoom;
contourPlot.onHover = (u, v) => reportCoords(u, v);

let splFieldCache: { key: string; field: FieldResult } | null = null;

function getCachedField(item: ProjectWithMeasurements): FieldResult | null {
  const pts = splPoints(item);
  if (pts.length === 0) return null;
  const ws = worldSize(item.project);

  // 底图可能超出纸张（定标放大后）：成图范围要把它一起包进来，
  // 否则等压级图只覆盖纸面，底图边缘没有颜色。
  const aspect = basemapAspect();
  const bmRect = aspect > 0 ? baseMapRectMeters(item.project, aspect) : null;
  const cover: Domain | null = bmRect
    ? { x0: bmRect.left, y0: bmRect.top, w: bmRect.width, h: bmRect.height }
    : null;

  const domain = fieldDomain(pts, ws, { scope: prefs.fieldScope, cover });
  if (!domain) return null;
  const key = pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.spl}`).sort().join(';')
    + `|${ws.w}|${ws.h}|${item.project.backgroundNoiseDb}|${prefs.fieldScope}`
    + `|${cover ? `${cover.x0.toFixed(2)},${cover.y0.toFixed(2)},${cover.w.toFixed(2)},${cover.h.toFixed(2)}` : '-'}`;
  if (splFieldCache?.key === key) return splFieldCache.field;

  // 范围越大，网格越要细一点，否则大图纸上色块明显
  const resX = Math.min(360, Math.max(160, Math.round(domain.w / 0.45)));
  const field = computeSplFieldPoints(pts, domain, item.project.backgroundNoiseDb, undefined, resX);
  if (!field) return null;
  splFieldCache = { key, field };
  return field;
}

contourPlot.setPainter((world) => {
  const item = current();
  if (!item) return;
  const ctx = contourPlot.ctx2d;
  const field = getCachedField(item);
  const { project } = item;
  const ws = worldSize(project);

  drawPaper(ctx, world);
  drawBasemap(ctx, world, project);
  if (prefs.showGridlines) drawRefGrid(ctx, world, ws, project);

  if (field) {
    // 场只覆盖测点包围盒（外扩 12%），映射到画布对应矩形
    const dx = world.left + (field.domain.x0 / ws.w) * world.width;
    const dy = world.top + (field.domain.y0 / ws.h) * world.height;
    const dw = (field.domain.w / ws.w) * world.width;
    const dh = (field.domain.h / ws.h) * world.height;

    const off = document.createElement('canvas');
    off.width = field.resX;
    off.height = field.resY;
    off.getContext('2d')!.putImageData(
      renderFieldImageData(field, project.contourColorBands, parseFloat(alphaSlider.value) / 100, 0.07), 0, 0,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = true;

    if (prefs.showContours) {
      const levels = defaultLevels(field.min, field.max);
      ctx.strokeStyle = 'rgba(18,22,28,0.78)';
      ctx.lineWidth = 1.15;
      ctx.beginPath();
      for (const level of levels) {
        for (const sgm of contours(field, level)) {
          ctx.moveTo(dx + (sgm.x1 / field.resX) * dw, dy + (sgm.y1 / field.resY) * dh);
          ctx.lineTo(dx + (sgm.x2 / field.resX) * dw, dy + (sgm.y2 / field.resY) * dh);
        }
      }
      ctx.stroke();
    }
  }

  if (prefs.showPoints) {
    const range = field ? field.max - field.min : 1;
    for (const m of item.measurements) {
      const { x: px, y: py } = pointToPx(world, project, m);
      const t = field ? (m.spl - field.min) / (range || 1) : 0.5;
      const [cr, cg, cb] = colormap(t);
      ctx.beginPath();
      ctx.arc(px, py, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (m.isNoiseSource) {
        ctx.beginPath();
        ctx.arc(px, py, 11, 0, Math.PI * 2);
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }
    }
    drawPointLabels(ctx, world, project, item, {
      value: true,
      label: true,
      zoom: contourPlot.transform.zoom,
    });
  }

  if (prefs.showCalib) drawCalibration(ctx, world, project);
  drawRulers(ctx, world, project);
  if (prefs.showDims) drawDimensions(ctx, world, project);
  drawSplScale(ctx, world, field, project.contourColorBands);
  drawTitleBlock(ctx, world, project, `${item.measurements.length} 个测点`);
  if (prefs.showScaleBar) drawScaleBar(ctx, world, worldSize(project).w);
});

bindPointDrag(contourPlot);

alphaSlider.addEventListener('input', () => {
  const item = current();
  alphaLabel.textContent = `${alphaSlider.value}%`;
  if (!item) return;
  item.project.overlayAlpha = parseInt(alphaSlider.value, 10) / 100;
  touch(item.project);
  persist();
  contourPlot.paint();
});

// ── 显示开关 ──

function bindToggle(id: string, key: keyof UiPrefs): void {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  el.checked = Boolean(prefs[key]);
  el.addEventListener('change', () => {
    (prefs as any)[key] = el.checked;
    savePrefs();
    contourPlot.paint();
    entryPlot.paint();
  });
}

bindToggle('chk-calib', 'showCalib');
bindToggle('chk-points', 'showPoints');
bindToggle('chk-contours', 'showContours');
bindToggle('chk-gridlines', 'showGridlines');
bindToggle('chk-dims', 'showDims');
bindToggle('chk-scalebar', 'showScaleBar');

// ── 计算范围：整幅图纸 / 仅测点区域 ──

function applyScopeButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('#scope-choices [data-scope]').forEach((b) => {
    b.classList.toggle('active', b.dataset.scope === prefs.fieldScope);
  });
}

function setFieldScope(scope: FieldScope): void {
  if (prefs.fieldScope === scope) return;
  prefs.fieldScope = scope;
  savePrefs();
  applyScopeButtons();
  splFieldCache = null;           // 范围变了，声场必须重算
  const item = current();
  if (item) {
    renderLegend(item);
    renderStats(item);
  }
  contourPlot.paint();
}

document.querySelectorAll<HTMLButtonElement>('#scope-choices [data-scope]').forEach((b) => {
  b.addEventListener('click', () => setFieldScope((b.dataset.scope as FieldScope) ?? 'paper'));
});
applyScopeButtons();

// ── 色阶 ──

function renderBandChoices(): void {
  const item = current();
  if (!item) return;
  bandChoicesEl.innerHTML = '';
  for (const b of [8, 16, 24, 32, 64, 128, 256]) {
    const btn = document.createElement('button');
    btn.className = item.project.contourColorBands === b ? 'active' : '';
    btn.textContent = String(b);
    btn.addEventListener('click', () => {
      item.project.contourColorBands = b;
      touch(item.project);
      persist();
      renderBandChoices();
      renderLegend(item);
      contourPlot.paint();
    });
    bandChoicesEl.appendChild(btn);
  }
}

function renderLegend(item: ProjectWithMeasurements): void {
  const bands = item.project.contourColorBands;
  const colors = bandColors(bands, quantizeStep(bands));
  const field = getCachedField(item);
  const lo = field ? field.min : 0;
  const hi = field ? field.max : 100;

  contourLegendEl.innerHTML = `
    <div class="legend-vbar">
      <canvas id="legend-canvas" width="24" height="170"></canvas>
      <div class="legend-ticks">
        <span>${hi.toFixed(0)}</span>
        <span>${(lo + (hi - lo) * 0.75).toFixed(0)}</span>
        <span>${((lo + hi) / 2).toFixed(0)}</span>
        <span>${(lo + (hi - lo) * 0.25).toFixed(0)}</span>
        <span>${lo.toFixed(0)}</span>
      </div>
    </div>
    <div class="legend-note">${field ? `色阶 ${bands} 级 · 蓝低 → 红高` : `色阶 ${bands} 级 · 尚无测点`}</div>
    <div class="legend-note">红圈 = 疑似噪声源 · 黄虚线 = 定标线段</div>`;

  const cv = document.getElementById('legend-canvas') as HTMLCanvasElement | null;
  if (!cv) return;
  const ctx = cv.getContext('2d')!;
  const n = colors.length;
  const bandH = cv.height / n;
  for (let i = 0; i < n; i++) {
    const [r, g, b] = colors[n - 1 - i];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, i * bandH, cv.width, Math.ceil(bandH) + 0.5);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.strokeRect(0.5, 0.5, cv.width - 1, cv.height - 1);
}

// ── 底图导入 ──

function hintBasemap(p: Project): void {
  const kind = p.backgroundDxfText
    ? 'CAD 矢量线图'
    : p.backgroundImageData
      ? '位图（图片 / PDF 第 1 页）'
      : '';
  const cal = p.baseMapCalibration;
  basemapHintEl.textContent = !kind
    ? '未导入底图。支持 JPG / PNG / WebP / PDF / DXF。'
    : cal
      ? `${kind} · 已定标 ${cal.meters.toFixed(1)} m · 缩放 ${p.baseMapScale.toFixed(2)}×`
      : `${kind} · 未定标（建议用「两点定标」校准比例）`;
}

async function downscaleToDataUrl(src: CanvasImageSource, w: number, h: number, max = 1600): Promise<string> {
  const scale = Math.min(1, max / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const chh = Math.max(1, Math.round(h * scale));
  const cv = document.createElement('canvas');
  cv.width = cw;
  cv.height = chh;
  const c = cv.getContext('2d')!;
  c.fillStyle = '#fff';
  c.fillRect(0, 0, cw, chh);
  c.drawImage(src, 0, 0, cw, chh);
  return cv.toDataURL('image/jpeg', 0.85);
}

const basemapFile = document.getElementById('basemap-file') as HTMLInputElement;

basemapFile.addEventListener('change', async () => {
  const item = current();
  const file = basemapFile.files?.[0];
  if (!item || !file) return;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  try {
    if (ext === 'dxf') {
      const text = await file.text();
      if (!readDxf(text)) throw new Error('DXF 中未找到可用的线图');
      item.project.backgroundDxfText = text;
      item.project.backgroundImageData = null;
    } else if (ext === 'pdf') {
      const buf = await file.arrayBuffer();
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 2 });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const c = cv.getContext('2d')!;
      c.fillStyle = '#fff';
      c.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: c, viewport: vp }).promise;
      item.project.backgroundImageData = await downscaleToDataUrl(cv, cv.width, cv.height);
      item.project.backgroundDxfText = null;
      await doc.destroy();
    } else {
      const url = URL.createObjectURL(file);
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        item.project.backgroundImageData = await downscaleToDataUrl(img, img.naturalWidth, img.naturalHeight);
        item.project.backgroundDxfText = null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    item.project.baseMapCalibration = null;
    touch(item.project);
    persist();
    refreshBasemapCache(item.project);
    hintBasemap(item.project);
    renderAll();
    // 底图比纸面大时先适配一次，避免新导入就“看不见全貌”
    if (contourPlot.contentOverflow()) contourPlot.fit();
    if (entryPlot.contentOverflow()) entryPlot.fit();
  } catch (err) {
    alert('底图导入失败：' + (err as Error).message);
  }
  basemapFile.value = '';
});

document.querySelectorAll('[data-bm]').forEach((b) => {
  b.addEventListener('click', () => {
    const item = current();
    if (!item) return;
    const p = item.project;
    const k = (b as HTMLElement).dataset.bm!;
    if (k === 'in') p.baseMapScale = Math.min(5, p.baseMapScale * 1.1);
    else if (k === 'out') p.baseMapScale = Math.max(0.2, p.baseMapScale / 1.1);
    else if (k === 'left') p.baseMapOffsetX = Math.max(-0.5, p.baseMapOffsetX - 0.02);
    else if (k === 'right') p.baseMapOffsetX = Math.min(0.5, p.baseMapOffsetX + 0.02);
    else if (k === 'up') p.baseMapOffsetY = Math.max(-0.5, p.baseMapOffsetY - 0.02);
    else if (k === 'down') p.baseMapOffsetY = Math.min(0.5, p.baseMapOffsetY + 0.02);
    else if (k === 'reset') { p.baseMapScale = 1; p.baseMapOffsetX = 0; p.baseMapOffsetY = 0; }
    touch(p);
    persist();
    applyAnchors(item);   // 测点跟着底图走
    updateContentRect(item);
    hintBasemap(p);
    renderStats(item);
    entryPlot.paint();
    contourPlot.paint();
  });
});

// ── 两点定标 ──

const calibBanner = document.getElementById('calib-banner') as HTMLElement;
const calibrateBtn = document.getElementById('btn-calibrate') as HTMLButtonElement;
let calibMode = false;
let calibPts: Array<{ u: number; v: number }> = [];

function setCalibMode(on: boolean): void {
  calibMode = on;
  calibPts = [];
  contourPlot.rawTapMode = on;
  calibBanner.hidden = !on;
  calibrateBtn.classList.toggle('active', on);
  if (on && activeTab !== 'contour') switchTab('contour');
  contourPlot.paint();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && calibMode) setCalibMode(false);
});

function drawCalibration(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const saved = p.baseMapCalibration;
  let a: { u: number; v: number } | null = null;
  let b: { u: number; v: number } | null = null;
  let label = '';
  if (calibMode) {
    a = calibPts[0] ?? null;
    b = calibPts[1] ?? null;
    label = calibPts.length === 1 ? '再点第二个点' : '';
  } else if (saved) {
    a = { u: saved.u1, v: saved.v1 };
    b = { u: saved.u2, v: saved.v2 };
    label = `${saved.meters.toFixed(1)} m`;
  }
  if (!a) return;

  const toPx = (q: { u: number; v: number }) => ({
    x: world.left + q.u * world.width,
    y: world.top + q.v * world.height,
  });
  const pa = toPx(a);
  ctx.save();
  ctx.strokeStyle = '#c8920a';
  ctx.fillStyle = '#c8920a';
  ctx.lineWidth = 1.8;
  ctx.setLineDash([7, 4]);
  if (b) {
    const pb = toPx(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    for (const q of [pa, pb]) {
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.strokeStyle = '#c8920a';
      ctx.lineWidth = 1.8;
    }
    if (label) {
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2 - 9;
      ctx.font = 'bold 11px "Segoe UI", system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(255,255,255,0.92)';
      ctx.strokeText(label, mx, my);
      ctx.fillStyle = '#7a5b00';
      ctx.fillText(label, mx, my);
    }
  } else {
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pa.x, pa.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    if (label) {
      ctx.font = 'bold 11px "Segoe UI", system-ui';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#7a5b00';
      ctx.fillText(label, pa.x + 9, pa.y - 6);
    }
  }
  ctx.restore();
}

contourPlot.onRawTap = async (u, v) => {
  if (!calibMode) return;
  const item = current();
  if (!item) return;
  const p = item.project;
  if (!p.backgroundImageData && !p.backgroundDxfText) {
    alert('请先导入底图，再使用两点定标。');
    setCalibMode(false);
    return;
  }
  const cc = contourPlot.contentRect;
  if (u < cc.u0 - 0.004 || u > cc.u1 + 0.004 || v < cc.v0 - 0.004 || v > cc.v1 + 0.004) return;
  calibPts.push({ u, v });
  if (calibPts.length === 1) {
    contourPlot.paint();
    return;
  }

  const [a, b] = calibPts;
  const { w: W, h: H } = worldSize(p);
  const gridMeters = Math.hypot((b.u - a.u) * W, (b.v - a.v) * H);
  if (!(gridMeters > 1e-6)) {
    calibPts = [];
    contourPlot.paint();
    return;
  }
  const values = await showForm('两点定标', [
    {
      key: 'meters',
      label: `这两点实际多少米？（按当前网格比例量得 ${gridMeters.toFixed(2)} m）`,
      value: gridMeters.toFixed(1), type: 'number', min: 0.1, step: 0.1,
    },
  ], '应用校准');
  if (!values) { calibPts = []; contourPlot.paint(); return; }
  const realM = parseFloat(values.meters);
  if (!Number.isFinite(realM) || realM <= 0) {
    calibPts = [];
    contourPlot.paint();
    return;
  }
  const factor = realM / gridMeters;
  p.baseMapScale = Math.min(5, Math.max(0.2, p.baseMapScale * factor));
  p.baseMapCalibration = { u1: a.u, v1: a.v, u2: b.u, v2: b.v, meters: realM };
  p.planReferenceMeters = W;
  touch(p);
  persist();
  applyAnchors(item);   // 定标改变底图缩放 => 锚定测点重新落位
  updateContentRect(item);
  setCalibMode(false);
  hintBasemap(p);
  renderAll();
  // 定标后底图常会超出纸面：自动按「内容范围」适配一次，
  // 保证整幅底图与全部测点都落在可视区内（否则会看着像“图飞了”）。
  if (contourPlot.contentOverflow()) contourPlot.fit();
  alert(`已校准：底图缩放 ×${factor.toFixed(3)}（现为 ${p.baseMapScale.toFixed(2)}×）\n比例尺已按真实米制显示。`);
};

// ── 噪声源识别 ──

async function runNoiseDetect(): Promise<void> {
  const item = current();
  if (!item) { alert('请先打开项目'); return; }
  if (item.measurements.length === 0) { alert('请先录入测点数据'); return; }
  const values = await showForm('识别噪声源', [
    {
      key: 'thr',
      label: '判定阈值 (dB)：低于该值的测点不参与',
      value: 70, type: 'number', min: 0, max: 200, step: 0.1,
    },
  ], '开始识别');
  if (!values) return;
  const thr = parseFloat(values.thr);
  if (Number.isNaN(thr)) return;
  const sources = detectNoiseSources(item.measurements, thr, item.project.backgroundNoiseDb);
  const keys = new Set(sources.map((s) => s.id));
  for (const m of item.measurements) m.isNoiseSource = keys.has(m.id);
  touch(item.project);
  persist();
  noiseHintEl.textContent = `识别到 ${sources.length} 个疑似噪声源（红圈标记）`;
  renderAll();
  switchTab('contour');
}

// ───────────────────────── settings ─────────────────────────

const settingsForm = document.getElementById('settings-form') as HTMLFormElement;

function field(name: string): HTMLInputElement {
  return settingsForm.elements.namedItem(name) as HTMLInputElement;
}

function fillSettings(p: Project): void {
  const ws = worldSize(p);
  field('name').value = p.name;
  field('description').value = p.description;
  field('worldW').value = String(Number(ws.w.toFixed(2)));
  field('worldH').value = String(Number(ws.h.toFixed(2)));
  field('backgroundNoiseDb').value = String(p.backgroundNoiseDb);
}

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const item = current();
  if (!item) return;
  const p = item.project;
  const ws0 = worldSize(p);
  p.name = field('name').value.trim() || p.name;
  p.description = field('description').value;
  p.worldW = Math.max(1, parseFloat(field('worldW').value) || ws0.w);
  p.worldH = Math.max(1, parseFloat(field('worldH').value) || ws0.h);
  p.backgroundNoiseDb = Math.max(0, parseFloat(field('backgroundNoiseDb').value) || 0);
  touch(p);
  persist();
  splFieldCache = null;
  renderAll();
  alert('设置已保存');
});

// ───────────────────────── 状态栏 / 统计 ─────────────────────────

const stCoords = document.getElementById('st-coords')!;
const stZoom = document.getElementById('st-zoom')!;
const stProgress = document.getElementById('st-progress')!;
const stGrid = document.getElementById('st-grid')!;

function reportCoords(u: number, v: number): void {
  const item = current();
  if (!item || !Number.isFinite(u) || !Number.isFinite(v)) {
    stCoords.textContent = 'X — m　Y — m';
    return;
  }
  const p = item.project;
  const ws = worldSize(p);
  stCoords.textContent = `X ${(u * ws.w).toFixed(2)} m　Y ${(v * ws.h).toFixed(2)} m`;
}

function updateStatus(): void {
  const item = current();
  const z = activePlot().transform.zoom;
  stZoom.textContent = `缩放 ${z.toFixed(1)}×`;
  if (!item) {
    stProgress.textContent = '已测 0 / 0';
    stGrid.textContent = '网格 —';
    return;
  }
  const p = item.project;
  const ws = worldSize(p);
  stProgress.textContent = `测点 ${item.measurements.length} 个`;
  stGrid.textContent = `图纸 ${ws.w.toFixed(1)}×${ws.h.toFixed(1)} m · 定标 ${p.baseMapCalibration ? '已定标' : '未定标'} · 底噪 ${p.backgroundNoiseDb} dBA`;
}

function renderStats(item: ProjectWithMeasurements | null): void {
  if (!item) { contourStatsEl.innerHTML = ''; return; }
  const field = getCachedField(item);
  const sources = item.measurements.filter((m) => m.isNoiseSource).length;
  const ws = worldSize(item.project);
  const rows: Array<[string, string]> = [
    ['测点', `${item.measurements.length} 个`],
    ['声压级', field ? `${field.min.toFixed(1)} – ${field.max.toFixed(1)} dB` : '—'],
    ['噪声源', sources ? `${sources} 处` : '未识别'],
    ['覆盖范围', field ? `${field.domain.w.toFixed(1)} × ${field.domain.h.toFixed(1)} m` : '—'],
    ['图纸', `${ws.w.toFixed(1)} × ${ws.h.toFixed(1)} m`],
    ['定标', item.project.baseMapCalibration ? `${item.project.baseMapCalibration.meters.toFixed(1)} m` : '未定标'],
  ];
  contourStatsEl.innerHTML = rows
    .map(([k, v]) => `<span class="k">${k}</span><span class="v">${escapeHtml(v)}</span>`)
    .join('');
}

// ───────────────────────── 导出 / 复制 ─────────────────────────

function downloadBlob(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 导出前切到等声压级图并重绘，确保导出的是完整图纸。 */
function prepareExport(): ProjectWithMeasurements | null {
  const item = current();
  if (!item) { alert('请先打开项目'); return null; }
  if (activeTab !== 'contour') switchTab('contour');
  contourPlot.resize();
  contourPlot.paint();
  return item;
}

function exportImage(): void {
  const item = prepareExport();
  if (!item) return;
  contourPlot.canvas.toBlob((b) => {
    if (!b) { alert('导出失败：无法生成图像'); return; }
    downloadBlob(b, `${item.project.name}-等声压级图.png`);
  }, 'image/png');
}

async function exportPdf(): Promise<void> {
  const item = prepareExport();
  if (!item) return;
  try {
    const { jsPDF } = await import('jspdf');
    const cv = contourPlot.canvas;
    const img = cv.toDataURL('image/png');
    const w = cv.width, h = cv.height;
    const landscape = w >= h;
    const pdf = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth();
    const ph = pdf.internal.pageSize.getHeight();
    const margin = 10;
    pdf.setFontSize(11);
    pdf.text(`NoiseAtlas · ${item.project.name} · 等声压级图`, margin, margin + 3);
    const availW = pw - margin * 2;
    const availH = ph - margin * 2 - 8;
    const scale = Math.min(availW / w, availH / h);
    pdf.addImage(img, 'PNG', margin + (availW - w * scale) / 2, margin + 8, w * scale, h * scale);
    pdf.save(`${item.project.name}-等声压级图.pdf`);
  } catch (err) {
    alert('PDF 导出失败：' + (err as Error).message);
  }
}

async function copyImage(): Promise<void> {
  const item = prepareExport();
  if (!item) return;
  try {
    const blob = await new Promise<Blob | null>((res) => contourPlot.canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('无法生成图像');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    alert('图像已复制到剪贴板，可直接粘贴到 Word / CAD / 聊天工具。');
  } catch (err) {
    alert('复制失败（浏览器可能不支持图片剪贴板）：' + (err as Error).message);
  }
}

// ───────────────────────── 菜单栏 ─────────────────────────

const menuPanels = ['file', 'edit', 'view', 'calc', 'help'];

function closeMenus(): void {
  for (const m of menuPanels) {
    const panel = document.getElementById(`menu-${m}`);
    if (panel) panel.hidden = true;
  }
  document.querySelectorAll('#menubar .menu').forEach((b) => b.classList.remove('open'));
}

document.querySelectorAll('#menubar .menu').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const id = `menu-${(btn as HTMLElement).dataset.menu}`;
    const panel = document.getElementById(id)!;
    const wasOpen = !panel.hidden;
    closeMenus();
    if (wasOpen) return;
    // 工具栏 32px 之后定位
    const r = (btn as HTMLElement).getBoundingClientRect();
    panel.style.left = `${Math.round(r.left)}px`;
    panel.style.top = `${Math.round(r.bottom + 2)}px`;
    panel.hidden = false;
    btn.classList.add('open');
  });
});

document.addEventListener('click', () => closeMenus());
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });

document.querySelectorAll('.menu-panel button[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => {
    const cmd = (b as HTMLElement).dataset.cmd!;
    closeMenus();
    runCmd(cmd);
  });
});


// ───────────────────────── 面板位置自适应 ─────────────────────────
// 桌面：面板是「等声压级图」页签内的右栏（布局的一部分）。
// 移动：面板改为全屏上滑抽屉，必须挂到 body 顶层，否则切到「录入/设置」页签时
// 它随页签一起被 hidden 掉，只剩遮罩可见（用户报的"只有遮罩看不到界面"）。

const dockEl = document.getElementById('right-dock')!;
const dockHome = dockEl.parentElement!;
const mqMobile = window.matchMedia('(max-width: 980px)');

function syncDockPlacement(): void {
  if (mqMobile.matches) {
    if (dockEl.parentElement !== document.body) document.body.appendChild(dockEl);
  } else if (dockEl.parentElement !== dockHome) {
    dockHome.appendChild(dockEl);
    dockEl.classList.remove('open');
  }
}
syncDockPlacement();
mqMobile.addEventListener('change', syncDockPlacement);

// ───────────────────────── 移动端交互 ─────────────────────────

const mSidebar = document.getElementById('sidebar')!;
const mDock = document.getElementById('right-dock')!;
const mMask = document.getElementById('m-mask') as HTMLElement;
const mTools = document.getElementById('m-sheet-tools') as HTMLElement;

function anySheetOpen(): boolean {
  return mSidebar.classList.contains('open')
    || mDock.classList.contains('open')
    || mTools.classList.contains('open');
}

function syncMask(): void {
  mMask.hidden = !anySheetOpen();
}

function closeAllSheets(): void {
  mSidebar.classList.remove('open');
  mDock.classList.remove('open');
  mTools.classList.remove('open');
  syncMask();
}

function openSheet(el: HTMLElement): void {
  const wasOpen = el.classList.contains('open');
  closeAllSheets();
  if (!wasOpen) {
    el.hidden = false;          // 有的面板在 HTML 里带 hidden，类切换不够
    el.classList.add('open');
    syncMask();
  }
}

document.getElementById('m-btn-projects')?.addEventListener('click', () => openSheet(mSidebar));
document.getElementById('m-btn-layers')?.addEventListener('click', () => {
  document.querySelectorAll('#right-dock .dock-sec').forEach((sec) => sec.classList.remove('collapsed'));
  openSheet(mDock);
});
document.getElementById('dock-close')?.addEventListener('click', () => closeAllSheets());
document.getElementById('m-btn-actions')?.addEventListener('click', () => openSheet(mTools));
document.getElementById('m-btn-tools')?.addEventListener('click', () => openSheet(mTools));
mMask.addEventListener('click', closeAllSheets);
document.querySelector('#m-sheet-tools .m-sheet-close')?.addEventListener('click', closeAllSheets);

// 工具抽屉与等压级图顶部快捷条，按钮统一复用命令
document.querySelectorAll('#m-sheet-tools [data-cmd], .m-action-strip [data-cmd]').forEach((b) => {
  b.addEventListener('click', () => {
    const cmd = (b as HTMLElement).dataset.cmd!;
    closeAllSheets();
    runCmd(cmd);
  });
});

// 空状态与悬浮按钮的新建入口（移动端主要靠它）
document.getElementById('empty-new')?.addEventListener('click', () => runCmd('new-project'));
document.getElementById('empty-demo')?.addEventListener('click', () => runCmd('demo'));
document.getElementById('m-fab')?.addEventListener('click', () => runCmd('new-project'));

// 移动端侧栏的四个快捷操作
document.getElementById('m-new-project')?.addEventListener('click', () => { closeAllSheets(); runCmd('new-project'); });
document.getElementById('m-demo')?.addEventListener('click', () => { closeAllSheets(); runCmd('demo'); });
document.getElementById('m-import')?.addEventListener('click', () => { closeAllSheets(); runCmd('import'); });
document.getElementById('m-export')?.addEventListener('click', () => { closeAllSheets(); runCmd('export'); });

// 移动端底部标签与桌面工具条共用 switchTab
document.querySelectorAll('#m-nav .m-tab[data-tab]').forEach((b) => {
  b.addEventListener('click', () => switchTab(((b as HTMLElement).dataset.tab as typeof activeTab) ?? 'entry'));
});

// 点画布收起抽屉，避免遮挡绘图
for (const el of [entryPlot.canvas, contourPlot.canvas]) {
  el.addEventListener('pointerdown', () => {
    if (anySheetOpen()) closeAllSheets();
  });
}

// 右侧分区折叠
document.querySelectorAll('#right-dock .dock-head').forEach((h) => {
  h.addEventListener('click', () => {
    (h.parentElement as HTMLElement).classList.toggle('collapsed');
  });
});

function applyToolbarMode(mode: ToolbarMode): void {
  prefs.toolbarMode = mode;
  savePrefs();
  const tb = document.getElementById('toolbar')!;
  tb.classList.remove('mode-icon', 'mode-text', 'mode-both');
  tb.classList.add(`mode-${mode}`);
}

function runCmd(cmd: string): void {
  try {
    runCmdInner(cmd);
  } catch (err) {
    // 静默失败最难排查：任何命令异常都显式告知用户
    alert('操作失败：' + (err as Error).message);
    console.error(err);
  }
}

function runCmdInner(cmd: string): void {
  const item = current();
  switch (cmd) {
    case 'new-project': void createProject(); break;
    case 'demo': createDemo(); break;
    case 'import': (document.getElementById('import-file') as HTMLInputElement).click(); break;
    case 'import-points': (document.getElementById('points-file') as HTMLInputElement).click(); break;
    case 'export': exportJsonText(JSON.stringify(sortStore(), null, 2)); break;
    case 'export-img': exportImage(); break;
    case 'export-pdf': void exportPdf(); break;
    case 'copy-img': void copyImage(); break;
    case 'delete-project':
      if (!item) { alert('没有打开的项目'); return; }
      if (!confirm(`确定删除项目「${item.project.name}」？`)) return;
      store = store.filter((x) => x.project.id !== item.project.id);
      currentId = null;
      persist();
      renderAll();
      break;
    case 'clear-measurements':
      if (!item) return;
      if (!confirm('清空当前项目的全部测点数据？此操作不可撤销。')) return;
      item.measurements = [];
      touch(item.project);
      persist();
      splFieldCache = null;
      renderAll();
      break;
    case 'clear-noise-flags':
      if (!item) return;
      for (const m of item.measurements) m.isNoiseSource = false;
      touch(item.project);
      persist();
      renderAll();
      break;
    case 'tab-entry': switchTab('entry'); break;
    case 'tab-contour': switchTab('contour'); break;
    case 'tab-settings': switchTab('settings'); break;
    case 'zoom-fit': activePlot().fit(); break;
    case 'tb-icon': applyToolbarMode('icon'); break;
    case 'tb-text': applyToolbarMode('text'); break;
    case 'tb-both': applyToolbarMode('both'); break;
    case 'toggle-calib':
      prefs.showCalib = !prefs.showCalib;
      savePrefs();
      (document.getElementById('chk-calib') as HTMLInputElement).checked = prefs.showCalib;
      contourPlot.paint();
      break;
    case 'toggle-points':
      prefs.showPoints = !prefs.showPoints;
      savePrefs();
      (document.getElementById('chk-points') as HTMLInputElement).checked = prefs.showPoints;
      contourPlot.paint();
      break;
    case 'toggle-dims':
      prefs.showDims = !prefs.showDims;
      savePrefs();
      (document.getElementById('chk-dims') as HTMLInputElement).checked = prefs.showDims;
      contourPlot.paint();
      entryPlot.paint();
      break;
    case 'toggle-scalebar':
      prefs.showScaleBar = !prefs.showScaleBar;
      savePrefs();
      (document.getElementById('chk-scalebar') as HTMLInputElement).checked = prefs.showScaleBar;
      contourPlot.paint();
      entryPlot.paint();
      break;
    case 'noise': void runNoiseDetect(); break;
    case 'recompute':
      splFieldCache = null;
      renderAll();
      break;
    case 'scope-paper':
      setFieldScope('paper');
      break;
    case 'scope-points':
      setFieldScope('points');
      break;
    case 'basemap':
      if (!item) { alert('请先打开项目'); return; }
      basemapFile.click();
      break;
    case 'calibrate': setCalibMode(!calibMode); break;
    case 'about':
      alert('NoiseAtlas 噪声图谱 v0.2.1\n\n厂区噪声网格普查 · 等声压级成图 · 噪声源定位\n'
        + '算法：能量叠加 + 距离衰减声场 / Marching Squares 等值线\n'
        + '数据格式与旧版 AC-Camera JSON 兼容');
      break;
    default: break;
  }
}

// 工具条按钮 → 命令
document.getElementById('btn-new-project')!.addEventListener('click', () => runCmd('new-project'));
document.getElementById('btn-demo')!.addEventListener('click', () => runCmd('demo'));
document.getElementById('btn-import')!.addEventListener('click', () => runCmd('import'));

// 导入 JSON（旧版网格数据会自动迁移为自由测点）
document.getElementById('import-file')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await readJsonFile(file));
    if (!Array.isArray(parsed)) throw new Error('文件格式不是项目数组');
    for (const raw of parsed) {
      if (!raw || !raw.project || !Array.isArray(raw.measurements)) continue;
      const [item] = migrateStore([raw]);
      const idx = store.findIndex((x) => x.project.id === item.project.id);
      if (idx >= 0) store[idx] = item; else store.push(item);
      currentId = item.project.id;
    }
    splFieldCache = null;
    persist();
    renderAll();
    alert('导入完成');
  } catch (err) {
    alert('导入失败：' + (err as Error).message);
  }
  input.value = '';
});
// ───────────────────────── 测点表导入（点位锚定底图） ─────────────────────────

/**
 * 支持三种输入，全部落到「底图归一化坐标」或「图纸米制坐标」：
 * 1) JSON：{ "type":"noiseatlas-points", "points":[{"label":"1","spl":72.4,"u":0.31,"v":0.42}, …] }
 *    （u,v = 底图图像上的归一化位置，左上为原点；也可用 x,y 表示图纸米制坐标）
 * 2) JSON 数组：[{"label":"1","spl":72.4,"u":0.31,"v":0.42}, …]
 * 3) CSV / TXT：每行 `编号,声压级,u,v`（首行可写表头：label,spl,u,v 或 label,spl,x,y）
 */
interface RawPointRow {
  label?: string;
  spl: number;
  u?: number;
  v?: number;
  x?: number;
  y?: number;
}

function pickNum(obj: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined || val === null || val === '') continue;
    const n = typeof val === 'number' ? val : parseFloat(String(val));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const val = obj[k];
    if (val === undefined || val === null || val === '') continue;
    return String(val).trim();
  }
  return undefined;
}

function parsePointRows(text: string): RawPointRow[] {
  const src = text.replace(/^\uFEFF/, '').trim();
  if (!src) return [];

  const fromObject = (o: Record<string, unknown>): RawPointRow | null => {
    const spl = pickNum(o, ['spl', 'splDb', 'value', 'db', 'dB', 'noise', '声压级', '噪声值']);
    if (spl === undefined) return null;
    const label = pickStr(o, ['label', 'name', 'id', 'point', '编号', '测点', '点名']);
    const u = pickNum(o, ['u', 'bu', 'nx', 'px']);
    const v = pickNum(o, ['v', 'bv', 'ny', 'py']);
    const x = pickNum(o, ['x', 'mx']);
    const y = pickNum(o, ['y', 'my']);
    const row: RawPointRow = { spl, label };
    if (u !== undefined && v !== undefined) { row.u = u; row.v = v; }
    else if (x !== undefined && y !== undefined) { row.x = x; row.y = y; }
    else return null;
    return row;
  };

  if (src.startsWith('{') || src.startsWith('[')) {
    const parsed = JSON.parse(src) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray((parsed as { points?: unknown[] }).points)
        ? (parsed as { points: unknown[] }).points
        : []);
    const out: RawPointRow[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const row = fromObject(it as Record<string, unknown>);
      if (row) out.push(row);
    }
    return out;
  }

  // CSV / TXT
  const lines = src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const splitLine = (l: string): string[] => l.split(/[,;\t]+|\s{2,}/).map((s) => s.trim()).filter((s) => s !== '');

  let cols: string[] | null = null;
  let start = 0;
  const head = splitLine(lines[0]).map((s) => s.toLowerCase());
  if (head.some((h) => ['label', 'spl', 'u', 'v', 'x', 'y', '编号', '声压级'].includes(h))) {
    cols = head;
    start = 1;
  }

  const idx = (names: string[]): number => (cols ? cols.findIndex((c) => names.includes(c)) : -1);
  const iLabel = cols ? idx(['label', 'name', 'id', 'point', '编号', '测点', '点名']) : 0;
  const iSpl = cols ? idx(['spl', 'db', 'value', '声压级', '噪声值']) : 1;
  const iU = cols ? idx(['u', 'bu', 'nx']) : 2;
  const iV = cols ? idx(['v', 'bv', 'ny']) : 3;
  const iX = cols ? idx(['x', 'mx']) : -1;
  const iY = cols ? idx(['y', 'my']) : -1;

  const out: RawPointRow[] = [];
  for (let i = start; i < lines.length; i++) {
    const parts = splitLine(lines[i]);
    if (parts.length < 3) continue;
    const spl = parseFloat(parts[iSpl] ?? '');
    if (!Number.isFinite(spl)) continue;
    const row: RawPointRow = { spl, label: iLabel >= 0 ? parts[iLabel] : undefined };
    if (iX >= 0 && iY >= 0) {
      const x = parseFloat(parts[iX] ?? '');
      const y = parseFloat(parts[iY] ?? '');
      if (Number.isFinite(x) && Number.isFinite(y)) { row.x = x; row.y = y; }
    } else {
      const u = parseFloat(parts[iU] ?? '');
      const v = parseFloat(parts[iV] ?? '');
      if (Number.isFinite(u) && Number.isFinite(v)) { row.u = u; row.v = v; }
    }
    if (row.u === undefined && row.x === undefined) continue;
    out.push(row);
  }
  return out;
}

async function importPointRows(file: File): Promise<void> {
  await importPointRowsFromText(await readJsonFile(file));
}

/**
 * 从文本导入测点（文件选择器与调试入口共用）。
 * 返回导入统计，便于脚本化校验。
 */
async function importPointRowsFromText(
  text: string,
  opts: { silent?: boolean; replace?: boolean } = {},
): Promise<{ total: number; anchored: number; skipped: number } | null> {
  const item = current();
  if (!item) { if (!opts.silent) alert('请先打开或新建项目'); return null; }
  const rows = parsePointRows(text);
  if (rows.length === 0) {
    if (!opts.silent) alert('没有解析到测点。\n\n支持格式：\n• JSON: {"points":[{"label":"1","spl":72.4,"u":0.31,"v":0.42}]}\n• CSV: 编号,声压级,u,v');
    return null;
  }

  const anchored = rows.filter((r) => r.u !== undefined && r.v !== undefined).length;
  const metric = rows.length - anchored;
  const hasBase = !!(item.project.backgroundImageData || item.project.backgroundDxfText);
  if (anchored > 0 && !hasBase && !opts.silent) {
    const ok = confirm(
      `这份点位表有 ${anchored} 个点按「底图归一化坐标」定位，但当前还没有导入底图。\n\n`
      + '继续导入：点位会先按图纸比例摆放，等你导入底图后自动重新对位。\n\n是否继续？',
    );
    if (!ok) return null;
  }

  if (item.measurements.length > 0) {
    const replace = opts.replace ?? confirm(
      `当前项目已有 ${item.measurements.length} 个测点。\n\n`
      + '确定 = 清空后替换\n取消 = 追加到现有测点后面',
    );
    if (replace) item.measurements = [];
  }

  const aspect = basemapAspect();
  const pid = item.project.id;
  let skipped = 0;
  for (const r of rows) {
    let x: number;
    let y: number;
    let bu: number | undefined;
    let bv: number | undefined;
    if (r.u !== undefined && r.v !== undefined) {
      bu = r.u;
      bv = r.v;
      const q = anchorToMeters(item.project, aspect > 0 ? aspect : worldSize(item.project).w / worldSize(item.project).h, bu, bv);
      x = q.x;
      y = q.y;
    } else {
      x = r.x!;
      y = r.y!;
    }
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r.spl)) { skipped++; continue; }
    item.measurements.push({
      projectId: pid,
      id: newPointId(),
      x, y,
      spl: r.spl,
      note: '',
      label: r.label,
      ...(bu !== undefined && bv !== undefined ? { bu, bv } : {}),
    });
  }

  touch(item.project);
  persist();
  splFieldCache = null;
  renderAll();
  switchTab('contour');
  if (!opts.silent) {
    alert(
      `已导入 ${rows.length} 个测点`
      + (anchored > 0 ? `\n其中 ${anchored} 个锚定在底图上（定标/对齐后会自动跟随）` : '')
      + (metric > 0 ? `\n${metric} 个按图纸米制坐标放置` : '')
      + (skipped > 0 ? `\n跳过 ${skipped} 行（数值无效）` : ''),
    );
  }
  return { total: rows.length, anchored, skipped };
}

// 调试/脚本入口：便于自动化校验点位表解析（控制台或自动化工具调用）
(window as unknown as Record<string, unknown>).__naImportPointsText = importPointRowsFromText;
(window as unknown as Record<string, unknown>).__naParsePoints = parsePointRows;

// 几何调试入口：核对「内容范围 / 视口 / 平移夹紧」等行为（现场问题定位用）
(window as unknown as Record<string, unknown>).__naDebug = {
  view: () => ({
    zoom: contourPlot.transform.zoom,
    panX: contourPlot.transform.panX,
    panY: contourPlot.transform.panY,
    content: contourPlot.contentRect,
    world: contourPlot.worldRect(),
    viewport: contourPlot.viewport(),
    overflow: contourPlot.contentOverflow(),
  }),
  fit: () => { contourPlot.fit(); entryPlot.fit(); },
  setBaseMapScale: (s: number) => {
    const it = current();
    if (!it) return null;
    it.project.baseMapScale = s;
    updateContentRect(it);
    renderAll();
    return contourPlot.contentRect;
  },
  /** 生成一张测试底图（带网格与十字），用于无外部文件时验证溢出/平移 */
  attachTestBasemap: (w = 1000, h = 1400) => {
    const it = current();
    if (!it) return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d')!;
    c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#b9c6d4'; c.lineWidth = 2;
    for (let x = 0; x <= w; x += 100) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); }
    for (let y = 0; y <= h; y += 100) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    c.strokeStyle = '#c0392b'; c.lineWidth = 4;
    c.strokeRect(4, 4, w - 8, h - 8);
    it.project.backgroundImageData = cv.toDataURL('image/jpeg', 0.8);
    it.project.backgroundDxfText = null;
    bmCacheKey = '';
    refreshBasemapCache(it.project);
    renderAll();
    return true;
  },
};

document.getElementById('points-file')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    await importPointRows(file);
  } catch (err) {
    alert('测点表导入失败：' + (err as Error).message);
  }
  input.value = '';
});

document.getElementById('btn-export')!.addEventListener('click', () => runCmd('export'));
document.getElementById('btn-basemap')!.addEventListener('click', () => runCmd('basemap'));
document.getElementById('btn-calibrate')!.addEventListener('click', () => runCmd('calibrate'));
document.getElementById('btn-noise')!.addEventListener('click', () => runCmd('noise'));
document.getElementById('btn-export-img')!.addEventListener('click', () => runCmd('export-img'));
document.getElementById('btn-export-pdf')!.addEventListener('click', () => runCmd('export-pdf'));
document.getElementById('btn-copy-img')!.addEventListener('click', () => runCmd('copy-img'));

// ───────────────────────── 项目创建 ─────────────────────────

async function createProject(): Promise<void> {
  const values = await showForm('新建项目', [
    { key: 'name', label: '项目名称', value: '新项目' },
    { key: 'w', label: '图纸宽度 (m)：可先填大概，导入底图后定标会修正', value: 40, type: 'number', min: 1, step: 0.5 },
    { key: 'h', label: '图纸高度 (m)', value: 30, type: 'number', min: 1, step: 0.5 },
    { key: 'bg', label: '背景噪声 / 底噪 (dBA)，没有可填 0', value: 0, type: 'number', min: 0, step: 0.5 },
  ], '创建');
  if (!values) return;
  const name = (values.name ?? '').trim();
  if (!name) return;
  const p = newProject(
    name, '',
    Math.max(1, parseFloat(values.w) || 40),
    Math.max(1, parseFloat(values.h) || 30),
  );
  p.backgroundNoiseDb = Math.max(0, parseFloat(values.bg) || 0);
  store.push({ project: p, measurements: [] });
  currentId = p.id;
  persist();
  renderAll();
  closeAllSheets();
}

function createDemo(): void {
  // 演示：不规则测点（模拟现场沿设备与通道布点），两台冲床 + 一台空压机
  const W = 40, H = 30;
  const p = newProject('示例 · 机加工车间', '演示数据：2 台冲床 + 1 台空压机（不规则布点）', W, H);
  p.backgroundNoiseDb = 55;
  const sources: Array<[number, number, number]> = [[12, 12, 92], [30, 7, 88], [24, 24, 85]];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const measurements: Measurement[] = [];
  // 沿 6 条不等的测线布点，模拟真实现场走位
  const lines: Array<{ y: number; x0: number; x1: number; n: number }> = [
    { y: 4, x0: 3, x1: 37, n: 7 },
    { y: 9, x0: 5, x1: 35, n: 6 },
    { y: 14, x0: 2, x1: 38, n: 8 },
    { y: 19, x0: 6, x1: 33, n: 5 },
    { y: 24, x0: 4, x1: 36, n: 6 },
    { y: 27, x0: 10, x1: 30, n: 4 },
  ];
  for (const ln of lines) {
    for (let i = 0; i < ln.n; i++) {
      const x = ln.x0 + ((ln.x1 - ln.x0) * i) / Math.max(1, ln.n - 1) + (rnd() - 0.5) * 1.2;
      const y = ln.y + (rnd() - 0.5) * 1.4;
      let spl = 55 + rnd() * 3;
      for (const [sx, sy, base] of sources) {
        const d = Math.hypot(x - sx, y - sy);
        spl = Math.max(spl, base - 6 * (d / 5) + rnd() * 2);
      }
      measurements.push({
        projectId: p.id, id: newPointId(),
        x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10,
        spl: Math.round(spl * 10) / 10, note: '',
      });
    }
  }
  // 标记两个最响的点为疑似噪声源
  [...measurements].sort((a, b) => b.spl - a.spl).slice(0, 2)
    .forEach((m) => { const t = measurements.find((x) => x.id === m.id); if (t) t.isNoiseSource = true; });
  store.push({ project: p, measurements });
  currentId = p.id;
  persist();
  renderAll();
}

// ───────────────────────── 渲染 ─────────────────────────

function renderWorkspace(): void {
  const item = current();
  emptyEl.hidden = !!item;
  wsEl.hidden = !item;
  if (!item) {
    renderTree(null);
    updateStatus();
    return;
  }
  const { project } = item;

  entryPlot.cols = project.cols;
  entryPlot.rows = project.rows;
  contourPlot.cols = project.cols;
  contourPlot.rows = project.rows;
  // 纸张按真实宽高比 => 底图与点位跨设备/跨窗口尺寸都不漂移
  {
    const ws0 = worldSize(project);
    const asp = ws0.w / ws0.h;
    entryPlot.worldAspect = asp;
    contourPlot.worldAspect = asp;
  }

  alphaSlider.value = String(Math.round(project.overlayAlpha * 100));
  alphaLabel.textContent = `${Math.round(project.overlayAlpha * 100)}%`;

  const mName = document.getElementById('m-project-name');
  const mSub = document.getElementById('m-subtitle');
  if (mName) mName.textContent = project.name;
  if (mSub) {
    const ws = worldSize(project);
    mSub.textContent = `${ws.w.toFixed(0)}×${ws.h.toFixed(0)} m · 测点 ${item.measurements.length} 个`;
  }

  refreshBasemapCache(project);
  applyAnchors(item);
  updateContentRect(item);
  hintBasemap(project);
  fillSettings(project);
  renderBandChoices();
  renderLegend(item);
  renderStats(item);
  renderTree(item);
  updateStatus();
  entryPlot.paint();
  contourPlot.paint();
}

function renderAll(): void {
  rememberCurrent();
  renderSidebar();
  renderWorkspace();
  document.querySelectorAll('.viewtab').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.tab === activeTab);
  });
}

applyToolbarMode(prefs.toolbarMode);
renderAll();

window.addEventListener('resize', () => {
  entryPlot.resize();
  contourPlot.resize();
});

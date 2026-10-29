"""把 main.ts / index.html 从「网格测点」改为「任意测点 + 底图定标」工作流。"""
from pathlib import Path

root = Path(__file__).parent
p = root / 'src' / 'main.ts'
s = p.read_text(encoding='utf-8')


def rep(old, new, count=1, label=''):
    global s
    assert old in s, f'NOT FOUND: {label or old[:60]}'
    s = s.replace(old, new, count)


# ── 1) 导入 ──
rep("import { newProject, pointCount } from './core/types';",
    "import { newProject, newPointId, worldSize } from './core/types';", label='import types')
rep("import { bandColors, colormap, computeSplField, quantizeStep, renderFieldImageData } from './core/field';",
    "import { bandColors, colormap, computeSplFieldPoints, fieldDomain, quantizeStep, renderFieldImageData } from './core/field';\nimport type { SplPoint } from './core/field';", label='import field')

# ── 2) 标尺 / 尺寸 / 比例尺 / 标题块 改用 worldSize ──
rep("""function drawRulers(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const wm = p.cols * p.spacingX;
  const hm = p.rows * p.spacingY;""",
    """function drawRulers(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const { w: wm, h: hm } = worldSize(p);""", label='drawRulers')

rep("""function drawDimensions(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const wm = p.cols * p.spacingX;
  const hm = p.rows * p.spacingY;""",
    """function drawDimensions(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {
  const { w: wm, h: hm } = worldSize(p);""", label='drawDimensions head')

rep("""  const wLabel = `${wm.toFixed(1)} m  (${p.cols} × ${p.spacingX} m)`;""",
    """  const wLabel = `${wm.toFixed(1)} m`;""", label='dim label w')
rep("""  const hLabel = `${hm.toFixed(1)} m  (${p.rows} × ${p.spacingY} m)`;""",
    """  const hLabel = `${hm.toFixed(1)} m`;""", label='dim label h')

# 比例尺：直接按图纸米宽换算，去掉 zoom 参数
rep("""function drawScaleBar(ctx: CanvasRenderingContext2D, world: Rect, planRef: number | null | undefined, zoom: number): void {
  if (!planRef || planRef <= 0) return;
  const pxPerMeter = world.width / planRef / zoom;""",
    """function drawScaleBar(ctx: CanvasRenderingContext2D, world: Rect, worldMeters: number): void {
  if (!(worldMeters > 0)) return;
  const pxPerMeter = world.width / worldMeters;""", label='scalebar head')

rep("""  if (prefs.showScaleBar) drawScaleBar(ctx, world, project.planReferenceMeters, entryPlot.transform.zoom);""",
    """  if (prefs.showScaleBar) drawScaleBar(ctx, world, worldSize(project).w);""", label='scalebar call entry')
rep("""  if (prefs.showScaleBar) drawScaleBar(ctx, world, project.planReferenceMeters, contourPlot.transform.zoom);""",
    """  if (prefs.showScaleBar) drawScaleBar(ctx, world, worldSize(project).w);""", label='scalebar call contour')

# 标题块内容改为「测点数 + 图纸范围」
rep("""  ctx.font = '10px "Segoe UI", system-ui';
  ctx.fillStyle = '#5a6472';
  ctx.fillText(
    `${p.cols}×${p.rows} cell · ${(p.cols + 1) * (p.rows + 1)} 点 · 间距 ${p.spacingX}×${p.spacingY} m`,
    x + 8, y + 28,
  );
  ctx.fillText(`NoiseAtlas · 底噪 ${p.backgroundNoiseDb} dBA`, x + 8, y + 40);""",
    """  ctx.font = '10px "Segoe UI", system-ui';
  ctx.fillStyle = '#5a6472';
  const ws = worldSize(p);
  ctx.fillText(`图纸 ${ws.w.toFixed(1)} × ${ws.h.toFixed(1)} m · 底噪 ${p.backgroundNoiseDb} dBA`, x + 8, y + 28);
  ctx.fillText(stamp, x + 8, y + 40);""", label='titleblock text')

rep("""function drawTitleBlock(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {""",
    """function drawTitleBlock(ctx: CanvasRenderingContext2D, world: Rect, p: Project, stamp = 'NoiseAtlas'): void {""",
    label='titleblock sig')

# ── 3) 测点工具函数（替换 splMap） ──
rep("""function splMap(item: ProjectWithMeasurements): Map<string, number> {
  const m = new Map<string, number>();
  for (const meas of item.measurements) m.set(`${meas.col},${meas.row}`, meas.spl);
  return m;
}""",
    """/** 测点 → 声场计算用点集 */
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
}""", label='splMap -> helpers')

# ── 4) 录入页：绘制任意测点 ──
old_entry_paint = """  const ctx = entryPlot.ctx2d;
  const { project } = item;
  const { cols, rows } = project;
  const cw = world.width / cols;
  const ch = world.height / rows;

  drawPaper(ctx, world);
  drawBasemap(ctx, world, project);

  ctx.strokeStyle = 'rgba(70,84,100,0.30)';
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  for (let c = 1; c < cols; c++) {
    ctx.moveTo(world.left + c * cw, world.top);
    ctx.lineTo(world.left + c * cw, world.top + world.height);
  }
  for (let r = 1; r < rows; r++) {
    ctx.moveTo(world.left, world.top + r * ch);
    ctx.lineTo(world.left + world.width, world.top + r * ch);
  }
  ctx.stroke();

  const spl = splMap(item);
  const values = [...spl.values()];
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values, min + 1e-6) : 1;
  const dense = Math.min(cw, ch) < 26;
  for (let c = 0; c <= cols; c++) {
    for (let r = 0; r <= rows; r++) {
      const px = world.left + c * cw;
      const py = world.top + r * ch;
      const v = spl.get(`${c},${r}`);
      if (v !== undefined) {
        const t = (v - min) / (max - min || 1);
        const rad = Math.max(4, Math.min(10, Math.min(cw, ch) * 0.26));
        ctx.beginPath();
        ctx.arc(px, py, rad, 0, Math.PI * 2);
        ctx.fillStyle = splColor(t);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        if (!dense && entryPlot.transform.zoom >= 1.6) {
          ctx.fillStyle = '#111';
          ctx.font = '10px "Segoe UI", system-ui';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(v.toFixed(0), px, py - rad - 2);
        }
      } else {
        ctx.strokeStyle = 'rgba(90,104,122,0.55)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px - 3.5, py); ctx.lineTo(px + 3.5, py);
        ctx.moveTo(px, py - 3.5); ctx.lineTo(px, py + 3.5);
        ctx.stroke();
      }
    }
  }

  drawRulers(ctx, world, project);"""

new_entry_paint = """  const ctx = entryPlot.ctx2d;
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
    if (item.measurements.length <= 40 || entryPlot.transform.zoom >= 1.8) {
      ctx.fillStyle = '#101418';
      ctx.font = 'bold 10px "Segoe UI", system-ui';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(m.spl.toFixed(0), px, py - rad - 2);
    }
  }

  if (item.measurements.length === 0) {
    ctx.fillStyle = 'rgba(60,72,86,0.55)';
    ctx.font = '12px "Segoe UI", system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('在底图上任意位置单击，录入该点的声压级', world.left + world.width / 2, world.top + world.height / 2);
  }

  drawRulers(ctx, world, project);"""
rep(old_entry_paint, new_entry_paint, label='entry painter')

# 参考网格工具函数（插到 drawRulers 之前）
rep("""function drawRulers(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {""",
    """/** 米制参考网格（无测点约束，纯坐标系参考） */
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

function drawRulers(ctx: CanvasRenderingContext2D, world: Rect, p: Project): void {""",
    label='refgrid helper')

# ── 5) 录入页点击：任意点 ──
rep("""entryPlot.onHover = (u, v) => reportCoords(u, v);
entryPlot.onTap = (col, row) => {
  const item = current();
  if (!item) return;
  openPointDialog(item, col, row);
};""",
    """entryPlot.onHover = (u, v) => reportCoords(u, v);
// 任意位置拾取：命中已有测点则编辑，否则在点击处新增
entryPlot.rawTapMode = true;
entryPlot.onRawTap = (u, v) => {
  const item = current();
  if (!item) return;
  const { project } = item;
  const pos = pxToMeters(entryPlot.worldRect(), project, u, v);
  const ws = worldSize(project);
  const hitR = Math.hypot(ws.w, ws.h) * 0.022;   // 命中半径（米）
  const hit = item.measurements.find((m) => Math.hypot(m.x - pos.x, m.y - pos.y) <= hitR);
  openPointDialog(item, hit ? hit.x : pos.x, hit ? hit.y : pos.y, hit);
};""", label='entry tap')

# ── 6) 测点弹窗：坐标化 ──
rep("""const dlg = document.getElementById('point-dialog') as HTMLDialogElement;
let dialogTarget: { col: number; row: number } | null = null;

function openPointDialog(item: ProjectWithMeasurements, col: number, row: number): void {
  dialogTarget = { col, row };
  const existing = item.measurements.find((m) => m.col === col && m.row === row);
  const { project } = item;
  (document.getElementById('pd-title') as HTMLElement).textContent =
    `测点 (列 ${col}, 行 ${row}) · x=${(col * project.spacingX).toFixed(1)} m  y=${(row * project.spacingY).toFixed(1)} m`;
  (document.getElementById('pd-spl') as HTMLInputElement).value = existing ? String(existing.spl) : '';
  (document.getElementById('pd-note') as HTMLInputElement).value = existing?.note ?? '';
  (document.getElementById('pd-clear') as HTMLElement).style.display = existing ? '' : 'none';
  dlg.showModal();
}""",
    """const dlg = document.getElementById('point-dialog') as HTMLDialogElement;
let dialogTarget: { x: number; y: number; id?: string } | null = null;

function openPointDialog(item: ProjectWithMeasurements, x: number, y: number, existing?: Measurement): void {
  dialogTarget = { x, y, id: existing?.id };
  const { project } = item;
  const ws = worldSize(project);
  (document.getElementById('pd-title') as HTMLElement).textContent =
    `${existing ? '编辑测点' : '新增测点'} · x=${x.toFixed(2)} m  y=${y.toFixed(2)} m`
    + `　（图纸 ${ws.w.toFixed(1)}×${ws.h.toFixed(1)} m）`;
  (document.getElementById('pd-spl') as HTMLInputElement).value = existing ? String(existing.spl) : '';
  (document.getElementById('pd-note') as HTMLInputElement).value = existing?.note ?? '';
  (document.getElementById('pd-clear') as HTMLElement).style.display = existing ? '' : 'none';
  dlg.showModal();
  const splInput = document.getElementById('pd-spl') as HTMLInputElement;
  splInput.focus();
  splInput.select();
}""", label='openPointDialog')

rep("""  const note = (document.getElementById('pd-note') as HTMLInputElement).value;
  const { col, row } = dialogTarget;
  const idx = item.measurements.findIndex((m) => m.col === col && m.row === row);
  const meas: Measurement = { projectId: item.project.id, col, row, spl: v, note };
  if (idx >= 0) item.measurements[idx] = meas; else item.measurements.push(meas);""",
    """  const note = (document.getElementById('pd-note') as HTMLInputElement).value;
  const target = dialogTarget;
  const idx = target.id
    ? item.measurements.findIndex((m) => m.id === target.id)
    : item.measurements.findIndex((m) => Math.hypot(m.x - target.x, m.y - target.y) < 1e-6);
  const meas: Measurement = {
    projectId: item.project.id,
    id: idx >= 0 ? item.measurements[idx].id : newPointId(),
    x: target.x,
    y: target.y,
    spl: v,
    note,
  };
  if (idx >= 0) item.measurements[idx] = meas; else item.measurements.push(meas);""", label='save point')

rep("""document.getElementById('pd-clear')!.addEventListener('click', () => {
  const item = current();
  if (!item || !dialogTarget) return;
  const { col, row } = dialogTarget;
  item.measurements = item.measurements.filter((m) => !(m.col === col && m.row === row));""",
    """document.getElementById('pd-clear')!.addEventListener('click', () => {
  const item = current();
  if (!item || !dialogTarget) return;
  const target = dialogTarget;
  item.measurements = item.measurements.filter((m) =>
    target.id ? m.id !== target.id : Math.hypot(m.x - target.x, m.y - target.y) > 1e-6);""", label='delete point')

# ── 7) 等值线页 ──
rep("""function getCachedField(item: ProjectWithMeasurements): FieldResult | null {
  const spl = splMap(item);
  if (spl.size === 0) return null;
  const key = [...spl.entries()].sort().toString() + `|${item.project.cols}|${item.project.rows}|${item.project.spacingX}|${item.project.spacingY}|${item.project.backgroundNoiseDb}`;
  if (splFieldCache?.key === key) return splFieldCache.field;
  const field = computeSplField(item.project, spl);
  if (!field) return null;
  splFieldCache = { key, field };
  return field;
}""",
    """function getCachedField(item: ProjectWithMeasurements): FieldResult | null {
  const pts = splPoints(item);
  if (pts.length === 0) return null;
  const ws = worldSize(item.project);
  const domain = fieldDomain(pts, ws);
  if (!domain) return null;
  const key = pts.map((p) => `${p.x.toFixed(3)},${p.y.toFixed(3)},${p.spl}`).sort().join(';')
    + `|${ws.w}|${ws.h}|${item.project.backgroundNoiseDb}`;
  if (splFieldCache?.key === key) return splFieldCache.field;
  const field = computeSplFieldPoints(pts, domain, item.project.backgroundNoiseDb);
  if (!field) return null;
  splFieldCache = { key, field };
  return field;
}""", label='getCachedField')

rep("""  const ctx = contourPlot.ctx2d;
  const field = getCachedField(item);
  const { project } = item;
  const { cols, rows } = project;
  const cw = world.width / cols;
  const ch = world.height / rows;

  drawPaper(ctx, world);
  drawBasemap(ctx, world, project);

  if (field) {
    const off = document.createElement('canvas');
    off.width = field.resX;
    off.height = field.resY;
    off.getContext('2d')!.putImageData(
      renderFieldImageData(field, project.contourColorBands, parseFloat(alphaSlider.value) / 100), 0, 0,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, world.left, world.top, world.width, world.height);
    ctx.imageSmoothingEnabled = true;

    if (prefs.showContours) {
      const levels = defaultLevels(field.min, field.max);
      ctx.strokeStyle = 'rgba(25,28,34,0.55)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (const level of levels) {
        for (const s of contours(field, level)) {
          ctx.moveTo(world.left + s.x1 / field.resX * world.width, world.top + s.y1 / field.resY * world.height);
          ctx.lineTo(world.left + s.x2 / field.resX * world.width, world.top + s.y2 / field.resY * world.height);
        }
      }
      ctx.stroke();
    }
  }

  if (prefs.showGridlines) {
    ctx.strokeStyle = 'rgba(255,255,255,0.32)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    for (let c = 0; c <= cols; c++) {
      ctx.moveTo(world.left + c * cw, world.top);
      ctx.lineTo(world.left + c * cw, world.top + world.height);
    }
    for (let r = 0; r <= rows; r++) {
      ctx.moveTo(world.left, world.top + r * ch);
      ctx.lineTo(world.left + world.width, world.top + r * ch);
    }
    ctx.stroke();
  }

  if (prefs.showPoints) {
    const spl = splMap(item);
    const range = field ? field.max - field.min : 1;
    for (let c = 0; c <= cols; c++) {
      for (let r = 0; r <= rows; r++) {
        const px = world.left + c * cw;
        const py = world.top + r * ch;
        const m = item.measurements.find((mm) => mm.col === c && mm.row === r);
        const v = m?.spl;
        if (v !== undefined && field) {
          const [cr, cg, cb] = colormap((v - field.min) / (range || 1));
          ctx.beginPath();
          ctx.arc(px, py, 6.5, 0, Math.PI * 2);
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.8)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          if (m?.isNoiseSource) {
            ctx.beginPath();
            ctx.arc(px, py, 12, 0, Math.PI * 2);
            ctx.strokeStyle = '#c0392b';
            ctx.lineWidth = 2.2;
            ctx.stroke();
          }
        } else if (!field) {
          ctx.strokeStyle = 'rgba(70,84,100,0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px - 3.5, py); ctx.lineTo(px + 3.5, py);
          ctx.moveTo(px, py - 3.5); ctx.lineTo(px, py + 3.5);
          ctx.stroke();
        }
      }
    }
  }

  if (prefs.showCalib) drawCalibration(ctx, world, project);
  drawRulers(ctx, world, project);
  if (prefs.showDims) drawDimensions(ctx, world, project);
  drawSplScale(ctx, world, field, project.contourColorBands);
  drawTitleBlock(ctx, world, project);""",
    """  const ctx = contourPlot.ctx2d;
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
      renderFieldImageData(field, project.contourColorBands, parseFloat(alphaSlider.value) / 100), 0, 0,
    );
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, dx, dy, dw, dh);
    ctx.imageSmoothingEnabled = true;

    if (prefs.showContours) {
      const levels = defaultLevels(field.min, field.max);
      ctx.strokeStyle = 'rgba(25,28,34,0.6)';
      ctx.lineWidth = 1;
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
  }

  if (prefs.showCalib) drawCalibration(ctx, world, project);
  drawRulers(ctx, world, project);
  if (prefs.showDims) drawDimensions(ctx, world, project);
  drawSplScale(ctx, world, field, project.contourColorBands);
  drawTitleBlock(ctx, world, project, `${item.measurements.length} 个测点`);""", label='contour painter')

# ── 8) 定标：世界尺寸改 worldSize ──
rep("""  const [a, b] = calibPts;
  const W = p.cols * p.spacingX;
  const H = p.rows * p.spacingY;""",
    """  const [a, b] = calibPts;
  const { w: W, h: H } = worldSize(p);""", label='calib W/H')

# ── 9) 噪声源识别：kNN ──
rep("""  const sources = detectNoiseSources(item.project, item.measurements, thr, item.project.backgroundNoiseDb);
  const keys = new Set(sources.map((s) => `${s.col},${s.row}`));
  for (const m of item.measurements) m.isNoiseSource = keys.has(`${m.col},${m.row}`);""",
    """  const sources = detectNoiseSources(item.measurements, thr, item.project.backgroundNoiseDb);
  const keys = new Set(sources.map((s) => s.id));
  for (const m of item.measurements) m.isNoiseSource = keys.has(m.id);""", label='noise detect')

# ── 10) 设置面板字段 ──
rep("""function fillSettings(p: Project): void {
  field('name').value = p.name;
  field('description').value = p.description;
  field('cols').value = String(p.cols);
  field('rows').value = String(p.rows);
  field('spacingX').value = String(p.spacingX);
  field('spacingY').value = String(p.spacingY);
  field('planReferenceMeters').value = p.planReferenceMeters ? String(p.planReferenceMeters) : '';
  field('backgroundNoiseDb').value = String(p.backgroundNoiseDb);
}""",
    """function fillSettings(p: Project): void {
  const ws = worldSize(p);
  field('name').value = p.name;
  field('description').value = p.description;
  field('worldW').value = String(Number(ws.w.toFixed(2)));
  field('worldH').value = String(Number(ws.h.toFixed(2)));
  field('backgroundNoiseDb').value = String(p.backgroundNoiseDb);
}""", label='fillSettings')

rep("""  const p = item.project;
  p.name = field('name').value.trim() || p.name;
  p.description = field('description').value;
  p.cols = Math.max(2, parseInt(field('cols').value, 10) || p.cols);
  p.rows = Math.max(2, parseInt(field('rows').value, 10) || p.rows);
  p.spacingX = Math.max(0.1, parseFloat(field('spacingX').value) || p.spacingX);
  p.spacingY = Math.max(0.1, parseFloat(field('spacingY').value) || p.spacingY);
  p.planReferenceMeters = parseFloat(field('planReferenceMeters').value) || null;
  p.backgroundNoiseDb = Math.max(0, parseFloat(field('backgroundNoiseDb').value) || 0);""",
    """  const p = item.project;
  const ws0 = worldSize(p);
  p.name = field('name').value.trim() || p.name;
  p.description = field('description').value;
  p.worldW = Math.max(1, parseFloat(field('worldW').value) || ws0.w);
  p.worldH = Math.max(1, parseFloat(field('worldH').value) || ws0.h);
  p.backgroundNoiseDb = Math.max(0, parseFloat(field('backgroundNoiseDb').value) || 0);""", label='settings submit')

# ── 11) 状态栏 / 统计 / 坐标 ──
rep("""  stCoords.textContent = `X ${(u * p.cols * p.spacingX).toFixed(2)} m　Y ${(v * p.rows * p.spacingY).toFixed(2)} m`;""",
    """  const ws = worldSize(p);
  stCoords.textContent = `X ${(u * ws.w).toFixed(2)} m　Y ${(v * ws.h).toFixed(2)} m`;""", label='reportCoords')

rep("""  const p = item.project;
  stProgress.textContent = `已测 ${item.measurements.length} / ${pointCount(p)}`;
  stGrid.textContent = `网格 ${p.cols}×${p.rows} cell · ${p.spacingX}×${p.spacingY} m · 底噪 ${p.backgroundNoiseDb} dBA`;""",
    """  const p = item.project;
  const ws = worldSize(p);
  stProgress.textContent = `测点 ${item.measurements.length} 个`;
  stGrid.textContent = `图纸 ${ws.w.toFixed(1)}×${ws.h.toFixed(1)} m · 定标 ${p.baseMapCalibration ? '已定标' : '未定标'} · 底噪 ${p.backgroundNoiseDb} dBA`;""",
    label='updateStatus')

rep("""  const rows: Array<[string, string]> = [
    ['测点', `${item.measurements.length} / ${pointCount(item.project)}`],
    ['声压级', field ? `${field.min.toFixed(1)} – ${field.max.toFixed(1)} dB` : '—'],
    ['噪声源', sources ? `${sources} 处` : '未识别'],
    ['底图', item.project.backgroundDxfText ? 'CAD 矢量' : item.project.backgroundImageData ? '位图' : '无'],
    ['定标', item.project.baseMapCalibration ? `${item.project.baseMapCalibration.meters.toFixed(1)} m` : '未定标'],
  ];""",
    """  const ws = worldSize(item.project);
  const rows: Array<[string, string]> = [
    ['测点', `${item.measurements.length} 个`],
    ['声压级', field ? `${field.min.toFixed(1)} – ${field.max.toFixed(1)} dB` : '—'],
    ['噪声源', sources ? `${sources} 处` : '未识别'],
    ['覆盖范围', field ? `${field.domain.w.toFixed(1)} × ${field.domain.h.toFixed(1)} m` : '—'],
    ['图纸', `${ws.w.toFixed(1)} × ${ws.h.toFixed(1)} m`],
    ['定标', item.project.baseMapCalibration ? `${item.project.baseMapCalibration.meters.toFixed(1)} m` : '未定标'],
  ];""", label='renderStats')

# ── 12) 对象树 ──
rep("""  const nodes: TreeNode[] = [
    { level: 0, icon: '▣', name: p.name, badge: `${p.cols}×${p.rows}`, cmd: 'tab-settings' },
    {
      level: 1, icon: '▦', name: '测量网格', badge: `${(p.cols + 1) * (p.rows + 1)} 点`,
      cmd: 'tab-settings', active: activeTab === 'settings',
    },
    {
      level: 2, icon: '·', name: '测点数据', badge: `${item.measurements.length}`,
      cmd: 'tab-entry', active: activeTab === 'entry',
    },
    {
      level: 2, icon: '≈', name: '等声压级图',
      badge: field ? `${field.min.toFixed(0)}–${field.max.toFixed(0)} dB` : '—',
      cmd: 'tab-contour', active: activeTab === 'contour',
    },
    {
      level: 1, icon: '▤', name: '底图',
      badge: p.backgroundDxfText ? 'CAD' : p.backgroundImageData ? '位图' : '无',
      cmd: 'basemap',
    },
    {
      level: 2, icon: '⟷', name: '两点定标',
      badge: cal ? `${cal.meters.toFixed(1)} m` : '未定标',
      cmd: 'calibrate',
    },
    { level: 1, icon: '◎', name: '分析结果', badge: sources ? `${sources} 源` : '' },
    { level: 2, icon: '◉', name: '噪声源', badge: sources ? `${sources} 处` : '未识别', cmd: 'noise' },
  ];""",
    """  const ws = worldSize(p);
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
  ];""", label='renderTree')

# ── 13) 新建项目 / 示例数据 ──
rep("""async function createProject(): Promise<void> {
  const values = await showForm('新建项目', [
    { key: 'name', label: '项目名称', value: '新项目' },
    { key: 'cols', label: '列数（网格单元）', value: 10, type: 'number', min: 2, max: 80, step: 1 },
    { key: 'rows', label: '行数（网格单元）', value: 10, type: 'number', min: 2, max: 80, step: 1 },
    { key: 'sx', label: '列间距 (m)', value: 5, type: 'number', min: 0.1, step: 0.1 },
    { key: 'sy', label: '行间距 (m)', value: 5, type: 'number', min: 0.1, step: 0.1 },
  ], '创建');
  if (!values) return;
  const name = (values.name ?? '').trim();
  if (!name) return;
  const cols = parseInt(values.cols, 10) || 10;
  const rows = parseInt(values.rows, 10) || 10;
  const sx = parseFloat(values.sx) || 5;
  const sy = parseFloat(values.sy) || 5;
  const p = newProject(name, '', Math.max(2, cols), Math.max(2, rows), Math.max(0.1, sx), Math.max(0.1, sy));""",
    """async function createProject(): Promise<void> {
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
  p.backgroundNoiseDb = Math.max(0, parseFloat(values.bg) || 0);""", label='createProject')

rep("""function createDemo(): void {
  const p = newProject('示例 · 机加工车间', '演示数据：2 台冲床 + 1 台空压机', 8, 6, 5, 5);
  p.backgroundNoiseDb = 55;
  const measurements: Measurement[] = [];
  const sources: Array<[number, number, number]> = [[2, 2, 92], [6, 1, 88], [5, 5, 85]];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let c = 0; c <= p.cols; c++) {
    for (let r = 0; r <= p.rows; r++) {
      let spl = 55 + rnd() * 3;
      for (const [sc, sr, base] of sources) {
        const d = Math.hypot(c - sc, r - sr);
        spl = Math.max(spl, base - 6 * d + rnd() * 2);
      }
      measurements.push({ projectId: p.id, col: c, row: r, spl: Math.round(spl * 10) / 10, note: '' });
    }
  }
  measurements[2 * (p.rows + 1) + 2].isNoiseSource = true;
  measurements[6 * (p.rows + 1) + 1].isNoiseSource = true;
  store.push({ project: p, measurements });""",
    """function createDemo(): void {
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
  store.push({ project: p, measurements });""", label='createDemo')

# ── 14) 补回 JSON 导入处理（含旧数据迁移） ──
rep("""import { load, save, exportJsonText, readJsonFile, storageHint, pickDataDir, supportsFsApi } from './core/storage';""",
    """import { load, save, exportJsonText, readJsonFile, storageHint, pickDataDir, supportsFsApi, migrate as migrateStore } from './core/storage';""",
    label='import migrate')

rep("""document.getElementById('btn-import')!.addEventListener('click', () => runCmd('import'));""",
    """document.getElementById('btn-import')!.addEventListener('click', () => runCmd('import'));

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
});""", label='import handler')

# ── 15) 移动端副标题 ──
rep("""    mSub.textContent = `${project.cols}×${project.rows} cell · 已测 ${item.measurements.length}/${pointCount(project)}`;""",
    """    const ws = worldSize(project);
    mSub.textContent = `${ws.w.toFixed(0)}×${ws.h.toFixed(0)} m · 测点 ${item.measurements.length} 个`;""",
    label='mobile subtitle')

# ── 16) 项目列表卡片副标题 ──
rep("""    item.querySelector('.p-meta')!.textContent =
      `${project.cols}×${project.rows} cell · ${(project.cols + 1) * (project.rows + 1)} 点`;""",
    """    const ws0 = worldSize(project);
    item.querySelector('.p-meta')!.textContent = `${ws0.w.toFixed(0)}×${ws0.h.toFixed(0)} m`;""",
    label='project meta')

p.write_text(s, encoding='utf-8')
print('main.ts patched')

# ── HTML：设置表单换成图纸宽高 ──
h = root / 'index.html'
hs = h.read_text(encoding='utf-8')
old_form = """            <label>列数（网格单元） <input name="cols" type="number" min="2" max="80" required /></label>
            <label>行数（网格单元） <input name="rows" type="number" min="2" max="80" required /></label>
            <label>列间距 (m) <input name="spacingX" type="number" step="0.1" min="0.1" required /></label>
            <label>行间距 (m) <input name="spacingY" type="number" step="0.1" min="0.1" required /></label>
            <label>底图参照宽度 (m)
              <input name="planReferenceMeters" type="number" step="0.1" min="0" />
            </label>"""
new_form = """            <label>图纸宽度 (m) <input name="worldW" type="number" step="0.1" min="1" required /></label>
            <label>图纸高度 (m) <input name="worldH" type="number" step="0.1" min="1" required /></label>"""
assert old_form in hs, 'settings form not found'
hs = hs.replace(old_form, new_form)

# 视图/标签文案
hs = hs.replace('▦ 数据录入', '· 测点录入').replace('▩ 等声压级图', '≈ 等声压级图')
hs = hs.replace('网格设置', '图纸设置')
hs = hs.replace('数据录入：在网格交汇点录入声级计实测值', '测点录入：在底图任意位置点选，录入该点声级计实测值')
hs = hs.replace('等声压级图：声场热力图 + 等值线 + 噪声源标记', '等声压级图：声场彩图 + 等值曲线 + 噪声源标记')
hs = hs.replace('网格设置：项目名称、行列数、间距、底噪、参照宽度', '图纸设置：项目名称、图纸宽高、底噪')
hs = hs.replace('滚轮缩放 · 拖动平移 · 单击交汇点录入', '滚轮缩放 · 拖动平移 · 单击任意位置录入测点')
hs = hs.replace('网格尺寸', '参考网格')
h.write_text(hs, encoding='utf-8')
print('index.html patched')

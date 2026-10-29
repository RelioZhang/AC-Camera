/**
 * 通用网格画布：世界坐标 = 测量区域，x∈0..cols，y∈0..rows（cell 语义）。
 * 一个视图变换（缩放+平移）作用于网格与所有图层；手势处理器直接读当前变换对象
 * （可变状态 + 按需重绘），从根上避免 Compose 版遇到的「陈旧闭包拖动回弹」问题。
 */

export interface Transform {
  zoom: number;
  panX: number; // 画布像素
  panY: number;
}

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 20;

export class PlotCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  readonly transform: Transform = { zoom: 1, panX: 0, panY: 0 };
  /** 绘图边距：右侧留出空间绘制声压级色标（Odeon/Raynoise 式）。 */
  pad = 24;
  padRight = 24;

  private dragStart: { x: number; y: number; moved: boolean } | null = null;
  private onPaint: (world: Rect, t: Transform) => void = () => {};
  onTap: ((col: number, row: number) => void) | null = null;
  /** 校准模式下需要未吸附的真实点：设置后 pointerup 会回调归一化世界坐标（0..1）。 */
  onRawTap: ((u: number, v: number) => void) | null = null;
  /** 鼠标在世界坐标中的位置（归一化 0..1），供状态栏显示米制坐标。 */
  onHover: ((u: number, v: number) => void) | null = null;
  rawTapMode = false;
  /**
   * 拖点钩子：pointerdown 时调用，返回 true 表示“抓住了一个标记点”，
   * 此后的移动不再平移画布，而是交给 onPointDragMove 处理坐标更新。
   */
  onPointDragStart: ((px: number, py: number) => boolean) | null = null;
  onPointDragMove: ((px: number, py: number) => void) | null = null;
  onPointDragEnd: (() => void) | null = null;
  private draggingPoint = false;
  cols = 10;
  rows = 10;
  /**
   * 图纸的米制宽高比（W/H）。设置后纸张按该比例适配画布，
   * 底图落位因此只由项目数据决定，不再随窗口/手机尺寸漂移
   * （导入的点位锚定在底图上，跨设备打开才不会错位）。
   */
  worldAspect = 0;
  onZoomChange: ((z: number) => void) | null = null;

  constructor(wrap: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'plot-canvas';
    wrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(wrap);
    this.resize();

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      this.zoomAt(e.offsetX, e.offsetY, factor);
    }, { passive: false });

    // ── 指针手势：单指/左键拖动平移，双指捏合缩放（安卓 WebView 无滚轮）──
    const pointers = new Map<number, { x: number; y: number }>();
    let pinch: { dist: number; mx: number; my: number } | null = null;

    this.canvas.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      this.canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pointers.size === 1) {
        // 先问一下是否抓住了测点：抓住就不平移画布
        this.draggingPoint = this.onPointDragStart ? this.onPointDragStart(e.offsetX, e.offsetY) === true : false;
        this.dragStart = this.draggingPoint ? null : { x: e.offsetX, y: e.offsetY, moved: false };
        pinch = null;
      } else if (pointers.size === 2) {
        this.dragStart = null; // 多指时不再判定为点击
        pinch = pinchState(pointers);
      }
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

      if (pointers.size >= 2 && pinch) {
        const now = pinchState(pointers);
        if (now && pinch.dist > 1) {
          const factor = now.dist / pinch.dist;
          if (Math.abs(factor - 1) > 0.001) this.zoomAt(now.mx, now.my, factor);
          // 双指整体平移
          const dx = now.mx - pinch.mx;
          const dy = now.my - pinch.my;
          if (dx || dy) {
            this.transform.panX += dx;
            this.transform.panY += dy;
            this.clampPan();
            this.paint();
          }
        }
        pinch = now;
        return;
      }

      if (this.draggingPoint) {
        this.onPointDragMove?.(e.offsetX, e.offsetY);
        return;
      }

      if (this.dragStart) {
        const dx = e.offsetX - this.dragStart.x;
        const dy = e.offsetY - this.dragStart.y;
        const threshold = e.pointerType === 'mouse' ? 4 : 8; // 手指抖动更大
        if (this.dragStart.moved || Math.hypot(dx, dy) >= threshold) {
          this.dragStart.moved = true;
          this.transform.panX += dx;
          this.transform.panY += dy;
          this.dragStart.x = e.offsetX;
          this.dragStart.y = e.offsetY;
          this.clampPan();
          this.paint();
        }
      }
      if (this.onHover) {
        const w = this.worldRect();
        if (w.width > 0 && w.height > 0) {
          this.onHover((e.offsetX - w.left) / w.width, (e.offsetY - w.top) / w.height);
        }
      }
    });

    this.canvas.addEventListener('pointerleave', () => this.onHover?.(NaN, NaN));

    this.canvas.addEventListener('pointerup', (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (this.draggingPoint) {
        this.draggingPoint = false;
        this.onPointDragEnd?.();
        this.canvas.style.cursor = 'crosshair';
        return;
      }
      const start = this.dragStart;
      this.dragStart = null;
      if (!start || start.moved || pointers.size > 0) return; // 拖动或多指结束不触发点击
      if (this.rawTapMode) {
        const w = this.worldRect();
        if (w.width <= 0 || w.height <= 0) return;
        this.onRawTap?.((e.offsetX - w.left) / w.width, (e.offsetY - w.top) / w.height);
        return;
      }
      if (!this.onTap) return;
      const hit = this.nearestIntersection(e.offsetX, e.offsetY);
      if (hit) this.onTap(hit.col, hit.row);
    });

    this.canvas.addEventListener('pointercancel', (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (this.draggingPoint) {
        this.draggingPoint = false;
        this.onPointDragEnd?.();
      }
      this.dragStart = null;
    });
  }

  setPainter(fn: (world: Rect, t: Transform) => void): void {
    this.onPaint = fn;
  }

  /** 适应全部内容（纸张 + 可能溢出的底图）；无溢出时等价于 1:1 居中。 */
  fit(): void {
    this.fitToContent();
  }

  zoomStep(factor: number): void {
    const { width, height } = this.canvasRect();
    this.zoomAt(width / 2, height / 2, factor);
  }

  private zoomAt(px: number, py: number, factor: number): void {
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.transform.zoom * factor));
    if (nz === this.transform.zoom) return;
    const rect = this.viewport();
    // 以光标为锚：光标下的世界点保持不动
    const wx = (px - rect.left - this.transform.panX) / (rect.width * this.transform.zoom);
    const wy = (py - rect.top - this.transform.panY) / (rect.height * this.transform.zoom);
    this.transform.zoom = nz;
    this.transform.panX = px - rect.left - wx * rect.width * nz;
    this.transform.panY = py - rect.top - wy * rect.height * nz;
    this.clampPan();
    this.paint();
    this.onZoomChange?.(nz);
  }

  /**
   * 可浏览内容范围（归一化 0..1，可超出纸面）。
   * 底图按定标放大后可能超出纸面，此时缩放/平移边界要按「内容」算，
   * 否则超出部分永远看不到、也点不到。
   */
  contentRect = { u0: 0, v0: 0, u1: 1, v1: 1 };

  /** 内容相对纸张是否溢出（用于状态提示/自动适配）。 */
  contentOverflow(): boolean {
    const c = this.contentRect;
    return c.u0 < -1e-6 || c.v0 < -1e-6 || c.u1 > 1 + 1e-6 || c.v1 > 1 + 1e-6;
  }

  /** 让全部内容（纸张 + 溢出底图）刚好放进视口。 */
  fitToContent(): void {
    const rect = this.viewport();
    const c = this.contentRect;
    const cw = Math.max(1e-6, c.u1 - c.u0);
    const ch = Math.max(1e-6, c.v1 - c.v0);
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(1 / cw, 1 / ch)));
    this.transform.zoom = z;
    const w = rect.width * z;
    const h = rect.height * z;
    // 内容居中：内容左边界对应 panX + c.u0*w = 0，再整体居中
    this.transform.panX = -c.u0 * w + (rect.width - cw * w) / 2;
    this.transform.panY = -c.v0 * h + (rect.height - ch * h) / 2;
    this.clampPan();
    this.paint();
    this.onZoomChange?.(this.transform.zoom);
  }

  private clampPan(): void {
    const rect = this.viewport();
    const z = this.transform.zoom;
    const w = rect.width * z;
    const h = rect.height * z;
    const c = this.contentRect;
    // 允许把内容拖出视口一点点（15% 视口），这样「刚好看全」时也能微调，
    // 不会出现"点了拖动毫无反应"的错觉。
    const slackX = rect.width * 0.15;
    const slackY = rect.height * 0.15;

    const cw = (c.u1 - c.u0) * w;
    const ch = (c.v1 - c.v0) * h;

    // 内容装得下 → 一律居中（此时拖动无意义，强行居中最不别扭）
    // 内容装不下 → 允许拖到内容边缘，并留 15% 视口余量方便微调
    if (cw <= rect.width) {
      this.transform.panX = (rect.width - cw) / 2 - c.u0 * w;
    } else {
      const maxPanX = -c.u0 * w + slackX;
      const minPanX = rect.width - c.u1 * w - slackX;
      this.transform.panX = Math.min(maxPanX, Math.max(minPanX, this.transform.panX));
    }

    if (ch <= rect.height) {
      this.transform.panY = (rect.height - ch) / 2 - c.v0 * h;
    } else {
      const maxPanY = -c.v0 * h + slackY;
      const minPanY = rect.height - c.v1 * h - slackY;
      this.transform.panY = Math.min(maxPanY, Math.max(minPanY, this.transform.panY));
    }
  }

  /** 当前视口内测量区域的基准矩形（未含缩放平移）。 */
  viewport(): Rect {
    const { width, height } = this.canvasRect();
    const pad = this.pad;
    const padR = this.padRight;
    const availW = Math.max(1, width - pad - padR);
    const availH = Math.max(1, height - 2 * pad);

    // 纸张按真实宽高比适配；未设置时退回旧的「网格等分」规则
    const aspect = this.worldAspect > 0
      ? this.worldAspect
      : (this.cols > 0 && this.rows > 0 ? this.cols / this.rows : 1);
    let w = availW;
    let h = w / aspect;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    // 极小画布时保证还有可绘制区域
    if (!(w > 1) || !(h > 1)) { w = availW; h = availH; }

    const left = pad + (availW - w) / 2;
    const top = pad + (availH - h) / 2;
    return { left, top, width: w, height: h };
  }

  /** 缩放平移后的世界矩形（画布像素坐标）。 */
  worldRect(): Rect {
    const r = this.viewport();
    const z = this.transform.zoom;
    const w = r.width * z;
    const h = r.height * z;
    return { left: r.left + this.transform.panX, top: r.top + this.transform.panY, width: w, height: h };
  }

  /** 画布像素 → 交汇点（col,row），无有效点返回 null。 */
  pointAt(px: number, py: number): { col: number; row: number } | null {
    const w = this.worldRect();
    const cw = w.width / this.cols;
    const ch = w.height / this.rows;
    const col = Math.round((px - w.left) / cw);
    const row = Math.round((py - w.top) / ch);
    if (col < 0 || col > this.cols || row < 0 || row > this.rows) return null;
    const dist = Math.hypot(px - (w.left + col * cw), py - (w.top + row * ch));
    return dist < Math.min(cw, ch) * 0.55 ? { col, row } : null;
  }

  private nearestIntersection(px: number, py: number): { col: number; row: number } | null {
    return this.pointAt(px, py);
  }

  private canvasRect(): { width: number; height: number } {
    return { width: this.canvas.width / devicePixelRatio, height: this.canvas.height / devicePixelRatio };
  }

  resize(): void {
    const wrap = this.canvas.parentElement;
    if (!wrap) return;
    const dpr = devicePixelRatio;
    this.canvas.width = Math.max(1, Math.floor(wrap.clientWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(wrap.clientHeight * dpr));
    this.canvas.style.width = `${wrap.clientWidth}px`;
    this.canvas.style.height = `${wrap.clientHeight}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.clampPan();   // 画布尺寸变了，平移量要重新夹紧
    this.paint();
  }

  paint(): void {
    // 每次绘制前都夹紧一次：布局变化（抽屉开合、页签切换）后画布尺寸可能已变，
    // 不夹紧就会出现「内容被推到角落、看起来显示不全」的假象。
    this.clampPan();
    const { width, height } = this.canvasRect();
    this.ctx.clearRect(0, 0, width, height);
    this.onPaint(this.worldRect(), this.transform);
  }

  get ctx2d(): CanvasRenderingContext2D {
    return this.ctx;
  }
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 双指的中心点与间距，用于捏合缩放。 */
function pinchState(pointers: Map<number, { x: number; y: number }>): { dist: number; mx: number; my: number } | null {
  const pts = [...pointers.values()];
  if (pts.length < 2) return null;
  const [a, b] = pts;
  return {
    dist: Math.hypot(a.x - b.x, a.y - b.y),
    mx: (a.x + b.x) / 2,
    my: (a.y + b.y) / 2,
  };
}

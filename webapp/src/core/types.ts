/** 与旧版 Kotlin / JSON 导出格式字段兼容，旧 data.json 可无损导入并自动迁移到自由测点。 */
export interface Project {
  id: number;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  /**
   * 旧版网格字段：现在仅作为「图纸范围」的历史来源保留。
   * 新项目请使用 worldW / worldH（米）。读取时统一走 worldSize()。
   */
  cols: number;
  rows: number;
  spacingX: number;
  spacingY: number;
  /** 图纸（测量范围）实际宽高，米。有底图时由定标结果推导。 */
  worldW?: number;
  worldH?: number;
  backgroundImagePath?: string | null;
  planReferenceMeters?: number | null;
  overlayAlpha: number;
  baseMapOffsetX: number;
  baseMapOffsetY: number;
  baseMapScale: number;
  backgroundNoiseDb: number;
  contourColorBands: number;
  /** 底图（图片 / PDF 首页渲染结果）的 dataURL，随项目 JSON 一起保存 */
  backgroundImageData?: string | null;
  /** CAD（DXF）线图原文，随项目 JSON 一起保存（矢量绘制，不栅格化） */
  backgroundDxfText?: string | null;
  /**
   * 两点定标结果：底图上两点（归一化世界坐标 0..1）及其真实长度（米）。
   * 用于把底图比例校准到真实米制，并在图上标出该线段。
   */
  baseMapCalibration?: {
    u1: number; v1: number; u2: number; v2: number; meters: number;
  } | null;
}

/**
 * 测点：任意位置（米，原点在图左上角，y 向下），不再限制在网格交点。
 * 旧数据里的 col/row 会在载入时迁移为 x/y。
 */
export interface Measurement {
  projectId: number;
  /** 唯一标识（便于拖动/编辑/删除） */
  id: string;
  /** 相对图纸左上角的水平距离（米） */
  x: number;
  /** 相对图纸左上角的垂直距离（米，向下为正） */
  y: number;
  spl: number;
  note: string;
  isNoiseSource?: boolean;
  /** 旧版网格坐标，仅迁移时使用 */
  col?: number;
  row?: number;
}

export interface ProjectWithMeasurements {
  project: Project;
  measurements: Measurement[];
}

/** 图纸范围（米）：优先 worldW/H，其次旧的网格尺寸，最后默认 40×30。 */
export function worldSize(p: Project): { w: number; h: number } {
  const w = p.worldW ?? (p.cols > 0 && p.spacingX > 0 ? p.cols * p.spacingX : 40);
  const h = p.worldH ?? (p.rows > 0 && p.spacingY > 0 ? p.rows * p.spacingY : 30);
  return { w: w > 0.1 ? w : 40, h: h > 0.1 ? h : 30 };
}

export function newProject(name: string, description: string, worldW = 40, worldH = 30): Project {
  const now = Date.now();
  return {
    id: now,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    // 旧字段保留为 1，避免下游除零；真实范围看 worldW/worldH
    cols: 1,
    rows: 1,
    spacingX: worldW,
    spacingY: worldH,
    worldW,
    worldH,
    backgroundImagePath: null,
    planReferenceMeters: null,
    overlayAlpha: 0.72,
    baseMapOffsetX: 0,
    baseMapOffsetY: 0,
    baseMapScale: 1,
    backgroundNoiseDb: 0,
    contourColorBands: 32,
  };
}

export function newPointId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 兼容旧调用：旧版用于显示「共 N 个测点」，现在返回 0（自由测点，无固定容量）。 */
export function pointCount(_p: Project): number {
  return 0;
}

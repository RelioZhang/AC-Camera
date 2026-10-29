# NoiseAtlas 噪声图谱（重构版 · 方案 A）

厂区噪声网格普查与等声压级成图工具（原 AC-Camera 重构版）。此目录是 **Tauri 2 + TypeScript 重构**的 Web 核心——
先在浏览器里开发验证全部业务（M0-M4），最后再包 Tauri 出 Windows exe（M5）。

## 快速开始

```bash
cd webapp
npm install
npm run dev       # 浏览器打开 http://localhost:5173
```

构建：`npm run build`（产物在 `dist/`，任意静态服务器可跑）。

## 数据存储

- 默认存浏览器 localStorage；点击左下角「数据存于浏览器本地…」提示文字可选择
  一个**数据文件夹**（Edge/Chrome 的 File System Access API），之后自动读写
  `ac-camera-data.json`。
- 「导出 JSON / 导入 JSON」与安卓版、旧 Windows 桌面版数据格式完全互通
  （`List<{project, measurements[]}>`），旧文件可直接导入。

## 标准工作流（现场版）

1. **导入底图** —— 厂区平面图（照片 / PDF / DXF）
2. **两点评定标** —— 在底图点两个已知实际距离的点，输入米数，自动校准比例
3. **输入测点数据** —— 在底图任意位置单击即可布点并录入 dB（不再要求网格）
4. **绘制等声压级曲线** —— 声场以测点包围盒为计算域，自动生成彩图 + 等值曲线

## 已实现

- 项目管理：新建/删除/切换，cell 语义网格（测点 = 网格线交汇处，(cols+1)×(rows+1)）
- 数据录入：滚轮缩放/拖动平移/点击交汇点弹窗录入，输入即保存，已测点着色（蓝低红高）+ 数值标注
- 等声压级图：能量叠加+距离衰减声场（与 Kotlin 版同一模型），底噪下限，
  色阶 8-256 可选（带调色板量化），透明度滑杆，带 min/中/max 数值的图例
- 等值线：行进方块法（移植 Kotlin ContourBuilder，含鞍点拆分）
- 底图：图片 / PDF（第 1 页）/ DXF 矢量；独立缩放平移对齐；**两点定标**
  （在底图上点两个已知实际距离的点，输入米数，自动把底图比例校准到网格米制并生成真比例尺）
- 噪声源：8 邻域严格局部极大值 + 阈值，黑圈标记
- 网格设置：名称/行列数/间距/底噪/底图参照宽度
- JSON 导入导出；「载入示例项目」一键生成演示数据

## 路线图

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| M0 | 骨架 + 项目 CRUD + JSON 持久化 | ✅ |
| M1 | 网格渲染 + 交汇点录入 | ✅ |
| M2 | 声场 + 色阶热力图 + 数值图例 | ✅（等值线待接 d3-contour） |
| M3 | 底图（图片/PDF/DXF）+ 独立对齐 + 比例尺 | ⬜ |
| M4 | 噪声源分析 + 治理备注 | ⬜ |
| M5 | Tauri 打包 Windows exe | ✅ |

## 目录结构

```
webapp/
├── index.html            # 单页 UI 骨架
├── package.json          # 仅 vite + typescript 两个开发依赖，零运行时依赖
├── tsconfig.json
└── src/
    ├── main.ts           # 应用壳：状态/项目列表/录入/等值线/设置
    ├── styles.css
    ├── core/
    │   ├── types.ts      # Project / Measurement（字段与旧 JSON 兼容）
    │   ├── field.ts      # 声场模型 + colormap + 色带量化（自 Kotlin 1:1 移植）
    │   ├── storage.ts    # localStorage / File System Access / JSON 导入导出
    │   └── main-state.ts # 解循环依赖的小助手
    └── ui/
        └── plot.ts       # 通用网格画布（缩放/平移/命中；手势直读当前变换，无陈旧闭包）
```

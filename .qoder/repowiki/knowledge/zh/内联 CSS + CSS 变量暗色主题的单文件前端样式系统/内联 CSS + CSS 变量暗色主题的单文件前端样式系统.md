---
kind: frontend_style
name: 内联 CSS + CSS 变量暗色主题的单文件前端样式系统
category: frontend_style
scope:
    - '**'
source_files:
    - index.html
---

本仓库的前端样式完全集中在 `index.html` 的 `<style>` 块中，采用“单文件内联 CSS”方案，未引入任何外部 CSS 框架、CSS-in-JS 库或构建工具。整体风格为深色交易面板，视觉一致性通过一套集中定义的 CSS 自定义属性（Design Tokens）实现。

**1. 样式系统与工具链**
- 无第三方 UI 组件库、无 Tailwind/Bootstrap、无 SCSS/Less 预处理。
- 所有样式以原生 CSS 编写并直接内联在 HTML 头部，由 Node.js `server.mjs` 作为静态资源返回。
- 图表绘制全部使用原生 Canvas API（`drawCandlestick`、`drawRSIChart`、`drawLineChart` 等），不依赖 ECharts/ApexCharts 等可视化库。

**2. 设计令牌（Design Tokens）**
通过 `:root` 定义全局颜色与基础变量，形成统一的暗色主题：
- 背景与卡片：`--bg: #0d1117`、`--card: #161b22`、`--border: #30363d`
- 文本：`--text: #e6ed3`、`--text2: #8b949e`
- 语义色：`--green: #3fb950`（涨/多头）、`--red: #f85149`（跌/空头）、`--yellow: #d29922`（中性/警告）、`--blue: #58a6ff`（主操作色）
- 字体栈：`-apple-system, 'Segoe UI', sans-serif`

**3. 布局与响应式策略**
- 主要布局基于 CSS Grid（`.overview`、`.charts-grid`、`.entry-rec-grid`）和 Flexbox（`.header`、`.filter-bar`、`.controls`）。
- 响应式通过两个断点覆盖：`@media (max-width: 768px)` 和 `@media (max-width: 480px)`，调整网格列数、字号、间距及隐藏次要标签。
- 大量使用 `auto-fit` / `minmax()` 实现自适应卡片布局。

**4. 组件化命名约定**
类名采用 BEM 风格的扁平命名，按功能域分组：
- 模块前缀：`.header`、`.filter-bar`、`.coin-tabs`、`.kline-section`、`.strategy-section`、`.sim-section`、`.pos-health-section`、`.alert-section`、`.signal-detail-card`、`.stat-card`、`.chart-card`、`.smart-signal-panel`、`.entry-rec`、`.sim-pos-card`、`.pos-health-card`、`.alert-item`、`.alert-toast`、`.chart-tooltip` 等。
- 状态修饰符：`.active`、`.show`、`.collapsed`、`.expanded`、`.editing`、`.live`、`.error`、`.loading`、`.healthy`、`.warning`、`.critical`、`.long`、`.short`、`.up`、`.down`、`.neutral` 等。
- 交互态：`:hover`、`:focus` 统一使用 `var(--blue)` 高亮边框与文字。

**5. 动画与微交互**
- 关键帧：`@keyframes spin`（加载旋转）、`@keyframes pulse`（状态点呼吸）、`@keyframes fadeSlideDown`（详情卡片滑入）、`@keyframes slideIn`（Toast 弹出）。
- 过渡：按钮、Tab、Pill 普遍使用 `transition: all 0.15s` 提供轻量反馈。

**6. 开发者应遵循的规则**
- 新增样式一律写在 `index.html` 的 `<style>` 块内，优先复用现有 CSS 变量而非硬编码颜色值。
- 类名沿用现有命名空间（如 `.xxx-section`、`.xxx-card`、`.xxx-tab`、`.xxx-badge`），避免随意创造新前缀。
- 新增组件时同步补充 `768px` 与 `480px` 两档响应式适配。
- 图表相关样式仅控制 canvas 容器尺寸（如 `.chart-card canvas { height: 220px !important; }`），具体绘图逻辑在 JS 函数内部处理。
- 状态类（`.active`、`.show`、`.loading` 等）通过 JS 动态切换，不要在 CSS 中写死显隐逻辑。
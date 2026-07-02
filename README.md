# BinaceSmart - 币安聪明钱监控面板

基于币安合约 API 的实时聪明钱（Smart Money）监控工具，提供 Web 面板和终端两种使用方式。

## 功能

- **K 线图** — 蜡烛图 + MA5/MA20/MA60 均线 + 成交量柱状图
- **RSI 指标** — RSI6 / RSI12 / RSI24 三线，超买超卖区高亮
- **十字光标** — 鼠标悬浮显示价格、时间、OHLCV、振幅、涨跌幅
- **聪明钱分析** — 大户多空比（账户+持仓）、全网多空比、持仓量变化、主动买卖量
- **信号摘要** — 自动判断大户翻多/翻空、聪明钱抄底信号、资金费率状态
- **多币种** — 预设 8 个币种一键切换 + 自定义增删 + URL 参数同步
- **报警系统** — 价格突破/跌破、RSI 超买超卖、大户翻多翻空、买入/卖出激增
- **飞书推送** — 报警触发时推送到飞书群（Webhook 方式）
- **浏览器通知** — 系统通知 + 声音提醒

## 快速开始

### 环境要求

- Node.js >= 20

### 安装 & 启动

```bash
git clone git@github.com:kekexilinan/BinaceSmart.git
cd BinaceSmart

# Web 面板
npm run dev
# 打开 http://localhost:3388

# 终端版
node smart-money.mjs SLXUSDT 60
```

### 配置飞书推送（可选）

创建 `.env` 文件：

```
FEISHU_WEBHOOK=https://open.feishu.cn/open-apis/bot/v2/hook/你的webhook地址
```

在飞书群聊中添加自定义机器人即可获取 Webhook URL。

## 使用方式

### Web 面板

```bash
npm run dev
# 或
node server.mjs
```

访问 `http://localhost:3388`，支持参数：
- `?symbol=BTCUSDT` — 指定币种
- `?interval=30` — 刷新间隔（秒）

### 终端版

```bash
# 默认监控 SLX，60 秒刷新
node smart-money.mjs

# 自定义币种和间隔
node smart-money.mjs BTCUSDT 30
```

## 报警条件

| 条件 | 说明 |
|------|------|
| 价格 > / < | 价格突破或跌破指定值 |
| RSI6 > / < | RSI6 超买/超卖 |
| 大户翻多 | 大户持仓多空比 > 1 |
| 大户翻空 | 大户持仓多空比 < 1 |
| 买入激增 | 主动买卖比 > 1.2 |
| 卖出激增 | 主动买卖比 < 0.8 |

## 右侧稳趋势推送

定时扫描 Top 200 USDT 合约币种，筛选符合「右侧稳趋势」条件的币种并推送到飞书。

推送内容包含：价格、相对 8 点涨幅、评分、回撤、大户/全网多空比、连续推荐次数。

自动过滤股票对应的币（COIN、MSTR、HOOD）。

### 配置（.env）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `FEISHU_WEBHOOK` | 无 | 飞书机器人 Webhook URL，必填 |
| `STABLE_PUSH_HOURS` | `1` | 推送间隔（小时） |
| `STABLE_PUSH_ENABLED` | `true` | 设为 `false` 可关闭推送 |
| `STABLE_SCAN_LIMIT` | `200` | 扫描币种数量 |
| `STABLE_MAX_DRAWDOWN` | `0.30` | 最大回撤阈值（30%） |

### 手动触发推送

```bash
curl -X POST http://localhost:3388/api/trigger-stable-push
```

## 系统服务管理

已配置为 systemd user service，开机自动启动。

```bash
# 查看服务状态
systemctl --user status binance-monitor

# 重启服务
systemctl --user restart binance-monitor

# 停止服务
systemctl --user stop binance-monitor

# 查看实时日志
journalctl --user -u binance-monitor -f

# 查看最近 100 行日志
journalctl --user -u binance-monitor -n 100

# 禁用开机自启
systemctl --user disable binance-monitor

# 重新启用开机自启
systemctl --user enable binance-monitor
```

服务配置文件位于 `~/.config/systemd/user/binance-monitor.service`。

## API

服务端代理币安合约 API，避免前端跨域问题：

- `GET /api/data?symbol=SLXUSDT` — 聪明钱全量数据
- `GET /api/klines?symbol=SLXUSDT&interval=1h&limit=100` — K 线数据
- `POST /api/feishu-alert` — 发送飞书报警
- `POST /api/trigger-stable-push` — 手动触发稳趋势推送

## 技术栈

- Node.js 原生 HTTP 服务器（零依赖）
- HTML5 Canvas 图表渲染
- 币安合约 REST API（fapi.binance.com）
- 飞书群机器人 Webhook

## 免责声明

本工具仅供数据分析参考，不构成投资建议。合约交易风险极高，请谨慎操作。

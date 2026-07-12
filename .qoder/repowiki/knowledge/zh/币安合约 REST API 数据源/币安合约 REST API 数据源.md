---
kind: external_dependency
name: 币安合约 REST API 数据源
slug: binance-futures-api
category: external_dependency
category_hints:
    - vendor_identity
    - client_constraint
scope:
    - '**'
---

### 币安合约 REST API
- **角色**：项目核心数据源，提供价格、K线、大户多空比、持仓量、资金费率等全量行情与聪明钱数据
- **约束**：需配置 `HTTPS_PROXY`/`HTTP_PROXY` 环境变量（Windows 下通过 `curl.exe --proxy` 回退）；Smart Signal 接口有 418/429/403 熔断保护，触发后按 `retry-after` 头延迟重试
- **关键端点**：`/fapi/v1/klines`（8am基准价）、`/futures/data/topLongShortAccountRatio`（大户账户多空比）、`/fapi/v1/fundingRate`（资金费率）
- **注意**：Smart Signal 接口走 `www.binance.com/bapi/futures/v1/public/future/smart-money/signal/overview`，与 fapi 域名不同，限流策略独立
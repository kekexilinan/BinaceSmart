---
kind: external_dependency
name: 市值数据源（CMC Pro → CoinGecko 回退）
slug: coinmarketcap-pro-api
category: external_dependency
category_hints:
    - vendor_identity
    - migration_status
scope:
    - '**'
---

### 市值查询服务
- **主从关系**：优先使用 `CMC_API_KEY` 访问 CoinMarketCap Pro API；未配置时自动回退到 CoinGecko 免费接口
- **约束**：CoinGecko 免费版存在速率限制和数据不全问题，生产环境建议配置 CMC Key；`MAX_MARKET_CAP_USD=0` 可关闭过滤
---
kind: external_dependency
name: 飞书群机器人 Webhook 推送
slug: feishu-webhook
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
---

### 飞书 Webhook 通知通道
- **角色**：报警与稳趋势推送的出站通道，支持两种卡片格式（v1 interactive card 与 v2 schema 2.0）
- **认证协议**：Webhook URL 本身即凭据，无需额外签名；URL 格式为 `https://open.feishu.cn/open-apis/bot/v2/hook/{webhook_id}`
- **消息体**：v1 使用 `msg_type=interactive` + `card.elements[markdown]`；v2 使用 `schema=2.0` + `body.elements` 数组
- **开关控制**：`SMART_TREND_DECISION_WEBHOOK` 可覆盖默认 webhook，`*_PUSH_ENABLED` 环境变量逐个功能开关
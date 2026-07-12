---
kind: logging_system
name: 基于 console 的轻量日志输出与 PM2 文件转储
category: logging_system
scope:
    - '**'
source_files:
    - logs/service-out.log
    - logs/service-error.log
    - ecosystem.config.cjs
---

本仓库未引入任何第三方日志框架（winston、pino、bunyan、debug、morgan 等），也未定义统一的 logger 模块或日志级别枚举。所有运行时输出均通过 Node.js 内置 console.log / console.warn / console.error 直接打印，再由进程管理器 PM2 将 stdout/stderr 重定向到 logs/service-out.log 和 logs/service-error.log 两个文本文件中。

- 使用方式
  - 正常信息：console.log(...)，包含启动横幅、定时任务计划、扫描结果摘要等；
  - 警告/降级：console.warn(...)，用于 API 重试提示、缓存刷新失败回退、推送异常等；
  - 错误：console.error(...)，仅脚本入口捕获未处理异常时使用，且无堆栈统一格式化。

- 结构与约定
  - 无结构化字段（timestamp、level、module、traceId 等均未注入），每条日志为纯字符串行；
  - 采用 emoji + 中文前缀作为视觉分级（如 ⚠、✓、📸、[CMC]、[CoinGecko]、[TradFi过滤]），便于人眼在 PM2 日志中快速定位上下文；
  - 错误日志不附带堆栈，仅拼接 e.message，避免污染主日志流。

- 输出路由
  - 由 PM2 配置文件（ecosystem.config.cjs）管理进程，stdout → logs/service-out.log，stderr → logs/service-error.log；
  - 无日志轮转、压缩、远程收集或告警集成，依赖操作系统级 logrotate 或外部采集器。

- 开发者应遵循的规则
  - 新增日志一律使用 console.log/warn/error，不要自行引入日志库；
  - 关键流程用 emoji 前缀区分状态（成功 ✓、警告 ⚠、阻塞 ⏳、启动 🚀 等），保持风格一致；
  - 异常路径只输出 e.message，避免重复堆栈；
  - 如需结构化查询能力，应在上层通过 PM2 日志聚合方案实现，而非在应用层改造。
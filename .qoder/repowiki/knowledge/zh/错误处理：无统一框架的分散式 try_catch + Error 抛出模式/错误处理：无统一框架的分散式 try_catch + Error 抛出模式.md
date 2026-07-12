---
kind: error_handling
name: 错误处理：无统一框架的分散式 try/catch + Error 抛出模式
category: error_handling
scope:
    - '**'
source_files:
    - server.mjs
    - proxy-setup.mjs
    - position-health-monitor.mjs
    - position-health.mjs
    - scan-dump-risk.mjs
---

该仓库未建立统一的错误处理体系（无 `errors/` 目录、无自定义错误类、无全局中间件或 panic/recover），而是采用**分散式 try/catch + 原生 `Error` 抛出**的方式，在各脚本中就地捕获并记录警告。主要特征如下：

1. **错误定义与传播**
   - 所有业务异常均通过 `throw new Error(...)` 向上冒泡，错误消息多为中文描述，如 `"币安 API: ..."`、`"地区限制: ..."`、`"FEISHU_WEBHOOK 未配置"`。
   - 参数校验失败直接抛错（如 `position-health.mjs` 中 `symbol 与 entryPrice 必填且有效`）；外部 API 返回码异常由 `proxy-setup.mjs` 的 `fetchJson` / `fetchJsonViaCurl` 包装为 `Error`。
   - 未发现任何自定义错误类型或错误码枚举，调用方仅能依赖 `e.message` 字符串判断。

2. **网络层容错**
   - `server.mjs` 中的 `proxyBinance` 实现固定次数重试 + 指数退避，最终将最后一次异常原样抛出。
   - `waitForNetworkReady` 提供带最大尝试次数的启动探测，失败时抛出包含标签的错误。
   - `scan-dump-risk.mjs` 对批量并发请求使用 `.catch(() => [])` 或 `Promise.allSettled`，将单个接口失败降级为缺失字段而非中断流程。
   - `pmap` 内部 worker 对每个元素单独 try/catch，保证部分失败不影响整体结果集。

3. **调度与推送层容错**
   - 定时任务（稳趋势推送、持仓健康监控等）外层包裹 try/catch，失败仅 `console.warn` 并继续下一次调度，避免进程退出。
   - 飞书推送在频控错误下内置重试（最多 4 次，按 3s/6s/9s 递增），非限流错误立即抛出。
   - 持仓健康监控维护 `lastState` Map 做紧急告警去重与冷却，避免同一仓频繁重复推送。

4. **HTTP 路由层**
   - 基于 Node 内置 `http` 模块，无 Express/Koa 中间件；对 TradFi 币种和超大市值币种通过 `res.writeHead(403, ...)` 直接返回 JSON 错误体，不抛异常。

5. **日志与可观测性**
   - 错误信息统一通过 `console.warn('⚠ ...')` 输出，配合 PM2 的 `service-error.log` 收集；未见结构化日志库或错误上报服务。

开发者约定（从现有代码归纳）：
- 对外部不可靠 I/O（API、网络、第三方推送）一律 try/catch 并降级为默认值或空数组，不要中断主流程。
- 对参数非法、配置缺失等“可预期”错误使用 `throw new Error(...)` 上抛，由上层统一捕获并 warn。
- 批量并发场景优先用 `Promise.allSettled` 或逐个 try/catch，保留成功结果。
- 定时任务外层必须 try/catch，确保单次失败不影响后续周期执行。
- 错误消息应包含上下文（如币种、URL、状态码），便于日志排查。
---
kind: dependency_management
name: 零依赖 Node.js ESM 脚本与 pnpm 锁文件
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - pnpm-lock.yaml
    - .nvmrc
---

本仓库采用极简的“零第三方依赖”策略：所有功能模块均为独立的 Node.js ESM 单文件脚本，仅使用 Node.js 内置模块（如 `node:http`、`node:fs/promises`、`node:path`、`node:child_process`、`node:util` 等）和相对路径导入本地 `.mjs` 模块。`package.json` 中未声明任何 `dependencies`，`devDependencies` 也为空；pnpm 锁文件 `pnpm-lock.yaml` 仅包含 lockfile 元信息与空 importer，表明项目不安装任何外部包。运行时通过 `.nvmrc` 锁定 Node.js 版本为 24，并通过 `engines.node >= 20` 约束最低版本。开发/启动入口统一由 `server.mjs` 与各扫描器脚本承担，进程管理交由 PM2（`ecosystem.config.cjs`）及 Windows 服务脚本完成。该模式避免了第三方库升级风险与供应链攻击面，适合高频交易监控场景对稳定性的要求。
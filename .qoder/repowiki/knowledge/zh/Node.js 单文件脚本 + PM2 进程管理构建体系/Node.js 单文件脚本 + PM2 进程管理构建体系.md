---
kind: build_system
name: Node.js 单文件脚本 + PM2 进程管理构建体系
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - ecosystem.config.cjs
    - scripts/install-service.ps1
    - scripts/start-pm2-silent.vbs
    - scripts/pm2-resurrect.cmd
    - scripts/run-service.cmd
    - start-dev.bat
---

本项目采用极简的 Node.js ESM 单文件脚本架构，无传统编译步骤，依赖 pnpm 进行包管理与脚本编排，通过 PM2 实现生产环境进程守护与自动重启。

运行环境与依赖管理：使用 package.json 声明项目元信息与 npm scripts，指定 Node.js 引擎版本要求 >=20，模块系统为 ESM。依赖锁定文件为 pnpm-lock.yaml，所有业务逻辑均为 .mjs 单文件脚本，无需打包或转译。开发时通过 --use-env-proxy 参数启用代理支持，便于本地调试。

进程管理与部署：PM2 配置文件 ecosystem.config.cjs 定义单一应用实例，fork 模式、最大内存 512M、自动重启策略（最多 10 次，最小存活 30s，重启延迟 10s）。Windows 服务化方案提供两套路径：PM2 静默启动通过 start-pm2-silent.vbs 加 pm2-resurrect.cmd 组合，在用户登录时以隐藏窗口拉起 PM2，优先尝试 resurrect 已有进程，否则全新启动；纯 WScript 后台服务由 install-service.ps1 注册 Windows 计划任务，直接通过 VBS 调用 server.mjs，不依赖 PM2。日志输出分离至 logs/service-out.log 和 logs/service-error.log，PM2 模式下额外生成 logs/pm2-out.log 与 logs/pm2-error.log。

开发与运维脚本：dev-restart.mjs 提供端口占用检测与热重启能力。scripts 目录集中存放运维工具：PM2 安装卸载、Windows 服务安装停止、飞书推送 mock 数据生成与预览等。start-dev.bat 作为 Windows 快捷入口，统一提示服务管理命令。

构建约束与约定：无 Makefile/Dockerfile/CI 配置，部署方式为直接拷贝源码到目标机器并执行安装脚本。环境变量通过 .env.example 模板管理，运行时由 --use-env-proxy 注入代理配置。所有扫描器与监控脚本均以独立可执行脚本形式存在，通过 pnpm monitor:* 系列命令快速启动。
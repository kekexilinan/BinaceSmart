/** PM2 进程配置 — Windows / Linux 通用 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'binace-smart',
      script: 'server.mjs',
      cwd: __dirname,
      interpreter: 'node',
      node_args: '--use-env-proxy',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '512M',
      // Windows: 禁止弹出控制台窗口
      windowsHide: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};

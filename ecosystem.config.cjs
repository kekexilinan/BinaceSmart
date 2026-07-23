const path = require('path');

module.exports = {
  apps: [
    {
      name: 'binace-smart',
      script: 'server.mjs',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      min_uptime: '30s',
      restart_delay: 10000,
      max_memory_restart: '1G',
      windowsHide: true,
      time: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(__dirname, 'logs', 'pm2-error.log'),
      out_file: path.join(__dirname, 'logs', 'pm2-out.log'),
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        STRATEGY_REVIEW_ENABLED: 'false',
        WHALE_HISTORY_INTERVAL_MIN: '15',
      },
    },
  ],
};
module.exports = {
  apps: [
    {
      name: 'mcp-famachat',
      script: './dist/index.js',
      cwd: '/var/www/mcp-famachat',
      instances: 1,
      exec_mode: 'fork',
      // O servidor lê o .env pelo --env-file do Node, como o famachat-backend faz.
      node_args: '--env-file=.env --no-deprecation',
      out_file: './logs/mcp-famachat-out.log',
      error_file: './logs/mcp-famachat-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      max_memory_restart: '300M',
      restart_delay: 4000,
      min_uptime: '10s',
      max_restarts: 10,
      time: true,
    },
  ],
};

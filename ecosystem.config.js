module.exports = {
  apps: [{
    name: 'tiktok-sales-bot',
    script: './dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    time: true,
    env: {
      NODE_ENV: 'development',
    },
    env_production: {
      NODE_ENV: 'production',
    }
  }]
};

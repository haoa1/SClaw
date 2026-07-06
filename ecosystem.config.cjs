module.exports = {
  apps: [{
    name: 'sclaw',
    script: './backend/dist/index.js',
    cwd: '/root/sclaw',
    env: {
      GARUDA_TRADE_PORT: '16001'
    }
  }]
};

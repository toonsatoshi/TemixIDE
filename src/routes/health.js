const express = require('express');
const router = express.Router();
const os = require('os');
const config = require('../config');
const ton = require('../services/ton');
const logger = require('../services/logger');

router.get('/health', (req, res) => {
  logger.debug('Health check requested', req.requestId);
  res.json({
    status: 'Operational', version: '2.0.0', environment: config.ENV, network: config.NETWORK,
    uptime: process.uptime(), memory: process.memoryUsage(), hostname: os.hostname(),
    nodeVersion: process.version, walletReady: ton.isInitialized(), timestamp: new Date().toISOString()
  });
});

module.exports = router;

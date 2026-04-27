const express = require('express');
const router = express.Router();
const fs = require('fs');
const config = require('../config');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const logger = require('../services/logger');
const { requireInit } = require('../middleware');

router.get('/wallet/seed', requireInit, (req, res) => {
    if (!fs.existsSync(config.PATHS.WALLET_FILE)) return res.status(404).json({ error: 'No wallet file.' });
    try {
        const w = JSON.parse(fs.readFileSync(config.PATHS.WALLET_FILE, 'utf8'));
        res.json({ mnemonic: Array.isArray(w.mnemonic) ? w.mnemonic.join(' ') : w.mnemonic });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/wallet', requireInit, async (req, res) => {
  try {
    logger.debug('Fetching wallet balance...', req.requestId);
    const balance = await tonUtils.withRetry(async () => {
        const endpoint = await tonUtils.getEndpoint();
        const client = tonUtils.createTonClient(endpoint);
        return await client.getBalance(ton.getDevWallet().address);
    }, 10, req.requestId);
    
    logger.info(`Wallet balance: ${(Number(balance) / 1e9).toFixed(6)} TON`, req.requestId);
    res.json({
      address: ton.getDevWallet().address.toString({ testOnly: config.IS_TESTNET }),
      balance: (Number(balance) / 1e9).toFixed(6),
      network: config.NETWORK, walletVersion: 'V4R2'
    });
  } catch (e) {
    logger.error('Wallet Error', req.requestId, e);
    res.status(500).json({ error: 'Balance fetch failed: ' + e.message });
  }
});

router.delete('/wallet', requireInit, (req, res) => {
  try {
    logger.info('Wallet reset requested', req.requestId);
    if (!fs.existsSync(config.PATHS.WALLET_FILE)) return res.status(404).json({ error: 'No wallet file found.' });
    const backup = config.PATHS.WALLET_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(config.PATHS.WALLET_FILE, backup);
    fs.unlinkSync(config.PATHS.WALLET_FILE);
    logger.info(`Wallet cleared. Backup: ${backup}`, req.requestId);
    res.json({ success: true, message: 'Wallet cleared. Restart server to generate a new one.', backup });
  } catch (e) { 
    logger.error('Wallet Reset Error', req.requestId, e);
    res.status(500).json({ error: e.message }); 
  }
});

module.exports = router;

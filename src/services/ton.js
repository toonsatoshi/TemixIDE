const fs = require('fs');
const path = require('path');
const { WalletContractV4 } = require('@ton/ton');
const { mnemonicToPrivateKey, mnemonicNew } = require('@ton/crypto');
const config = require('../config');
const logger = require('./logger');
const { getEndpoint, createTonClient } = require('./ton-utils');

let devWallet = null;
let tonClient = null;
let walletKey = null;
let initialized = false;

async function init() {
  try {
    logger.info('Initializing TON connection...');
    
    let mnemonic;
    if (fs.existsSync(config.PATHS.WALLET_FILE)) {
      const w = JSON.parse(fs.readFileSync(config.PATHS.WALLET_FILE, 'utf8'));
      if (!w.mnemonic) throw new Error('Corrupted wallet file.');
      mnemonic = typeof w.mnemonic === 'string' ? w.mnemonic.split(' ') : w.mnemonic;
      logger.info('Existing development wallet loaded.');
    } else if (config.WALLET_MNEMONIC) {
      mnemonic = config.WALLET_MNEMONIC.split(' ');
      fs.writeFileSync(config.PATHS.WALLET_FILE, JSON.stringify({ mnemonic, created: new Date().toISOString(), source: 'env' }, null, 2));
      logger.info('Wallet initialized from WALLET_MNEMONIC environment variable.');
    } else {
      logger.info('Generating new development wallet...');
      mnemonic = await mnemonicNew();
      fs.writeFileSync(config.PATHS.WALLET_FILE, JSON.stringify({ mnemonic, created: new Date().toISOString() }, null, 2));
      logger.warn('NEW wallet generated — fund it via the faucet before deploying.');
    }
    
    walletKey = await mnemonicToPrivateKey(mnemonic);
    const endpoint = await getEndpoint();
    tonClient = createTonClient(endpoint);
    devWallet = WalletContractV4.create({ workchain: 0, publicKey: walletKey.publicKey });
    
    logger.info(`Wallet Address: ${devWallet.address.toString({ testOnly: config.IS_TESTNET })}`);
    
    initialized = true;
    return { devWallet, tonClient, walletKey };
  } catch (e) {
    logger.error('[FATAL] TON Initialization failed', '', e);
    throw e;
  }
}

module.exports = {
  init,
  getDevWallet: () => devWallet,
  getTonClient: () => tonClient,
  getWalletKey: () => walletKey,
  isInitialized: () => initialized
};

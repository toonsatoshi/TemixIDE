const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { Cell, contractAddress, beginCell, Address, internal } = require('@ton/ton');
const config = require('../config');
const state = require('../services/state');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const logger = require('../services/logger');
const { requireInit, heavyLimiter } = require('../middleware');

router.get('/abi', requireInit, (req, res) => {
  const { contractName } = req.query;
  if (!contractName) return res.status(400).json({ error: 'contractName is required.' });
  
  const buildDir = state.getSessionBuildDir();
  let baseName = contractName;
  let abiPath = path.join(buildDir, `${baseName}.abi`);
  
  if (!fs.existsSync(abiPath)) {
      const files = fs.readdirSync(buildDir);
      const match = files.find(f => f.endsWith(`_${baseName}.abi`) || f === `${baseName}.abi`);
      if (match) {
          baseName = match.replace('.abi', '');
          abiPath = path.join(buildDir, `${baseName}.abi`);
      }
  }

  if (!fs.existsSync(abiPath)) return res.status(404).json({ error: `ABI for "${contractName}" not found.` });
  
  try {
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    res.json(abi);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/contracts', requireInit, (req, res) => {
  const buildDir = state.getSessionBuildDir();
  if (!fs.existsSync(buildDir)) return res.json({ contracts: [] });
  try {
    const files = fs.readdirSync(buildDir);
    const contracts = files
      .filter(f => f.endsWith('.code.boc'))
      .map(f => f.replace('.code.boc', ''));
    res.json({ contracts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/deploy', heavyLimiter, requireInit, async (req, res) => {
  const id = req.requestId;
  const { contractName, args } = req.body;
  try {
    logger.info(`Deploying ${contractName || 'default'} to ${config.NETWORK} in session ${state.state.currentSession}...`, id);
    
    const buildDir = state.getSessionBuildDir();
    let baseName = contractName || 'Target_Target';
    let codePath = path.join(buildDir, `${baseName}.code.boc`);
    let dataPath = path.join(buildDir, `${baseName}.data.boc`);
    let abiPath = path.join(buildDir, `${baseName}.abi`);
    
    if (!fs.existsSync(codePath)) {
        const files = fs.readdirSync(buildDir);
        const match = files.find(f => f.endsWith(`_${baseName}.code.boc`) || f === `${baseName}.code.boc`);
        if (match) {
            baseName = match.replace('.code.boc', '');
            codePath = path.join(buildDir, `${baseName}.code.boc`);
            dataPath = path.join(buildDir, `${baseName}.data.boc`);
            abiPath = path.join(buildDir, `${baseName}.abi`);
        }
    }

    if (!fs.existsSync(codePath)) {
      throw new Error(`Artifacts for "${baseName}" not found. Compile first.`);
    }
    
    const codeCell = Cell.fromBoc(fs.readFileSync(codePath))[0];
    let dataCell;

    if (args && fs.existsSync(abiPath)) {
        try {
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            if (abi.init && abi.init.arguments) {
                const builder = beginCell();
                abi.init.arguments.forEach(f => tonUtils.packField(builder, f, args[f.name], abi));
                dataCell = builder.endCell();
                logger.info(`Data packed from init args for ${baseName}`, id);
            }
        } catch (e) {
            logger.warn(`Failed to pack init data from args: ${e.message}`, id);
        }
    }

    if (!dataCell) {
        if (fs.existsSync(dataPath)) {
          dataCell = Cell.fromBoc(fs.readFileSync(dataPath))[0];
          logger.debug(`Loaded data artifact from ${dataPath}`, id);
        } else {
          logger.warn(`Data artifact missing, using default 0-bit init data`, id);
          dataCell = beginCell().storeBit(0).endCell();
        }
    }

    const stateInit = { code: codeCell, data: dataCell };
    const address  = contractAddress(0, stateInit);
    const addrStr = address.toString({ testOnly: config.IS_TESTNET });
    
    const seqno = await tonUtils.withRetry(async () => {
      const endpoint = await tonUtils.getEndpoint();
      const activeClient = tonUtils.createTonClient(endpoint);
      const balance = await activeClient.getBalance(ton.getDevWallet().address);

      if (balance < 50000000n) { 
          throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON.`);
      }

      const contract = activeClient.open(ton.getDevWallet());
      let s = 0;
      try { s = await contract.getSeqno(); } catch (e) { s = 0; }

      await contract.sendTransfer({
        seqno: s, secretKey: ton.getWalletKey().secretKey,
        messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
      });
      return s;
    }, 10, id);

    state.getSession().deployed[baseName] = addrStr;
    const tx = { type: 'deploy', address: addrStr, ts: new Date().toISOString(), seqno };
    state.addHistory(tx);
    
    res.json({ address: addrStr, network: config.NETWORK, seqno });
  } catch (e) {
    logger.error(`Deploy failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/interact', heavyLimiter, requireInit, async (req, res) => {
  const { target, message, value, type, args, contractName } = req.body;
  if (!target || (!message && !type)) return res.status(400).json({ error: 'target and message (or type) are required.' });
  const sendValue = value || '0.02';
  const id = req.requestId;

  try {
    let body;
    if (type && contractName) {
      logger.info(`Encoding typed message ${type} for ${contractName} in session ${state.state.currentSession}`, id);
      const buildDir = state.getSessionBuildDir();
      const abiPath = path.join(buildDir, `${contractName}.abi`);
      if (!fs.existsSync(abiPath)) throw new Error(`ABI for ${contractName} not found in session.`);
      const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
      const typeDef = abi.types.find(t => t.name === type);
      if (!typeDef) throw new Error(`Type ${type} not found in ABI.`);
      
      const builder = beginCell();
      if (typeDef.header !== null) {
          builder.storeUint(typeDef.header, 32);
          logger.debug(`Message opcode: ${typeDef.header}`, id);
      }
      
      if (typeDef.fields && args) {
          typeDef.fields.forEach(f => {
              tonUtils.packField(builder, f, args[f.name], abi);
          });
      }
      body = builder.endCell();
    } else {
      logger.info(`Encoding text message: "${message}"`, id);
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }

    logger.info(`Sending transaction to ${target} (${sendValue} TON)...`, id);
    
    const seqno = await tonUtils.withRetry(async () => {
      const endpoint = await tonUtils.getEndpoint();
      const activeClient = tonUtils.createTonClient(endpoint);
      const balance = await activeClient.getBalance(ton.getDevWallet().address);
      if (balance < 25000000n) {
          throw new Error(`Insufficient funds on ${ton.getDevWallet().address.toString({ testOnly: config.IS_TESTNET })}`);
      }

      const contract = activeClient.open(ton.getDevWallet());
      let s = 0;
      try { 
          s = await contract.getSeqno(); 
      } catch (e) { 
          const msg = e.message || '';
          if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('429') || msg.includes('not found')) {
              throw e;
          }
          logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`, id); 
          s = 0;
      }

      await contract.sendTransfer({        seqno: s, secretKey: ton.getWalletKey().secretKey,
        messages: [internal({ to: target, value: sendValue, bounce: true, body })]
      });
      return s;
    }, 10, id);

    const tx = { type: 'interact', target, message: type || message, value: sendValue, ts: new Date().toISOString(), seqno };
    state.addHistory(tx);
    logger.info(`Interaction successful. Seqno: ${seqno}`, id);
    res.json({ success: true, seqno });
  } catch (e) {
    logger.error(`Interaction failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/getter', heavyLimiter, requireInit, async (req, res) => {
  const { target, method, args, contractName } = req.body;
  if (!target || !method) return res.status(400).json({ error: 'target and method are required.' });
  const id = req.requestId;
  try {
    logger.info(`Running getter ${method} on ${target}`, id);
    
    let stack = [];
    if (Array.isArray(args)) {
        stack = args.map(arg => {
            if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
            if (typeof arg === 'string') {
                const normalized = arg.trim().replace(/\+/g, '-').replace(/\//g, '_');
                try {
                    const parsedArg = Address.parseFriendly(normalized);
                    return { type: 'slice', cell: beginCell().storeAddress(parsedArg.address).endCell() };
                } catch (e) {
                    return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() };
                }
            }
            return arg;
        });
    }

    const result = await tonUtils.withRetry(async () => {
      const endpoint = await tonUtils.getEndpoint();
      const client = tonUtils.createTonClient(endpoint);
      const normalizedTarget = target.trim().replace(/\+/g, '-').replace(/\//g, '_');
      const parsedTarget = Address.parseFriendly(normalizedTarget);
      return await client.runMethod(parsedTarget.address, method, stack);
    }, 10, id);

    if (result.exitCode !== 0 && result.exitCode !== undefined) {
        let errorMsg = `Getter execution failed with exit code ${result.exitCode}`;
        if (result.exitCode === 9) errorMsg += " (Cell underflow/Storage layout mismatch - check if contract is initialized/deployed correctly)";
        throw new Error(errorMsg);
    }

    let returnTypes = [];
    if (contractName) {
        try {
            const buildDir = state.getSessionBuildDir();
            const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${contractName}.abi`), 'utf8'));
            const getterDef = abi.getters.find(g => g.name === method);
            if (getterDef && getterDef.returnType) {
                returnTypes = [getterDef.returnType.type];
            }
        } catch (e) { logger.debug(`Could not load ABI for return type decoding: ${e.message}`); }
    }

    const resultStack = result.stack.items.map((i, idx) => tonUtils.decodeStackItem(i, returnTypes[idx]));
    
    logger.info(`Getter ${method} success. Result stack length: ${resultStack.length}`, id);
    res.json({ success: true, stack: resultStack });
  } catch (e) {
    logger.error(`Getter failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/tx-history', requireInit, (req, res) => {
  logger.debug('Fetching transaction history', req.requestId);
  res.json({ history: state.getSession().txHistory || [] });
});

router.delete('/session', requireInit, (req, res) => {
  const session = state.getSession();
  session.deployed = {};
  session.txHistory = [];
  const buildDir = state.getSessionBuildDir();
  if (fs.existsSync(buildDir)) {
      try {
          fs.rmSync(buildDir, { recursive: true, force: true });
          fs.mkdirSync(buildDir, { recursive: true });
      } catch (e) { logger.error('Failed to clear build dir', '', e); }
  }
  state.saveState();
  res.json({ success: true });
});

router.get('/artifacts', requireInit, (req, res) => {
  const buildDir = state.getSessionBuildDir();
  if (!fs.existsSync(buildDir)) return res.json({ artifacts: [] });
  try {
    logger.debug('Listing artifacts', req.requestId);
    res.json({
      artifacts: fs.readdirSync(buildDir).map(f => {
        const s = fs.statSync(path.join(buildDir, f));
        return { name: f, size: s.size, modified: s.mtime };
      })
    });
  } catch (e) { 
    logger.error('Failed to list artifacts', req.requestId, e);
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/files', (req, res) => {
  try {
    const sessionPath = state.getSessionPath();
    logger.debug(`Listing source files in session ${state.state.currentSession}`, req.requestId);
    const files = fs.readdirSync(sessionPath).filter(f => f.endsWith('.tact'));
    res.json({ files });
  } catch (e) { 
    logger.error('Failed to list files', req.requestId, e);
    res.status(500).json({ error: e.message }); 
  }
});

router.get('/file', (req, res) => {
  const { name } = req.query;
  if (!name || !name.endsWith('.tact')) return res.status(400).json({ error: 'Invalid file name.' });
  const id = req.requestId;
  try {
    const sessionPath = state.getSessionPath();
    logger.info(`Reading source file ${name} from session ${state.state.currentSession}`, id);
    const filePath = path.resolve(sessionPath, String(name));
    if (!filePath.startsWith(sessionPath + path.sep)) {
      logger.warn(`Forbidden path access attempt: ${filePath}`, id);
      return res.status(403).json({ error: 'Forbidden file path.' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name, content });
  } catch (e) { 
    logger.error(`Failed to read file ${name}`, id, e);
    res.status(500).json({ error: e.message }); 
  }
});

module.exports = router;

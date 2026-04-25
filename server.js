'use strict';
// ═══════════════════════════════════════════════════════════════════════════
//  TEMIXIDE — Hardened Express API  v2.0
//  Rate-Limited · Compressed · WebSocket Live Logs · Request IDs ·
//  Graceful Shutdown · Audit Logging · TX History · Artifact Inspector
// ═══════════════════════════════════════════════════════════════════════════
const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const http         = require('http');
const os           = require('os');
const { execSync } = require('child_process');
const { TonClient, WalletContractV4, internal, Cell, contractAddress, beginCell, Address } = require('@ton/ton');
const { mnemonicNew, mnemonicToPrivateKey } = require('@ton/crypto');
const { getHttpEndpoint }    = require('@orbs-network/ton-access');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const compression  = require('compression');
const rateLimit    = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { WebSocketServer } = require('ws');
const TelegramBot = require('node-telegram-bot-api');

// ─── Config ──────────────────────────────────────────────────────────────
require('dotenv').config();
const PORT        = parseInt(process.env.TACT_PORT    || '3000', 10);
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID  = process.env.TELEGRAM_CHANNEL_ID ? String(process.env.TELEGRAM_CHANNEL_ID).trim() : '';
const ENV         = process.env.TACT_ENV     || 'development';
const NETWORK     = process.env.TACT_NETWORK || 'testnet';
const IS_TESTNET  = NETWORK === 'testnet';
const LOG_DIR     = path.resolve(__dirname, 'logs');
const WALLET_FILE = path.join(__dirname, 'dev-wallet.json');
const BUILD_DIR   = path.join(__dirname, 'build');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── App & WebSocket ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const wsBroadcast = (type, data) => {
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
};

const escapeMarkdownV2 = (str) => {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

const formatMarkdownV2Link = (label, url) => {
  // Escape only the label and keep markdown structure/URL intact for Telegram parser.
  return `[${escapeMarkdownV2(label)}](${encodeURI(url)})`;
};

let pollingBotInstance = null;
let broadcastBotInstance = null;

const broadcastToChannel = async (message) => {
  if (!BOT_TOKEN || !CHANNEL_ID) return;
  try {
    // Reuse one bot instance instead of creating a new connection per broadcast.
    const bot = pollingBotInstance || (broadcastBotInstance ||= new TelegramBot(BOT_TOKEN, { polling: false }));
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'MarkdownV2' });
  } catch (e) {
    console.error(`[Broadcast Error] ${e.message}`);
  }
};

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', data: 'Live log stream active.', ts: new Date().toISOString() }));
  ws.on('error', e => console.error('[WS Error]', e.message));
});

// ─── Middleware Stack ─────────────────────────────────────────────────────
app.use(compression());
app.use((req, res, next) => { req.requestId = uuidv4().slice(0, 8); res.setHeader('X-Request-ID', req.requestId); next(); });
app.use(express.json({ limit: '5mb' }));
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Request-ID'] }));
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled — required for Monaco Editor web workers
app.use(morgan('dev'));
app.use(morgan('combined', { stream: fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' }) }));
app.use(rateLimit({
  windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Retry after 60s.' },
  handler: (req, res, next, opts) => { wsBroadcast('warn', `Rate limit hit from ${req.ip}`); res.status(429).json(opts.message); }
}));
const heavyLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: 'Heavy endpoint: 10 req/min max.' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────
let devWallet = null, tonClient = null, walletKey = null, initialized = false;
const txHistory = [];
const MAX_TX    = 50;
const STATE_FILE = path.join(__dirname, 'state.json');
let compileQueue = Promise.resolve();

let state = {
  deployed: {}, // { contractName: address }
  lastFile: 'contract.tact',
  authorizedUsers: process.env.TELEGRAM_AUTHORIZED_ID ? process.env.TELEGRAM_AUTHORIZED_ID.split(',').map(id => id.trim()) : []
};

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) };
    } catch (e) { console.error('Failed to load state:', e.message); }
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { console.error('Failed to save state:', e.message); }
}
loadState();

async function withRetry(fn, retries = 10) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e.message || String(e);
      const isRetryable = msg.includes('502') || msg.includes('500') || msg.includes('429') || 
                          msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') ||
                          msg.toLowerCase().includes('timeout') || 
                          msg.includes('getseqno') || msg.includes('execution reversed');

      if (isRetryable) {
        const wait = (2000 * (i + 1)) + Math.random() * 1000; // Added jitter
        console.warn(`\x1b[33m[Retry ${i+1}/${retries}] RPC error: ${msg.slice(0,100)}. Retrying in ${Math.round(wait)}ms...\x1b[0m`);
        wsBroadcast('warn', `RPC Error: ${msg.slice(0,50)}. Retrying (${i+1}/${retries})...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
  throw lastErr;
}

function queueCompileTask(task) {
  // Serialize compiler access to prevent contract.tact race/corruption between concurrent requests.
  const run = compileQueue.then(task, task);
  compileQueue = run.catch(() => {});
  return run;
}

async function getEndpoint() {
  const isTestnet = NETWORK === 'testnet';
  const providers = [
    // TonCenter (Official)
    () => isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC',
    // TonHub (Reliable fallback)
    () => isTestnet ? 'https://testnet.tonhubapi.com/jsonRPC' : 'https://mainnet.tonhubapi.com/jsonRPC',
    // Orbs Access (Load balanced)
    async () => await getHttpEndpoint({ network: NETWORK }),
  ];
  
  // Randomize starting index to distribute load better
  const startIdx = Math.floor(Math.random() * providers.length);
  for (let i = 0; i < providers.length; i++) {
    try {
      const idx = (startIdx + i) % providers.length;
      const url = await providers[idx]();
      if (url) return url;
    } catch (e) {}
  }
  return isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
}

// ─── Initialization ──────────────────────────────────────────────────────
async function init() {
  try {
    if (!CHANNEL_ID) {
      console.warn('\x1b[33m[!] TELEGRAM_CHANNEL_ID not set — channel broadcast disabled.\x1b[0m');
    }
    let mnemonic;
    if (fs.existsSync(WALLET_FILE)) {
      const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
      if (!w.mnemonic || !Array.isArray(w.mnemonic)) throw new Error('Corrupted wallet file. Delete dev-wallet.json and restart.');
      mnemonic = w.mnemonic;
      console.log('\x1b[32m[+] Existing development wallet loaded.\x1b[0m');
    } else {
      mnemonic = await mnemonicNew();
      fs.writeFileSync(WALLET_FILE, JSON.stringify({ mnemonic, created: new Date().toISOString() }, null, 2));
      console.log('\x1b[33m[!] NEW wallet generated — fund it via the faucet before deploying.\x1b[0m');
    }
    walletKey   = await mnemonicToPrivateKey(mnemonic);
    const endpoint = await getEndpoint();
    tonClient   = new TonClient({ endpoint });
    devWallet   = WalletContractV4.create({ workchain: 0, publicKey: walletKey.publicKey });
    initialized = true;

    console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\n║   🚀  TEMIXIDE v2.0  —  SERVER ONLINE                      ║\n║      Rate-Limited · Compressed · WebSocket Live Logs        ║\n╚══════════════════════════════════════════════════════════════╝\x1b[0m');
    console.log(`\x1b[1mNetwork:\x1b[0m  \x1b[33m${NETWORK.toUpperCase()}\x1b[0m`);
    console.log(`\x1b[1mWallet:\x1b[0m   \x1b[35m${devWallet.address.toString({ testOnly: IS_TESTNET })}\x1b[0m`);
    console.log(`\x1b[1mEndpoint:\x1b[0m \x1b[34mhttp://localhost:${PORT}\x1b[0m`);
    console.log(`\x1b[1mEnv:\x1b[0m      \x1b[36m${ENV}\x1b[0m\n`);

    // Test broadcast
    broadcastToChannel(`🚀 *${escapeMarkdownV2('Temix IDE')}:* ${escapeMarkdownV2('Connection Live for Channel Broadcasting')}`);
  } catch (e) {
    console.error('\x1b[31m[FATAL] Initialization failed:\x1b[0m', e.message);
    process.exit(1);
  }
}

const requireInit = (req, res, next) =>
  initialized ? next() : res.status(503).json({ error: 'Server still initializing — retry shortly.' });

// ─── Routes ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({
  status: 'Operational', version: '2.0.0', environment: ENV, network: NETWORK,
  uptime: process.uptime(), memory: process.memoryUsage(), hostname: os.hostname(),
  nodeVersion: process.version, walletReady: initialized, timestamp: new Date().toISOString()
}));

app.get('/api/wallet', requireInit, async (req, res) => {
  try {
    const balance = await withRetry(async () => {
        const endpoint = await getEndpoint();
        const client = new TonClient({ endpoint });
        return await client.getBalance(devWallet.address);
    });
    res.json({
      address: devWallet.address.toString({ testOnly: IS_TESTNET }),
      balance: (Number(balance) / 1e9).toFixed(6),
      network: NETWORK, walletVersion: 'V4R2'
    });
  } catch (e) {
    console.error(`\x1b[31m[Wallet Error]\x1b[0m ${e.message}`);
    res.status(500).json({ error: 'Balance fetch failed: ' + e.message });
  }
});

app.delete('/api/wallet', requireInit, (req, res) => {
  try {
    if (!fs.existsSync(WALLET_FILE)) return res.status(404).json({ error: 'No wallet file found.' });
    const backup = WALLET_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(WALLET_FILE, backup);
    fs.unlinkSync(WALLET_FILE);
    res.json({ success: true, message: 'Wallet cleared. Restart server to generate a new one.', backup });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/compile', heavyLimiter, requireInit, (req, res) => {
  if (!req.body?.code) return res.status(400).json({ error: 'Source code payload is required.' });
  const { code } = req.body;
  if (code.length > 500000) return res.status(413).json({ error: 'Source exceeds 500 KB limit.' });
  const id = req.requestId;
  try {
    queueCompileTask(async () => {
      console.log(`\x1b[34m[${id}] Compiling Tact contract (${code.length} chars)...\x1b[0m`);
      wsBroadcast('log', `[${id}] Compilation started`);
      fs.writeFileSync('contract.tact', code, 'utf8');
      const t0  = Date.now();
      const out = execSync('npx tact --config tact.config.json 2>&1', { stdio: 'pipe', timeout: 60000 });
      const dur = Date.now() - t0;
      const log = out.toString();
      wsBroadcast('compile-success', `Compiled in ${dur}ms`);
      fs.appendFileSync(path.join(LOG_DIR, 'compile.log'), `[${new Date().toISOString()}] OK (${dur}ms)\n${log}\n---\n`);
      console.log(`\x1b[32m[${id}] Compilation OK in ${dur}ms\x1b[0m`);
      res.json({ success: true, duration: dur, log, artifacts: fs.existsSync(BUILD_DIR) ? fs.readdirSync(BUILD_DIR) : [] });
    }).catch((e) => {
      const errLog = e.stdout ? e.stdout.toString() : e.message;
      wsBroadcast('compile-error', errLog);
      fs.appendFileSync(path.join(LOG_DIR, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
      console.error(`\x1b[31m[${id}] Compile FAILED\x1b[0m`);
      res.status(400).json({ error: errLog });
    });
  } catch (e) {
    const errLog = e.stdout ? e.stdout.toString() : e.message;
    wsBroadcast('compile-error', errLog);
    fs.appendFileSync(path.join(LOG_DIR, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
    console.error(`\x1b[31m[${id}] Compile FAILED\x1b[0m`);
    res.status(400).json({ error: errLog });
  }
});

app.get('/api/abi', requireInit, (req, res) => {
  const { contractName } = req.query;
  if (!contractName) return res.status(400).json({ error: 'contractName is required.' });
  
  let baseName = contractName;
  let abiPath = path.join(BUILD_DIR, `${baseName}.abi`);
  
  // Fallback if the user provided just the contract name without project prefix
  if (!fs.existsSync(abiPath)) {
      const files = fs.readdirSync(BUILD_DIR);
      const match = files.find(f => f.endsWith(`_${baseName}.abi`) || f === `${baseName}.abi`);
      if (match) {
          baseName = match.replace('.abi', '');
          abiPath = path.join(BUILD_DIR, `${baseName}.abi`);
      }
  }

  if (!fs.existsSync(abiPath)) return res.status(404).json({ error: `ABI for "${contractName}" not found.` });
  
  try {
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    res.json(abi);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/contracts', requireInit, (req, res) => {
  if (!fs.existsSync(BUILD_DIR)) return res.json({ contracts: [] });
  try {
    const files = fs.readdirSync(BUILD_DIR);
    // Tact typically names BOCs as [Project]_[Contract].code.boc
    // We'll extract the [Contract] part.
    const contracts = files
      .filter(f => f.endsWith('.code.boc'))
      .map(f => f.replace('.code.boc', ''));
    res.json({ contracts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/deploy', heavyLimiter, requireInit, async (req, res) => {
  const id = req.requestId;
  const { contractName } = req.body;
  try {
    console.log(`\x1b[34m[${id}] Deploying ${contractName || 'default'} to ${NETWORK}...\x1b[0m`);
    wsBroadcast('log', `[${id}] Deploy sequence started for ${contractName || 'default'}`);
    
    let baseName = contractName || 'Target_Target';
    let codePath = path.join(BUILD_DIR, `${baseName}.code.boc`);
    let dataPath = path.join(BUILD_DIR, `${baseName}.data.boc`);
    
    // Fallback if the user provided just the contract name without project prefix
    if (!fs.existsSync(codePath)) {
        const files = fs.readdirSync(BUILD_DIR);
        const match = files.find(f => f.endsWith(`_${baseName}.code.boc`) || f === `${baseName}.code.boc`);
        if (match) {
            baseName = match.replace('.code.boc', '');
            codePath = path.join(BUILD_DIR, `${baseName}.code.boc`);
            dataPath = path.join(BUILD_DIR, `${baseName}.data.boc`);
        }
    }

    if (!fs.existsSync(codePath)) throw new Error(`Artifacts for "${baseName}" not found. Compile first.`);
    
    const codeCell = Cell.fromBoc(fs.readFileSync(codePath))[0];
    let dataCell;

    if (fs.existsSync(dataPath)) {
      dataCell = Cell.fromBoc(fs.readFileSync(dataPath))[0];
    } else {
      console.warn(`\x1b[33m[${id}] Data artifact missing, using default 0-bit init data\x1b[0m`);
      dataCell = beginCell().storeBit(0).endCell();
    }

    const stateInit = { code: codeCell, data: dataCell };
    const address  = contractAddress(0, stateInit);
    
    const seqno = await withRetry(async () => {
      // Refresh client to avoid stale 502 endpoints
      const endpoint = await getEndpoint();
      const activeClient = new TonClient({ endpoint });
      
      const balance = await activeClient.getBalance(devWallet.address);
      if (balance < 50000000n) { // 0.05 TON
          const addr = devWallet.address.toString({ testOnly: IS_TESTNET });
          throw new Error(`Insufficient funds on ${addr} (${(Number(balance)/1e9).toFixed(3)} TON). Please fund your wallet via the faucet.`);
      }

      const contract = activeClient.open(devWallet);
      let s = 0;
      try {
        s = await contract.getSeqno();
      } catch (e) {
        console.warn(`\x1b[33m[${id}] Wallet seqno fetch failed, using 0: ${e.message}\x1b[0m`);
      }

      await contract.sendTransfer({
        seqno: s, secretKey: walletKey.secretKey,
        messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
      });
      return s;
    });

    const addrStr = address.toString({ testOnly: IS_TESTNET });
    const tx = { type: 'deploy', address: addrStr, ts: new Date().toISOString(), seqno };
    txHistory.unshift(tx); if (txHistory.length > MAX_TX) txHistory.pop();
    wsBroadcast('deploy-success', addrStr);
    console.log(`\x1b[32m[${id}] Deployed: ${addrStr}\x1b[0m`);
    
    const explorerUrl = `https://${IS_TESTNET ? 'testnet.' : ''}tonviewer.com/${addrStr}`;
    
    // Async broadcast (don't await to avoid blocking response)
    const broadcastMsg = 
        `📦 *Contract:* \`${escapeMarkdownV2(baseName)}\`\n` +
        `⛓️ *Network:* ${escapeMarkdownV2(NETWORK.toUpperCase())}\n` +
        `📍 *Address:* \`${escapeMarkdownV2(addrStr)}\`\n` +
        `🔗 ${formatMarkdownV2Link('View on Explorer', explorerUrl)}`;
    broadcastToChannel(broadcastMsg);

    res.json({ address: addrStr, network: NETWORK, seqno, explorerUrl });

  } catch (e) {
    wsBroadcast('deploy-error', e.message);
    console.error(`\x1b[31m[${id}] Deploy failed: ${e.message}\x1b[0m`);
    res.status(500).json({ error: e.message });
  }
});

function packField(builder, field, value) {
  const type = field.type;
  if (type.kind !== 'simple') throw new Error(`Unsupported field kind: ${type.kind}`);
  
  const format = field.type.format;
  const typeName = field.type.type;

  switch (typeName) {
    case 'int':
    case 'uint': {
      const bits = typeof format === 'number' ? format : (format === 'coins' ? 124 : 257);
      if (format === 'coins') {
          builder.storeCoins(BigInt(value));
      } else {
          if (typeName === 'uint') builder.storeUint(BigInt(value), bits);
          else builder.storeInt(BigInt(value), bits);
      }
      break;
    }
    case 'address': {
      builder.storeAddress(Address.parse(value));
      break;
    }
    case 'bool': {
      builder.storeBit(value === true || value === 'true' || value === '1');
      break;
    }
    case 'slice':
    case 'cell': {
      // Basic support: assume hex string if it looks like one, or empty
      if (!value) {
          if (typeName === 'cell') builder.storeRef(beginCell().endCell());
      } else {
          const cell = Cell.fromBoc(Buffer.from(value, 'hex'))[0];
          if (typeName === 'cell') builder.storeRef(cell);
          else builder.storeSlice(cell.beginParse());
      }
      break;
    }
    default:
      throw new Error(`Unsupported type: ${typeName}`);
  }
}

app.post('/api/interact', heavyLimiter, requireInit, async (req, res) => {
  const { target, message, value, type, args, contractName } = req.body;
  if (!target || (!message && !type)) return res.status(400).json({ error: 'target and message (or type) are required.' });
  const sendValue = value || '0.02';
  const id = req.requestId;

  try {
    let body;
    if (type && contractName) {
      // Typed message encoding
      const abiPath = path.join(BUILD_DIR, `${contractName}.abi`);
      if (!fs.existsSync(abiPath)) throw new Error(`ABI for ${contractName} not found.`);
      const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
      const typeDef = abi.types.find(t => t.name === type);
      if (!typeDef) throw new Error(`Type ${type} not found in ABI.`);
      
      const builder = beginCell();
      if (typeDef.header !== null) {
          builder.storeUint(typeDef.header, 32);
      }
      
      if (typeDef.fields && args) {
          typeDef.fields.forEach(f => {
              packField(builder, f, args[f.name]);
          });
      }
      body = builder.endCell();
      console.log(`[${id}] Encoded typed message ${type} (opcode: ${typeDef.header})`);
    } else {
      // Fallback to text message
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }

    console.log(`[${id}] Sending ${type || '"' + message + '"'} to ${target} (${sendValue} TON)...\x1b[0m`);
    wsBroadcast('log', `[${id}] Sending ${type || message} to ${target}`);
    
    const seqno = await withRetry(async () => {
      const endpoint = await getEndpoint();
      const activeClient = new TonClient({ endpoint });
      const balance = await activeClient.getBalance(devWallet.address);
      if (balance < 25000000n) {
          throw new Error(`Insufficient funds on ${devWallet.address.toString({ testOnly: IS_TESTNET })}`);
      }

      const contract = activeClient.open(devWallet);
      let s = 0;
      try { s = await contract.getSeqno(); } catch (e) {}
      
      await contract.sendTransfer({
        seqno: s, secretKey: walletKey.secretKey,
        messages: [internal({ to: target, value: sendValue, bounce: true, body })]
      });
      return s;
    });

    const tx = { type: 'interact', target, message: type || message, value: sendValue, ts: new Date().toISOString(), seqno };
    txHistory.unshift(tx); if (txHistory.length > MAX_TX) txHistory.pop();
    wsBroadcast('interact-success', `${type || '"' + message + '"'} sent to ${target}`);
    res.json({ success: true, seqno });
  } catch (e) {
    wsBroadcast('interact-error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/getter', heavyLimiter, requireInit, async (req, res) => {
  const { target, method, args } = req.body;
  if (!target || !method) return res.status(400).json({ error: 'target and method are required.' });
  try {
    const endpoint = await getEndpoint();
    const client = new TonClient({ endpoint });
    
    // Prepare stack if args are provided
    let stack = [];
    if (Array.isArray(args)) {
        stack = args.map(arg => {
            if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
            if (typeof arg === 'string') {
                try {
                    return { type: 'slice', cell: beginCell().storeAddress(Address.parse(arg)).endCell() };
                } catch (e) {
                    return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() };
                }
            }
            return arg;
        });
    }

    const result = await withRetry(async () => {
      const endpoint = await getEndpoint();
      const client = new TonClient({ endpoint });
      return await client.runMethod(Address.parse(target), method, stack);
    });
    const resultStack = result.stack.items.map(i => {
      if (i.type === 'int') return i.value.toString();
      if (i.type === 'cell') return '[Cell]';
      if (i.type === 'slice') return '[Slice]';
      return i.value;
    });
    res.json({ success: true, stack: resultStack });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tx-history', requireInit, (req, res) => res.json({ history: txHistory }));

app.get('/api/artifacts', requireInit, (req, res) => {
  if (!fs.existsSync(BUILD_DIR)) return res.json({ artifacts: [] });
  try {
    res.json({
      artifacts: fs.readdirSync(BUILD_DIR).map(f => {
        const s = fs.statSync(path.join(BUILD_DIR, f));
        return { name: f, size: s.size, modified: s.mtime };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.tact'));
    res.json({ files });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/file', (req, res) => {
  const { name } = req.query;
  if (!name || !name.endsWith('.tact')) return res.status(400).json({ error: 'Invalid file name.' });
  try {
    const filePath = path.resolve(__dirname, String(name));
    // Prevent path traversal outside repository root.
    if (!filePath.startsWith(__dirname + path.sep)) {
      return res.status(403).json({ error: 'Forbidden file path.' });
    }
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
    const content = fs.readFileSync(filePath, 'utf8');
    res.json({ name, content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── 404 & Global Error Handler ───────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found.` }));
app.use((err, req, res, _next) => {
  console.error('\x1b[31m[UNHANDLED]\x1b[0m', err);
  res.status(500).json({ error: 'Internal server error.', requestId: req.requestId });
});

// ─── Boot & Graceful Shutdown ─────────────────────────────────────────────
init().then(() => {
  server.listen(PORT);
  
  // ─── Telegram Bot Integration ──────────────────────────────────────────
  if (BOT_TOKEN) {
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    pollingBotInstance = bot;
    console.log('\x1b[32m[+] Telegram Bot (TemixIDE) active.\x1b[0m');

    const isAuthorized = (msg) => {
      if (state.authorizedUsers.length === 0) return true;
      return state.authorizedUsers.includes(String(msg.from.id));
    };

    const getMainMenu = () => ({
      reply_markup: {
        keyboard: [
          [{ text: '📂 Forge' }, { text: '📂 Contract' }],
          [{ text: '📂 Workspace' }, { text: '📂 Account' }]
        ],
        resize_keyboard: true,
        is_persistent: true
      },
      parse_mode: 'HTML'
    });

    const userState = {}; // { chatId: { action, ..., updatedAt } }
    const USER_STATE_TTL_MS = 5 * 60 * 1000;

    const setUserState = (chatId, data) => {
      userState[chatId] = { ...data, updatedAt: Date.now() };
    };
    const clearUserState = (chatId) => {
      delete userState[chatId];
    };
    const getUserState = (chatId) => {
      const entry = userState[chatId];
      if (!entry) return null;
      if ((Date.now() - entry.updatedAt) > USER_STATE_TTL_MS) {
        clearUserState(chatId);
        return null;
      }
      return entry;
    };

    const userStateSweeper = setInterval(() => {
      const now = Date.now();
      for (const [chatId, entry] of Object.entries(userState)) {
        if ((now - entry.updatedAt) > USER_STATE_TTL_MS) {
          delete userState[chatId];
        }
      }
    }, 60_000);
    userStateSweeper.unref();

    bot.onText(/\/start|\/menu/, (msg) => {
      if (!isAuthorized(msg)) return bot.sendMessage(msg.chat.id, "🚫 Unauthorized.");
      
      const welcome = `
🚀 <b>Welcome to TemixIDE v2.0</b>
The professional IDE for TON, now in your pocket.

<b>Quick Start Guide:</b>
1. 📂 <b>Forge:</b> Compile your .tact files and manage artifacts.
2. 📂 <b>Contract:</b> Deploy and interact with live contracts.
3. 📂 <b>Workspace:</b> Manage your files and project history.
4. 📂 <b>Account:</b> Check your wallet balance and credentials.

<i>Tip: You can send any .tact file to this bot to add it to your project instantly.</i>
      `;
      bot.sendMessage(msg.chat.id, welcome, { ...getMainMenu(), parse_mode: 'HTML' });
    });

    const handleMenuAction = async (chatId, data, msgOrQuery) => {
      const isQuery = !!msgOrQuery.id;
      const messageId = isQuery ? msgOrQuery.message.message_id : null;

      const sendOrEdit = async (text, options) => {
        if (isQuery && messageId) {
          try {
            return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
          } catch (e) {
            // If edit fails (e.g. message same), just send new
            return await bot.sendMessage(chatId, text, options);
          }
        }
        return await bot.sendMessage(chatId, text, options);
      };

      try {
        if (data === 'forge_menu') {
          const text = `📂 <b>Forge</b>\nFocuses on the creation and "building" phase of your project.\n\n🔨 <b>Compile:</b> The primary engine for building your code.\n📦 <b>Artifacts:</b> Where your compiled BOC (Bag of Cells) and ABI files live.\n📜 <b>Logs:</b> Essential for debugging compilation errors or build outputs.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔨 Compile', callback_data: 'compile_menu' }],
                [{ text: '📦 Artifacts', callback_data: 'artifacts_menu' }],
                [{ text: '📜 Logs', callback_data: 'logs_menu' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'contract_menu') {
          const text = `📂 <b>Contract</b>\nFocuses on the live lifecycle and communication with the blockchain.\n\n🚀 <b>Deploy:</b> Moving the code from your pocket to the network.\n🎮 <b>Interact:</b> Sending external messages or transactions to a live contract.\n🔍 <b>Getters:</b> Running "read-only" methods to check the contract state.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🚀 Deploy', callback_data: 'deploy_menu' }],
                [{ text: '🎮 Interact', callback_data: 'interact_menu' }],
                [{ text: '🔍 Getters', callback_data: 'getters_menu' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'workspace_menu') {
          const text = `📂 <b>Workspace</b>\nFocuses on your local environment and project history.\n\n📁 <b>Files:</b> Your central hub for managing .tact source files.\n📋 <b>History:</b> Tracking your previous deployments and interactions.\n⚙️ <b>Help:</b> Documentation and guides to help you navigate the IDE.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📁 Files', callback_data: 'files_list' }],
                [{ text: '📋 History', callback_data: 'history' }],
                [{ text: '⚙️ Help', callback_data: 'help' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'account_menu') {
          const text = `📂 <b>Account</b>\nFocuses on the developer's credentials and resources.\n\n💳 <b>Wallet:</b> Managing your balance, address, and faucet access.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '💳 Wallet', callback_data: 'wallet' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'wallet') {
          const balance = await withRetry(async () => {
              const endpoint = await getEndpoint();
              const client = new TonClient({ endpoint });
              return await client.getBalance(devWallet.address);
          });
          const addr = devWallet.address.toString({ testOnly: IS_TESTNET });
          const text = `💳 *Wallet Status*\n\n*Address:* \`${addr}\`\n*Balance:* \`${(Number(balance) / 1e9).toFixed(4)} TON\`\n*Network:* ${NETWORK.toUpperCase()}`;
          await sendOrEdit(text, { 
            reply_markup: {
              inline_keyboard: [
                [{ text: '🗑 Reset Wallet', callback_data: 'confirm_reset' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown' 
          });
        }
        
        else if (data === 'confirm_reset') {
          await sendOrEdit("⚠️ *Are you sure?*\nThis will backup and delete your current wallet. The server will need a restart.", {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Yes, Reset', callback_data: 'do_reset' }],
                [{ text: '❌ Cancel', callback_data: 'wallet' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'do_reset') {
          try {
            if (!fs.existsSync(WALLET_FILE)) throw new Error('No wallet file.');
            const backup = WALLET_FILE.replace('.json', `.backup-${Date.now()}.json`);
            fs.copyFileSync(WALLET_FILE, backup);
            fs.unlinkSync(WALLET_FILE);
            await sendOrEdit(`✅ *Wallet reset successfully.*\nBackup created: \`${path.basename(backup)}\`\n\n*Please restart the server process manually.*`, { parse_mode: 'Markdown' });
          } catch (e) { bot.sendMessage(chatId, "❌ Reset failed: " + e.message); }
        }

        else if (data === 'compile_menu') {
          const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.tact'));
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No .tact files found.");
          
          await sendOrEdit("🔨 <b>Select file to compile:</b>", {
            reply_markup: {
              inline_keyboard: [
                ...files.map(f => [{ text: `📄 ${f}`, callback_data: `do_compile:${f}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'deploy_menu') {
          if (!fs.existsSync(BUILD_DIR)) return bot.sendMessage(chatId, "❌ No builds found. Compile first.");
          const files = fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.code.boc'));
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No compiled artifacts found.");

          await sendOrEdit("🚀 <b>Select contract to deploy:</b>", {
            reply_markup: {
              inline_keyboard: [
                ...files.map(f => {
                  const name = f.replace('.code.boc', '');
                  return [{ text: `📦 ${name}`, callback_data: `do_deploy:${name}` }];
                }),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'interact_menu') {
          const contracts = Object.keys(state.deployed);

          await sendOrEdit("🎮 <b>Select contract to interact with:</b>", {
            reply_markup: {
              inline_keyboard: [
                ...contracts.map(c => [{ text: `🕹 ${c}`, callback_data: `int_methods:${c}` }]),
                [{ text: '🎯 Manual Address', callback_data: 'prep_manual_int' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'prep_manual_int') {
          setUserState(chatId, { action: 'awaiting_manual_target' });
          await bot.sendMessage(chatId, "🎯 <b>Enter target contract address:</b>", { parse_mode: 'HTML' });
        }

        else if (data === 'health_check') {
          const health = {
            status: 'Operational', version: '2.0.0', uptime: Math.floor(process.uptime()) + 's',
            memory: (process.memoryUsage().rss / 1024 / 1024).toFixed(2) + ' MB',
            network: NETWORK, wallet: devWallet.address.toString({ testOnly: IS_TESTNET })
          };
          await bot.sendMessage(chatId, `🏥 <b>System Health</b>\n\n<pre>${JSON.stringify(health, null, 2)}</pre>`, { parse_mode: 'HTML' });
        }

        else if (data === 'getters_menu') {
          const contracts = Object.keys(state.deployed);
          if (contracts.length === 0) return bot.sendMessage(chatId, "❌ No deployed contracts. Deploy one first!");

          await sendOrEdit("🔍 *Select contract to query:*", {
            reply_markup: {
              inline_keyboard: [
                ...contracts.map(c => [{ text: `📜 ${c}`, callback_data: `get_methods:${c}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'files_list') {
          const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.tact'));
          await sendOrEdit(`📁 *Project Files:* (Total: ${files.length})`, {
            reply_markup: { 
              inline_keyboard: [
                ...files.map(f => [{ text: `📄 ${f}`, callback_data: `view_file:${f}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ] 
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'logs_menu') {
          await sendOrEdit("📜 *Select log to view:*", {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔨 Compiler Logs', callback_data: 'view_log:compile.log' }],
                [{ text: '🌐 Access Logs', callback_data: 'view_log:access.log' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'artifacts_menu') {
          if (!fs.existsSync(BUILD_DIR)) return bot.sendMessage(chatId, "❌ No build directory found.");
          const files = fs.readdirSync(BUILD_DIR);
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No artifacts found.");
          
          await sendOrEdit("📦 *Build Artifacts:*", {
            reply_markup: {
              inline_keyboard: [
                ...files.slice(0, 10).map(f => [{ text: `📄 ${f}`, callback_data: `view_art:${f}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'history') {
          const text = txHistory.length > 0 
            ? `📋 *Recent Transactions:*\n\n${txHistory.slice(0, 10).map(t => `• *\`${t.type}\`* \`${t.target || t.address}\` \n  _${new Date(t.ts).toLocaleTimeString()}_`).join('\n\n')}`
            : "📋 No transactions in history.";
          
          await sendOrEdit(text, {
            reply_markup: { 
              inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'menu' }]] 
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'menu') {
          const text = `🚀 <b>TemixIDE v2.0</b>\nMain Menu - Select a category:`;
          await sendOrEdit(text, {
            reply_markup: { 
              inline_keyboard: [
                [{ text: '📂 Forge', callback_data: 'forge_menu' }, { text: '📂 Contract', callback_data: 'contract_menu' }],
                [{ text: '📂 Workspace', callback_data: 'workspace_menu' }, { text: '📂 Account', callback_data: 'account_menu' }],
                [{ text: '🏥 System Health', callback_data: 'health_check' }]
              ] 
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'help') {
          const helpText = `
📖 <b>Detailed Instructions</b>

<b>📂 Forge</b>
• Send \`.tact\` files to this chat to upload them.
• Use <b>Compile</b> to build your project and generate artifacts.
• Check <b>Logs</b> if compilation fails.

<b>📂 Contract</b>
• Use <b>Deploy</b> to move your code to the blockchain.
• <b>Interact</b> with your contracts by sending messages.
• Use <b>Getters</b> to read contract state.

<b>📂 Workspace</b>
• Manage your <b>Files</b> and view <b>History</b> of actions.

<b>📂 Account</b>
• Check your <b>Wallet</b> balance and address.
          `;
          await sendOrEdit(helpText, {
            reply_markup: { 
              inline_keyboard: [
                [{ text: '🏥 System Health', callback_data: 'health_check' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ] 
            },
            parse_mode: 'HTML'
          });
        }
        
      } catch (e) {
        console.error('[Menu Action Error]', e);
        if (isQuery) bot.answerCallbackQuery(msgOrQuery.id, { text: "Error: " + e.message, show_alert: true });
        else bot.sendMessage(chatId, "❌ Error: " + e.message);
      }
    };

    bot.on('callback_query', async (query) => {
      if (!isAuthorized(query)) return bot.answerCallbackQuery(query.id, { text: "Unauthorized", show_alert: true });
      
      const chatId = query.message.chat.id;
      const data = query.data;

      // Answer immediately to avoid "query is too old" error during long RPC retries
      bot.answerCallbackQuery(query.id).catch(() => {});

      try {
        // Handle simple menu navigation first
        const simpleActions = ['forge_menu', 'contract_menu', 'workspace_menu', 'account_menu', 'wallet', 'confirm_reset', 'do_reset', 'compile_menu', 'deploy_menu', 'interact_menu', 'prep_manual_int', 'health_check', 'getters_menu', 'files_list', 'logs_menu', 'artifacts_menu', 'history', 'help', 'menu'];
        if (simpleActions.includes(data)) {
            return handleMenuAction(chatId, data, query);
        }

        if (data.startsWith('do_compile:')) {
          const fileName = data.split(':')[1];
          bot.sendMessage(chatId, `🔨 <b>Compiling ${fileName}...</b>`, { parse_mode: 'HTML' });
          queueCompileTask(async () => {
            fs.writeFileSync('contract.tact', fs.readFileSync(path.join(__dirname, fileName))); // guarded by queueCompileTask
            state.lastFile = fileName; saveState();
            const t0 = Date.now();
            execSync('npx tact --config tact.config.json 2>&1', { stdio: 'pipe', timeout: 60000 });
            const dur = Date.now() - t0;
            const artifacts = fs.existsSync(BUILD_DIR) ? fs.readdirSync(BUILD_DIR).filter(f => f.endsWith('.code.boc')) : [];
            bot.sendMessage(chatId, `✅ <b>Compiled ${fileName} in ${dur}ms</b>\n\n<b>Artifacts:</b> ${artifacts.map(a => `<code>${a.replace('.code.boc','')}</code>`).join(', ')}`, { parse_mode: 'HTML' });
          }).catch((e) => {
            const err = e.stdout ? e.stdout.toString() : e.message;
            bot.sendMessage(chatId, `❌ <b>Compilation Failed</b>\n\n<pre>${err.slice(0, 3000)}</pre>`, { parse_mode: 'HTML' });
          });
        }

        else if (data.startsWith('do_deploy:')) {
          const name = data.split(':')[1];
          bot.sendMessage(chatId, `🚀 <b>Deploying ${name}...</b>`, { parse_mode: 'HTML' });
          try {
            const codeCell = Cell.fromBoc(fs.readFileSync(path.join(BUILD_DIR, `${name}.code.boc`)))[0];
            const dataPath = path.join(BUILD_DIR, `${name}.data.boc`);
            const dataCell = fs.existsSync(dataPath) ? Cell.fromBoc(fs.readFileSync(dataPath))[0] : beginCell().storeBit(0).endCell();
            const stateInit = { code: codeCell, data: dataCell };
            const address = contractAddress(0, stateInit);
            
            const seqno = await withRetry(async () => {
              const endpoint = await getEndpoint();
              const activeClient = new TonClient({ endpoint });
              const contract = activeClient.open(devWallet);
              let s = 0; try { s = await contract.getSeqno(); } catch (e) {}
              await contract.sendTransfer({
                seqno: s, secretKey: walletKey.secretKey,
                messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
              });
              return s;
            });

            const addrStr = address.toString({ testOnly: IS_TESTNET });
            state.deployed[name] = addrStr; saveState();
            
            bot.sendMessage(chatId, `🎉 <b>Contract Deployed!</b>\n\n<b>Name:</b> <code>${name}</code>\n<b>Address:</b> <code>${addrStr}</code>\n<a href="https://${IS_TESTNET?'testnet.':''}tonscan.org/address/${addrStr}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
          } catch (e) {
            bot.sendMessage(chatId, "❌ <b>Deployment Failed</b>\n\n" + e.message);
          }
        }

        else if (data.startsWith('int_methods:')) {
          const name = data.split(':')[1];
          const abiPath = path.join(BUILD_DIR, `${name}.abi`);
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, "❌ ABI not found for " + name);
          
          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const receivers = abi.receivers || [];
          
          bot.editMessageText(`🎮 <b>Actions for ${name}:</b>\nAddress: <code>${state.deployed[name]}</code>`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [
                ...receivers.filter(r => r.receiver === 'external' || r.receiver === 'internal').map(r => {
                    const label = r.message.type === 'text' ? `"${r.message.text}"` : r.message.type;
                    return [{ text: `✉️ ${label}`, callback_data: `prep_int:${name}:${r.message.type}:${r.message.text || ''}` }];
                }),
                [{ text: '⬅️ Back', callback_data: 'interact_menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data.startsWith('prep_int:')) {
          const [, name, type, text] = data.split(':');
          const addr = state.deployed[name];
          
          if (type === 'text') {
              // Immediate action for text messages
              bot.sendMessage(chatId, `Sending "${text}" to ${name}...`);
              try {
                  const body = beginCell().storeUint(0, 32).storeStringTail(text).endCell();
                  const seqno = await withRetry(async () => {
                      const endpoint = await getEndpoint();
                      const activeClient = new TonClient({ endpoint });
                      const contract = activeClient.open(devWallet);
                      let s = 0; try { s = await contract.getSeqno(); } catch (e) {}
                      await contract.sendTransfer({
                          seqno: s, secretKey: walletKey.secretKey,
                          messages: [internal({ to: Address.parse(addr), value: '0.05', bounce: true, body })]
                      });
                      return s;
                  });
                  bot.sendMessage(chatId, `✅ *Transaction Sent!*\nSeqno: \`${seqno}\``, { parse_mode: 'Markdown' });
              } catch (e) { bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); }
          } else {
              // Typed message - check if it has fields
              const abi = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, `${name}.abi`), 'utf8'));
              const typeDef = abi.types.find(t => t.name === type);
              if (typeDef && typeDef.fields && typeDef.fields.length > 0) {
                  setUserState(chatId, { action: 'awaiting_args', target: addr, type, contractName: name });
                  const fields = typeDef.fields.map(f => `\`${f.name}\` (${f.type.type})`).join('\n');
                  const jsonExample = `{\n  ${typeDef.fields.map(f => `"${f.name}": ...`).join(',\n  ')}\n}`;
                  const cmdExample = `/send_${type} {\n  ${typeDef.fields.map(f => `"${f.name}": 0`).join(',\n  ')}\n}`;
                  
                  bot.sendMessage(chatId, `*Temix IDE:*\n📝 *Enter arguments for* \`${type}\`\n\nFormat as JSON OR use command:\n\`\`\`\n${cmdExample}\n\`\`\`\n\n*Required Fields:*\n${fields}`, { parse_mode: 'Markdown' });
              } else {
                  // No fields, send immediately
                  bot.sendMessage(chatId, `Sending ${type} to ${name}...`);
                  try {
                      const builder = beginCell();
                      if (typeDef && typeDef.header !== null) builder.storeUint(typeDef.header, 32);
                      const body = builder.endCell();
                      const seqno = await withRetry(async () => {
                          const endpoint = await getEndpoint();
                          const client = new TonClient({ endpoint });
                          const contract = client.open(devWallet);
                          let s = 0; try { s = await contract.getSeqno(); } catch (e) {}
                          await contract.sendTransfer({
                              seqno: s, secretKey: walletKey.secretKey,
                              messages: [internal({ to: Address.parse(addr), value: '0.05', bounce: true, body })]
                          });
                          return s;
                      });
                      bot.sendMessage(chatId, `✅ *Transaction Sent!*\nSeqno: \`${seqno}\``, { parse_mode: 'Markdown' });
                  } catch (e) { bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); }
              }
          }
        }

        else if (data.startsWith('get_methods:')) {
          const name = data.split(':')[1];
          const abiPath = path.join(BUILD_DIR, `${name}.abi`);
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, "❌ ABI not found for " + name);
          
          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const getters = abi.getters || [];
          
          bot.editMessageText(`🔍 *Getters for* \`${name}\`*:*\nAddress: \`${state.deployed[name]}\``, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [
                ...getters.map(g => [{ text: `${g.name}()`, callback_data: `call_get:${name}:${g.name}` }]),
                [{ text: '⬅️ Back', callback_data: 'getters_menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data.startsWith('call_get:')) {
          const [, name, method] = data.split(':');
          const addr = state.deployed[name];
          const abi = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, `${name}.abi`), 'utf8'));
          const getterDef = abi.getters.find(g => g.name === method);
          
          if (getterDef && getterDef.arguments && getterDef.arguments.length > 0) {
              setUserState(chatId, { action: 'awaiting_getter_args', target: addr, method, contractName: name });
              const args = getterDef.arguments.map(a => `\`${a.name}\` (${a.type.type})`).join('\n');
              const jsonExample = `[${getterDef.arguments.map(() => '...').join(', ')}]`;
              const cmdExample = `/call_get_${method} [${getterDef.arguments.map(() => '0').join(', ')}]`;
              
              bot.sendMessage(chatId, `*Temix IDE:*\n📝 *Enter arguments for* \`${method}\`\n\nFormat as JSON array OR use command:\n\`\`\`\n${cmdExample}\n\`\`\`\n\n*Required Arguments:*\n${args}`, { parse_mode: 'Markdown' });
          } else {
              try {
                const result = await withRetry(async () => {
                    const endpoint = await getEndpoint();
                    const client = new TonClient({ endpoint });
                    return await client.runMethod(Address.parse(addr), method);
                });
                const stack = result.stack.items.map(i => {
                  if (i.type === 'int') return i.value.toString();
                  if (i.type === 'cell') return '[Cell]';
                  return i.type;
                });
                bot.sendMessage(chatId, `📊 *Result:* \`${name}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(stack, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
              } catch (e) {
                bot.sendMessage(chatId, `❌ *Call Failed:* ${e.message}`);
              }
          }
        }

        else if (data.startsWith('view_file:')) {
          const fileName = data.split(':')[1];
          try {
            const filePath = path.resolve(__dirname, fileName);
            // Prevent path traversal from callback payload tampering.
            if (!filePath.startsWith(__dirname + path.sep)) {
              return bot.sendMessage(chatId, "❌ Forbidden file path.");
            }
            const content = fs.readFileSync(filePath, 'utf8');
            bot.sendMessage(chatId, `📄 *File:* \`${fileName}\`\n\n\`\`\`tact\n${content.slice(0, 3900)}\n\`\`\``, {
              parse_mode: 'Markdown',
              reply_markup: { inline_keyboard: [[{ text: '🔨 Compile', callback_data: `do_compile:${fileName}` }]] }
            });
          } catch (e) { bot.sendMessage(chatId, "❌ Error reading file."); }
        }

        else if (data.startsWith('view_log:')) {
          const logFile = data.split(':')[1];
          const logPath = path.join(LOG_DIR, logFile);
          try {
            if (!fs.existsSync(logPath)) return bot.sendMessage(chatId, "❌ Log file not found.");
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n').slice(-20).join('\n'); // Last 20 lines
            bot.sendMessage(chatId, `📜 *Last 20 lines of* \`${logFile}\`*:*\n\n\`\`\`\n${lines || '(empty)'}\n\`\`\``, { parse_mode: 'Markdown' });
          } catch (e) { bot.sendMessage(chatId, "❌ Error reading log."); }
        }

        else if (data.startsWith('view_art:')) {
          const fileName = data.split(':')[1];
          const filePath = path.join(BUILD_DIR, fileName);
          try {
            const stat = fs.statSync(filePath);
            const info = `📦 *Artifact:* \`${fileName}\`\n*Size:* \`${(stat.size / 1024).toFixed(2)} KB\`\n*Modified:* \`${stat.mtime.toLocaleString()}\``;
            
            if (fileName.endsWith('.abi') || fileName.endsWith('.json')) {
                const content = fs.readFileSync(filePath, 'utf8');
                bot.sendMessage(chatId, `${info}\n\n\`\`\`json\n${content.slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
            }
          } catch (e) { bot.sendMessage(chatId, "❌ Error reading artifact."); }
        }


      } catch (e) {
        console.error('[Bot Callback Error]', e);
        bot.answerCallbackQuery(query.id, { text: "Error: " + e.message, show_alert: true });
      }
    });

    function hasType(contractName, type) {
        try {
            const abiPath = path.join(BUILD_DIR, `${contractName}.abi`);
            if (!fs.existsSync(abiPath)) return false;
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            return !!abi.types.find(t => t.name === type);
        } catch (e) { return false; }
    }

    function hasGetter(contractName, method) {
        try {
            const abiPath = path.join(BUILD_DIR, `${contractName}.abi`);
            if (!fs.existsSync(abiPath)) return false;
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            return !!abi.getters.find(g => g.name === method);
        } catch (e) { return false; }
    }

    async function handleSendMessage(chatId, target, type, contractName, args) {
        const abiPath = path.join(BUILD_DIR, `${contractName}.abi`);
        if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
        
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        const typeDef = abi.types.find(t => t.name === type);
        if (!typeDef) throw new Error(`Message type "${type}" not found in ABI for ${contractName}`);

        bot.sendMessage(chatId, `🚀 Sending \`${type}\` to \`${contractName}\`...`, { parse_mode: 'Markdown' });
        
        const builder = beginCell();
        if (typeDef.header !== null) builder.storeUint(typeDef.header, 32);
        typeDef.fields.forEach(f => packField(builder, f, args[f.name]));
        const body = builder.endCell();

        const seqno = await withRetry(async () => {
            const endpoint = await getEndpoint();
            const client = new TonClient({ endpoint });
            const contract = client.open(devWallet);
            let s = 0; try { s = await contract.getSeqno(); } catch (e) {}
            await contract.sendTransfer({
                seqno: s, secretKey: walletKey.secretKey,
                messages: [internal({ to: Address.parse(target), value: '0.05', bounce: true, body })]
            });
            return s;
        });
        bot.sendMessage(chatId, `✅ *Transaction Sent!*\nSeqno: \`${seqno}\``, { parse_mode: 'Markdown' });
    }

    async function handleCallGetter(chatId, target, method, contractName, args) {
        const abiPath = path.join(BUILD_DIR, `${contractName}.abi`);
        if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
        
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        const getterDef = abi.getters.find(g => g.name === method);
        if (!getterDef) throw new Error(`Getter "${method}" not found in ABI for ${contractName}`);

        bot.sendMessage(chatId, `🔍 Calling \`${contractName}.${method}()\`...`, { parse_mode: 'Markdown' });
        
        const stack = args.map(arg => {
            if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
            if (typeof arg === 'string') {
                try { return { type: 'slice', cell: beginCell().storeAddress(Address.parse(arg)).endCell() }; }
                catch (e) { return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() }; }
            }
            return arg;
        });

        const result = await withRetry(async () => {
            const endpoint = await getEndpoint();
            const client = new TonClient({ endpoint });
            return await client.runMethod(Address.parse(target), method, stack);
        });
        const resultStack = result.stack.items.map(i => {
            if (i.type === 'int') return i.value.toString();
            if (i.type === 'cell') return '[Cell]';
            return i.value;
        });
        bot.sendMessage(chatId, `📊 *Result:* \`${contractName}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(resultStack, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
    }

    // Handle User Input for Arguments
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const stateData = getUserState(chatId);
        let text = msg.text ? msg.text.trim() : '';

        // Map reply keyboard buttons to actions
        const menuActions = {
          '📂 Forge': 'forge_menu',
          '📂 Contract': 'contract_menu',
          '📂 Workspace': 'workspace_menu',
          '📂 Account': 'account_menu',
          '💳 Wallet': 'wallet',
          '🔨 Compile': 'compile_menu',
          '🚀 Deploy': 'deploy_menu',
          '🎮 Interact': 'interact_menu',
          '🔍 Getters': 'getters_menu',
          '📁 Files': 'files_list',
          '📋 History': 'history',
          '📜 Logs': 'logs_menu',
          '📦 Artifacts': 'artifacts_menu',
          '⚙️ Help': 'help'
        };

        if (menuActions[text]) {
            return handleMenuAction(chatId, menuActions[text], msg);
        }

        // Handle direct commands (e.g., /send_Reset {"val":1} or /call_get_balance [123])
        if (text.startsWith('/send_') || text.startsWith('/call_')) {
            const isCall = text.startsWith('/call_');
            const parts = text.split(' ');
            const cmd = parts[0];
            const jsonStr = parts.slice(1).join(' ');
            
            const contracts = Object.keys(state.deployed);
            if (contracts.length === 0) return bot.sendMessage(chatId, "❌ No deployed contracts found.");

            let typeOrMethod = isCall ? cmd.replace('/call_get_', '') : cmd.replace('/send_', '');
            
            // Search for correct contract
            let contractName = stateData ? stateData.contractName : null;
            if (!contractName || (isCall ? !hasGetter(contractName, typeOrMethod) : !hasType(contractName, typeOrMethod))) {
                contractName = contracts.find(c => isCall ? hasGetter(c, typeOrMethod) : hasType(c, typeOrMethod));
            }
            if (!contractName) {
                return bot.sendMessage(chatId, `❌ No deployed contract has type \`${typeOrMethod}\`.`, { parse_mode: 'Markdown' });
            }

            try {
                if (isCall) {
                    const args = jsonStr ? JSON.parse(jsonStr) : [];
                    await handleCallGetter(chatId, state.deployed[contractName], typeOrMethod, contractName, args);
                } else {
                    const args = jsonStr ? JSON.parse(jsonStr) : {};
                    await handleSendMessage(chatId, state.deployed[contractName], typeOrMethod, contractName, args);
                }
            } catch (e) {
                bot.sendMessage(chatId, `❌ *Error:* ${escapeMarkdownV2(e.message)}`, { parse_mode: 'MarkdownV2' });
            }
            return;
        }

        if (!stateData || !msg.text || msg.text.startsWith('/')) return;

        try {
            if (stateData.action === 'awaiting_manual_target') {
                const target = msg.text.trim();
                try {
                    Address.parse(target);
                    setUserState(chatId, { action: 'awaiting_manual_msg', target });
                    bot.sendMessage(chatId, `🎯 *Target set:* \`${target}\`\n\nNow enter the message string (e.g., "increment") or a TON value + message (e.g., "0.05:increment"):`, { parse_mode: 'Markdown' });
                } catch (e) {
                    bot.sendMessage(chatId, "❌ Invalid TON address. Try again or /menu to cancel.");
                }
            }
            else if (stateData.action === 'awaiting_manual_msg') {
                let text = msg.text.trim();
                let value = '0.05';
                if (text.includes(':')) {
                    const parts = text.split(':');
                    value = parts[0];
                    text = parts.slice(1).join(':');
                }
                const target = stateData.target;
                clearUserState(chatId);

                bot.sendMessage(chatId, `Sending "${text}" to ${target} (${value} TON)...`);
                try {
                    const body = beginCell().storeUint(0, 32).storeStringTail(text).endCell();
                    const seqno = await withRetry(async () => {
                        const endpoint = await getEndpoint();
                        const client = new TonClient({ endpoint });
                        const contract = client.open(devWallet);
                        let s = 0; try { s = await contract.getSeqno(); } catch (e) {}
                        await contract.sendTransfer({
                            seqno: s, secretKey: walletKey.secretKey,
                            messages: [internal({ to: Address.parse(target), value, bounce: true, body })]
                        });
                        return s;
                    });
                    bot.sendMessage(chatId, `✅ *Transaction Sent!*\nSeqno: \`${seqno}\``, { parse_mode: 'Markdown' });
                } catch (e) { bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); }
            }
            else if (stateData.action === 'awaiting_args') {
                const args = JSON.parse(msg.text);
                const { target, type, contractName } = stateData;
                clearUserState(chatId);
                await handleSendMessage(chatId, target, type, contractName, args);
            } 
            else if (stateData.action === 'awaiting_getter_args') {
                const args = JSON.parse(msg.text);
                const { target, method, contractName } = stateData;
                clearUserState(chatId);
                await handleCallGetter(chatId, target, method, contractName, args);
            } 

        } catch (e) {
            bot.sendMessage(chatId, `❌ *Input Error:* ${e.message}\nTry again or use /menu to cancel.`);
        }
    });

    // Legacy Text Commands (Forward to Menu)
    bot.onText(/\/wallet/, (msg) => { if (isAuthorized(msg)) handleMenuAction(msg.chat.id, 'wallet', msg); });
    bot.onText(/\/compile/, (msg) => { if (isAuthorized(msg)) handleMenuAction(msg.chat.id, 'compile_menu', msg); });
    bot.onText(/\/deploy/, (msg) => { if (isAuthorized(msg)) handleMenuAction(msg.chat.id, 'deploy_menu', msg); });
    bot.onText(/\/help/, (msg) => { if (isAuthorized(msg)) handleMenuAction(msg.chat.id, 'help', msg); });

    // Handle File Uploads (Dynamic Filename)
    bot.on('document', async (msg) => {
      if (!isAuthorized(msg)) return;
      if (!msg.document.file_name.endsWith('.tact')) return;
      
      bot.sendMessage(msg.chat.id, `📥 *Uploading* \`${msg.document.file_name}\`*...*`, { parse_mode: 'Markdown' });
      try {
        const fileUrl = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(msg.document.file_name, Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ *File saved!* You can now compile \`${msg.document.file_name}\` from the menu.`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Compile Now', callback_data: `do_compile:${msg.document.file_name}` }]] }
        });
      } catch (e) {
        bot.sendMessage(msg.chat.id, "❌ Upload failed: " + e.message);
      }
    });

    bot.on('polling_error', (error) => {
      if (error.code === 'ETELEGRAM' && error.message.includes('401 Unauthorized')) {
        console.error('[Bot Error] Invalid Token.');
      }
    });
  } else {
    console.log('\x1b[33m[!] TELEGRAM_BOT_TOKEN not found — bot mode disabled.\x1b[0m');
  }

  const graceful = sig => {
    console.log(`\n\x1b[33m[*] ${sig} received — graceful shutdown (5s timeout)...\x1b[0m`);
    server.close(() => { console.log('\x1b[32m[+] Server closed cleanly.\x1b[0m'); process.exit(0); });
    setTimeout(() => { console.error('\x1b[31m[!] Forced exit after timeout.\x1b[0m'); process.exit(1); }, 5000);
  };
  process.on('SIGINT',  () => graceful('SIGINT'));
  process.on('SIGTERM', () => graceful('SIGTERM'));
  process.on('uncaughtException',  e => { console.error('\x1b[31m[UNCAUGHT]\x1b[0m', e); process.exit(1); });
  process.on('unhandledRejection', r => console.error('\x1b[31m[REJECTION]\x1b[0m', r));
});

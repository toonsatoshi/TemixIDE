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
const crypto       = require('crypto');
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
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_MODEL = 'deepseek-reasoner';

const AI_SYSTEM_PROMPT = `You are a Tact smart contract code generator for the TON blockchain. Your only output is a single compilable Tact contract. You serve a Telegram-based IDE that parses your response programmatically.

ABSOLUTE OUTPUT RULES — any violation breaks the IDE parser:
1. Your entire response must contain exactly one fenced code block.
2. The fence must open with exactly: \`\`\`tact (three backticks then the word tact, nothing else on that line)
3. The fence must close with exactly: \`\`\` (three backticks, nothing else on that line)
4. There must be zero characters before the opening fence and zero characters after the closing fence. No greeting, no explanation, no summary, no sign-off.
5. The code block must contain only valid Tact source code. No comments that are not valid Tact line comments (// only). No block comments. No markdown inside the code block.

TELEGRAM SAFETY RULES:
6. Outside the code block: output nothing (see rule 4).
7. Inside the code block: never use underscores in identifier names — use camelCase exclusively.
8. No asterisks in comments or strings.
9. No square brackets in strings or comments.
10. No backtick characters anywhere inside the code block.

TACT LANGUAGE RULES:
11. Always import "@stdlib/deploy" if using Deployable trait. Never import it if not used.
12. Every contract must have at least one receive() handler.
13. All storage fields must have explicit initial values assigned in init().
14. Use sender() only inside receive() handlers, never in getters.
15. Use send(SendParameters{}) for all outbound messages. Never use self.reply() when value, mode, or bounce control is needed.
16. Every send(SendParameters{}) must explicitly set bounce: false unless a bounce handler is defined in the contract.
17. SendRemainingBalance is 128. SendDestroyIfZero is 32. Combine as mode: 128 + 32 when self-destructing.
18. require() takes exactly two arguments: a Bool expression and a String literal.
19. All Int fields must declare their serialization format explicitly (e.g. Int as uint64, Int as coins).
20. message structs are declared with the message keyword, not struct.
21. Getters are declared as get fun name(): ReturnType and may not modify state.
22. No TODOs, no placeholder comments, no unimplemented handlers. Every function must be complete.
23. Contract names must be PascalCase. message names must be PascalCase.
24. Do not use deprecated syntax. Do not use emit(). Do not use nativeReserve() unless specifically requested.
25. If the contract deploys child contracts, use initOf ContractName(args) for the StateInit.
26. Do not use String in message fields that need to be compact. Use Cell or Slice for raw data.
27. Do not duplicate receive logic. If a bare receive() handler exists, do not add a typed message handler that does the same thing.

DESIGN RULES:
28. Infer all design decisions. Never ask clarifying questions.
29. Use require() to guard every state-changing handler against unauthorized access, invalid state, and invalid values.
30. Always handle the zero-value edge case — if a handler involves TON amounts, require context().value > 0 or handle explicitly.
31. Every contract that holds funds must have a defined exit path. No funds may be permanently locked.
32. Owner capture is always: self.owner = sender() inside init(). Never pass owner as an init parameter. Never use a hardcoded address.
33. When self-destructing, always leave enough gas for the send to execute — use require(myBalance() > ton("0.01"), "...") before the final send.`;

async function generateAIContract(prompt) {
    if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    
    logger.info(`AI Contract Generation requested. Prompt length: ${prompt.length}`);
    logger.trace(`AI Prompt: ${prompt}`);

    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error?.message || response.statusText;
        logger.error(`DeepSeek API error: ${errMsg}`, '', errData);
        throw new Error(`DeepSeek API error: ${errMsg}`);
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    logger.debug(`AI Response received. Content length: ${content.length}`);
    logger.trace(`AI Full Content: ${content}`);
    
    const match = content.match(/^```tact\n([\s\S]*?)\n```$/) || content.match(/```tact\n([\s\S]*?)```/);
    if (!match) {
        logger.error('AI Response format violation', '', content);
        throw new Error('AI response did not follow output rules (missing or malformed code block).');
    }
    
    return match[1].trim();
}

const AI_GUIDE_SYSTEM_PROMPT = `You are a technical guide for Temix IDE, a Telegram-based environment for Tact smart contracts on TON. 
Your goal is to explain how to use a specific Tact contract that was just generated.

Rules for your response:
1. Be concise and professional.
2. Use Telegram-compatible HTML formatting ONLY. Use <b> for bold, <i> for italic, and <code> for monospaced text.
3. Do NOT use Markdown (no #, no *, no _, etc.).
4. Explain the specific actions available in the contract (messages and getters).
5. Inform the user that interactive buttons have been provided below for these actions.
6. Command syntax (if they prefer typing): 
   - <code>/send_MessageName {"field": value}</code>
   - <code>/call_get_methodName</code>
7. Mention that the user should first click "Compile Now" (above) then "Deploy Now" (below).
8. Do not include the contract code itself.`;

async function generateAIUsageGuide(contractCode) {
    if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: AI_GUIDE_SYSTEM_PROMPT },
                { role: 'user', content: `Here is the Tact contract code:\n\n${contractCode}\n\nPlease provide a usage guide for Temix IDE.` }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Guide): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

async function generateAIExplanation(prompt, context) {
    if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: 'You are a TON/Tact expert assistant for Temix IDE. Provide concise, accurate, and context-aware help based on the provided contract code. Use Telegram-compatible HTML formatting (<b>, <i>, <code>) exclusively. Do NOT use Markdown.' },
                { role: 'user', content: `Context (Tact Code):\n<pre>${context}</pre>\n\nQuestion/Task: ${prompt}` }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Explain): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

async function analyzeAIRequirement(prompt) {
    if (!DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: DEEPSEEK_MODEL,
            messages: [
                { 
                  role: 'system', 
                  content: `Analyze the user's request for a TON/Tact smart contract. 
Determine if this request requires multiple separate contract files (e.g., a factory and its children, or separate logic modules).

You must respond with a JSON object ONLY:
{
  "multi": boolean,
  "explanation": "Brief explanation of why multiple contracts are needed (if multi is true)",
  "contracts": [
    { "name": "ContractName", "purpose": "What this contract does", "prompt": "Specific detailed prompt to generate ONLY this contract" }
  ]
}

If only one contract is needed, set "multi" to false and provide one entry in "contracts".` 
                },
                { role: 'user', content: prompt }
            ],
            stream: false,
            response_format: { type: 'json_object' }
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Analysis): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    if (!data.choices || !data.choices[0] || !data.choices[0].message || !data.choices[0].message.content) {
        throw new Error('Invalid response from AI API');
    }
    
    try {
        const result = JSON.parse(data.choices[0].message.content);
        if (typeof result !== 'object' || result === null) throw new Error('AI returned null or non-object');
        if (typeof result.multi === 'undefined') result.multi = false;
        if (!Array.isArray(result.contracts)) {
            result.contracts = [{ name: 'Generated', purpose: 'Contract generation', prompt: prompt }];
        }
        return result;
    } catch (e) {
        logger.error('Failed to parse AI Analysis JSON', '', e);
        return { multi: false, contracts: [{ name: 'Generated', purpose: 'Contract generation', prompt: prompt }] };
    }
}

async function executeContractGeneration(bot, chatId, prompt, statusMessageId) {
    const updateStatus = async (msg) => {
        try {
            await bot.editMessageText(msg, { chat_id: chatId, message_id: statusMessageId, parse_mode: 'HTML' });
        } catch (e) { /* ignore edit errors */ }
    };

    try {
        let code = '';
        let attempts = 0;
        let lastError = '';
        let success = false;
        let finalVerification = null;
        const maxAttempts = 3;

        while (attempts < maxAttempts && !success) {
            attempts++;
            await updateStatus(`🧠 <b>Temix IDE: Generating Contract (Attempt ${attempts}/${maxAttempts})...</b>`);
            
            const genPrompt = lastError 
                ? `The following Tact code failed to compile:\n\n${code}\n\nError:\n${lastError}\n\nPlease fix the errors and provide the complete corrected code. Keep adhering to the absolute output rules.`
                : prompt;
            
            code = await generateAIContract(genPrompt);
            
            await updateStatus(`🔨 <b>Temix IDE: Verifying Contract Integrity...</b>`);
            
            const contractName = extractContractName(code);
            const fileName = `${contractName}_verify.tact`;
            const sessionPath = getSessionPath();
            
            finalVerification = await compileSilent(code, fileName, sessionPath);
            
            if (finalVerification.success) {
                success = true;
            } else {
                lastError = finalVerification.error;
                logger.warn(`AI Forge attempt ${attempts} failed compilation`, '', lastError);
            }
        }

        if (!success) {
            throw new Error(`Failed to generate a valid contract after ${maxAttempts} attempts. Last error: ${lastError.slice(0, 200)}...`);
        }

        const finalAbi = finalVerification.abi;
        await updateStatus(`✨ <b>Temix IDE: Finalizing artifacts and guide...</b>`);
        
        const guide = await generateAIUsageGuide(code);
        const sessionPath = getSessionPath();
        const contractName = extractContractName(code);
        const fileName = `${contractName}.tact`;
        
        fs.writeFileSync(path.join(sessionPath, fileName), code);
        logger.info(`AI Generated contract: ${fileName} in session ${state.currentSession}`);
        
        try { await bot.deleteMessage(chatId, statusMessageId); } catch(e){}

        await bot.sendMessage(chatId, `✨ <b>Contract Generated & Verified!</b>\n\n<b>File:</b> <code>${fileName}</code>\n<b>Session:</b> <code>${state.currentSession}</code>\n\n\`\`\`tact\n${code.slice(0, 3000)}${code.length > 3000 ? '\n...(truncated)' : ''}\n\`\`\``, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '🔨 Compile Now', callback_data: `do_compile:${getShort(fileName)}` }]]
            }
        });

        const buttons = [];
        if (finalAbi) {
            const receivers = finalAbi.receivers || [];
            const getters = finalAbi.getters || [];
            receivers.forEach(r => {
                if (r.receiver === 'internal' || r.receiver === 'external') {
                    const label = r.message.type === 'text' ? `✉️ "${r.message.text}"` : `✉️ ${r.message.type}`;
                    buttons.push([{ text: label, callback_data: `prep_int:${getShort(contractName)}:${getShort(r.message.type)}:${getShort(r.message.text || '')}` }]);
                }
            });
            getters.forEach(g => {
                buttons.push([{ text: `🔍 ${g.name}()`, callback_data: `call_get:${getShort(contractName)}:${getShort(g.name)}` }]);
            });
        }

        await bot.sendMessage(chatId, `📖 <b>Usage Guide for ${contractName}</b>\n\n${guide}`, {
            parse_mode: 'HTML',
            reply_markup: buttons.length > 0 ? {
                inline_keyboard: [
                    [{ text: '🚀 Deploy Now', callback_data: `do_deploy:${getShort(contractName)}` }],
                    ...buttons
                ]
            } : undefined
        });

        return { success: true, contractName };
    } catch (e) {
        logger.error('executeContractGeneration failed', '', e);
        try { await bot.editMessageText(`❌ <b>AI Forge Failed</b>\n\n${escapeHtml(e.message)}`, { chat_id: chatId, message_id: statusMessageId, parse_mode: 'HTML' }); }
        catch(e2) { bot.sendMessage(chatId, `❌ <b>AI Forge Failed</b>\n\n${escapeHtml(e.message)}`, { parse_mode: 'HTML' }); }
        return { success: false, error: e.message };
    }
}

function parseTactError(output) {
    const lines = output.split('\n');
    const errorMarkers = [];
    for (let i = 0; i < lines.length; i++) {
        // Match standard Tact error format: file.tact:line:col: message
        const match = lines[i].match(/(.*?\.tact):(\d+):(\d+): (.*)/);
        if (match) {
            errorMarkers.push(`Line ${match[2]}, Col ${match[3]}: ${match[4]}`);
        }
    }
    return errorMarkers.length > 0 ? `Detailed Errors:\n${errorMarkers.join('\n')}` : output.slice(0, 1000);
}

function extractContractName(code) {
    const match = code.match(/contract\s+([a-zA-Z0-9]+)/);
    return match ? match[1] : 'Generated';
}

async function compileSilent(code, fileName, sessionPath) {
    const tempFile = path.join(sessionPath, fileName);
    fs.writeFileSync(tempFile, code);
    
    const tempConfigPath = path.join(sessionPath, `temp_verify_${fileName}.json`);
    const projectName = `Verify_${fileName.replace('.tact', '').replace(/[^a-zA-Z0-9]/g, '_')}`;
    const buildVerifyDir = path.join(sessionPath, 'build_verify');
    
    if (!fs.existsSync(buildVerifyDir)) fs.mkdirSync(buildVerifyDir, { recursive: true });

    const tempConfig = {
        projects: [{
            name: projectName,
            path: `./${fileName}`,
            output: './build_verify',
            options: { debug: true, external: true }
        }]
    };
    
    fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));
    logger.debug(`Starting silent compilation for verification: ${projectName}`, 'VERIFY');
    try {
        const cmd = `npx tact --config "${path.basename(tempConfigPath)}" 2>&1`;
        logger.trace(`Exec: ${cmd}`, 'VERIFY');
        const out = execSync(cmd, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
        logger.debug(`Silent compilation successful`, 'VERIFY');
        logger.trace(`Compiler Output:\n${out.toString()}`, 'VERIFY');
        
        const abiPath = path.join(buildVerifyDir, `${projectName}.abi`);
        let abi = null;
        if (fs.existsSync(abiPath)) {
            abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            logger.trace(`ABI loaded for ${projectName}`, 'VERIFY');
        }
        return { success: true, abi };
    } catch (e) {
        const err = e.stdout ? e.stdout.toString('utf8') : e.message;
        logger.error(`Silent compilation failed: ${err}`, 'VERIFY', e);
        return { success: false, error: parseTactError(err) };
    } finally {
        try {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
            if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
            if (fs.existsSync(buildVerifyDir)) fs.rmSync(buildVerifyDir, { recursive: true, force: true });
            logger.trace(`Cleanup verification artifacts for ${projectName}`, 'VERIFY');
        } catch (cleanupErr) {
            logger.error('Cleanup failed', 'VERIFY', cleanupErr);
        }
    }
}

const TONCENTER_API_KEY = process.env.TONCENTER_API_KEY || "1dce291cfe6b56e6d28f52cec84c72b942da3723cc9a4bfe6b224b1c8f7efb62";
const CHANNEL_ID  = process.env.TELEGRAM_CHANNEL_ID ? String(process.env.TELEGRAM_CHANNEL_ID).trim() : '';

const safeJsonParse = (str) => {
  if (!str) return null;
  const sanitized = String(str)
    .replace(/[\u201C\u201D]/g, '"')  // " " → "
    .replace(/[\u2018\u2019]/g, "'")  // ' ' → '
    .replace(/\u00A0/g, ' ')          // Non-breaking space → space
    .replace(/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, ' '); // Other exotic spaces
  return JSON.parse(sanitized);
};

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeHTML = (str) => {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};
const ENV         = process.env.TACT_ENV     || 'development';
const DEBUG       = process.env.DEBUG === 'true' || ENV === 'development';
const NETWORK     = process.env.TACT_NETWORK || 'testnet';
const IS_TESTNET  = NETWORK === 'testnet';
const LOG_DIR     = path.resolve(__dirname, 'logs');
const WALLET_FILE = path.join(__dirname, 'dev-wallet.json');
const BUILD_DIR   = path.join(__dirname, 'build');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// ─── Logger ──────────────────────────────────────────────────────────────
const MAIN_LOG = path.join(LOG_DIR, 'server.log');
const logger = {
  _write: (level, msg, id = '', err = null) => {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level}]${id ? ` [${id}]` : ''}`;
    const line = `${prefix} ${msg}`;
    
    // Console output with colors
    const colors = { INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', DEBUG: '\x1b[36m', TRACE: '\x1b[90m' };
    console.log(`${colors[level] || ''}${line}\x1b[0m`);
    
    if (err && (level === 'ERROR' || DEBUG)) {
        console.error(err);
    }

    // File output
    try {
      fs.appendFileSync(MAIN_LOG, line + '\n');
      if (err) fs.appendFileSync(MAIN_LOG, `${prefix} ERROR STACK: ${err.stack || err}\n`);
    } catch (e) { /* ignore log failures */ }
  },
  info: (msg, id = '') => logger._write('INFO', msg, id),
  warn: (msg, id = '') => logger._write('WARN', msg, id),
  error: (msg, id = '', err = null) => logger._write('ERROR', msg, id, err),
  debug: (msg, id = '') => { if (DEBUG) logger._write('DEBUG', msg, id); },
  trace: (msg, id = '') => { if (process.env.TRACE === 'true') logger._write('TRACE', msg, id); }
};

// ─── App & WebSocket ─────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const wsBroadcast = (type, data) => {
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
  logger.trace(`WS Broadcast: ${type} - ${typeof data === 'string' ? data.slice(0, 100) : 'object'}`);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
};

const escapeMarkdownV2 = (str) => {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

const formatMarkdownV2Link = (label, url) => {
  return `[${escapeMarkdownV2(label)}](${encodeURI(url)})`;
};

let pollingBotInstance = null;
let broadcastBotInstance = null;

const broadcastToChannel = async (message) => {
  if (!BOT_TOKEN || !CHANNEL_ID) return;
  try {
    const bot = pollingBotInstance || (broadcastBotInstance ||= new TelegramBot(BOT_TOKEN, { polling: false }));
    await bot.sendMessage(CHANNEL_ID, message, { parse_mode: 'MarkdownV2' });
    logger.trace(`Channel broadcast sent to ${CHANNEL_ID}`);
  } catch (e) {
    logger.error(`[Broadcast Error] ${e.message}`);
  }
};

wss.on('connection', ws => {
  logger.info('New WebSocket connection established');
  ws.send(JSON.stringify({ type: 'connected', data: 'Live log stream active.', ts: new Date().toISOString() }));
  ws.on('error', e => logger.error('[WS Error]', '', e));
});

// ─── Middleware Stack ─────────────────────────────────────────────────────
app.use(compression());
app.use((req, res, next) => { 
  req.requestId = uuidv4().slice(0, 8); 
  res.setHeader('X-Request-ID', req.requestId); 
  
  const start = Date.now();
  // Enhanced Request Logging
  logger.info(`${req.method} ${req.path} - IP: ${req.ip} - User-Agent: ${req.get('User-Agent')}`, req.requestId);
  
  // Capture response body for logging
  const oldWrite = res.write;
  const oldEnd = res.end;
  const chunks = [];

  res.write = (...args) => {
    chunks.push(Buffer.from(args[0]));
    return oldWrite.apply(res, args);
  };

  res.end = (...args) => {
    if (args[0]) chunks.push(Buffer.from(args[0]));
    const body = Buffer.concat(chunks).toString('utf8');
    const duration = Date.now() - start;
    
    logger.debug(`Response ${res.statusCode} (${duration}ms): ${body.length > 500 ? body.slice(0, 500) + '...' : body}`, req.requestId);
    return oldEnd.apply(res, args);
  };

  next(); 
});
app.use(express.json({ limit: '5mb' }));
// Log request body after json parsing
app.use((req, res, next) => {
    if (req.method !== 'GET' && req.body && Object.keys(req.body).length > 0) {
        const bodyStr = JSON.stringify(req.body);
        logger.debug(`Request Body: ${bodyStr.length > 1000 ? bodyStr.slice(0, 1000) + '...' : bodyStr}`, req.requestId);
    }
    next();
});
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Request-ID'] }));
app.use(helmet({ contentSecurityPolicy: false })); 
app.use(morgan('dev'));
app.use(morgan('combined', { stream: fs.createWriteStream(path.join(LOG_DIR, 'access.log'), { flags: 'a' }) }));
app.use(rateLimit({
  windowMs: 60000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Retry after 60s.' },
  handler: (req, res, next, opts) => { 
    logger.warn(`Rate limit hit from ${req.ip}`, req.requestId);
    wsBroadcast('warn', `Rate limit hit from ${req.ip}`); 
    res.status(429).json(opts.message); 
  }
}));
const heavyLimiter = rateLimit({ windowMs: 60000, max: 10, message: { error: 'Heavy endpoint: 10 req/min max.' } });
app.use(express.static(path.join(__dirname, 'public')));

// ─── State ────────────────────────────────────────────────────────────────
let devWallet = null, tonClient = null, walletKey = null, initialized = false;
const MAX_TX    = 10;
const STATE_FILE = path.join(__dirname, 'state.json');
const SESSIONS_DIR = path.resolve(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let state = {
  currentSession: 'default',
  sessions: {
    'default': {
      deployed: {},
      lastFile: 'contract.tact',
      txHistory: []
    }
  },
  authorizedUsers: process.env.TELEGRAM_AUTHORIZED_ID ? process.env.TELEGRAM_AUTHORIZED_ID.split(',').map(id => id.trim()) : [],
  short: {} // { shortKey: longValue }
};

function getSession() {
  if (!state.sessions) state.sessions = {};
  if (!state.currentSession) state.currentSession = 'default';
  if (!state.sessions[state.currentSession]) {
    state.sessions[state.currentSession] = { deployed: {}, lastFile: 'contract.tact', txHistory: [] };
  }
  return state.sessions[state.currentSession];
}

function getSessionPath() {
  const p = path.join(SESSIONS_DIR, state.currentSession);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getSessionBuildDir() {
  const p = path.join(getSessionPath(), 'build');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getSessionLogDir() {
  const p = path.join(getSessionPath(), 'logs');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

let compileQueue = Promise.resolve();

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      
      // Migration: if old state format (no sessions)
      if (loaded.deployed && !loaded.sessions) {
        state.sessions.default.deployed = loaded.deployed || {};
        state.sessions.default.lastFile = loaded.lastFile || 'contract.tact';
        state.sessions.default.txHistory = Array.isArray(global.txHistory) ? global.txHistory : [];
        state.authorizedUsers = loaded.authorizedUsers || state.authorizedUsers;
        state.short = loaded.short || {};
        logger.info("Migrated old state to session 'default'");
      } else {
        state = { ...state, ...loaded };
      }
      logger.info(`State loaded from ${STATE_FILE} (Session: ${state.currentSession})`);
    } catch (e) { logger.error('Failed to load state', '', e); }
  }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.debug(`State saved to ${STATE_FILE}`);
  } catch (e) { logger.error('Failed to save state', '', e); }
}

function addHistory(tx) {
  const session = getSession();
  if (!session.txHistory) session.txHistory = [];
  session.txHistory.unshift(tx);
  if (session.txHistory.length > MAX_TX) session.txHistory.pop();
  saveState();
}

function getShort(val) {
  if (!val) return '';
  if (val.length < 8) return val;
  for (const [k, v] of Object.entries(state.short || {})) {
    if (v === val) return k;
  }
  const k = `_${Math.random().toString(36).slice(2, 7)}`;
  state.short = state.short || {};
  state.short[k] = val;
  saveState();
  return k;
}

function getLong(k) {
  if (k && k.startsWith('_')) {
    return (state.short || {})[k] || k;
  }
  return k;
}

loadState();

async function withRetry(fn, retries = 10, id = '') {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      logger.trace(`RPC Call attempt ${i + 1}/${retries}`, id);
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e.message || String(e);
      const isRetryable = msg.includes('502') || msg.includes('500') || msg.includes('429') || 
                          msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') ||
                          msg.toLowerCase().includes('timeout') || 
                          msg.includes('getseqno') || msg.includes('execution reversed');

      if (isRetryable) {
        const wait = (2000 * (i + 1)) + Math.random() * 1000; 
        logger.warn(`RPC error (retryable): ${msg.slice(0,200)}. Retrying (${i+1}/${retries}) in ${Math.round(wait)}ms...`, id);
        wsBroadcast('warn', `RPC Error: ${msg.slice(0,50)}. Retrying (${i+1}/${retries})...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        logger.error(`RPC error (non-retryable): ${msg}`, id, e);
        throw e;
      }
    }
  }
  logger.error(`RPC max retries reached (${retries})`, id, lastErr);
  throw lastErr;
}

function queueCompileTask(task) {
  const run = compileQueue.then(task, task);
  compileQueue = run.catch((e) => {
    logger.error('Queue task failed', '', e);
  });
  return run;
}

async function getEndpoint() {
  const isTestnet = NETWORK === 'testnet';
  const toncenter = isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
  
  const providers = [
    () => toncenter,
    async () => await getHttpEndpoint({ network: NETWORK }),
  ];
  
  for (let i = 0; i < providers.length; i++) {
    try {
      const url = await providers[i]();
      if (url) {
        logger.debug(`Selected RPC endpoint: ${url}`);
        return url;
      }
    } catch (e) {
      logger.debug(`Provider ${i} failed: ${e.message}`);
    }
  }
  const fallback = isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
  logger.warn(`All providers failed, using fallback: ${fallback}`);
  return fallback;
}

function createTonClient(endpoint) {
    const config = { endpoint };
    if (endpoint.includes('toncenter.com')) {
        config.apiKey = TONCENTER_API_KEY;
    }
    return new TonClient(config);
}

// ─── Initialization ──────────────────────────────────────────────────────
async function init() {
  try {
    logger.info('Initializing TemixIDE...');
    if (!process.env.TELEGRAM_CHANNEL_ID) {
      logger.warn('TELEGRAM_CHANNEL_ID not set — channel broadcast disabled.');
    }
    
    let mnemonic;
    if (fs.existsSync(WALLET_FILE)) {
      const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
      if (!w.mnemonic || (typeof w.mnemonic !== 'string' && !Array.isArray(w.mnemonic))) throw new Error('Corrupted wallet file. Delete dev-wallet.json and restart.');
      mnemonic = typeof w.mnemonic === 'string' ? w.mnemonic.split(' ') : w.mnemonic;
      logger.info('Existing development wallet loaded.');
    } else if (process.env.WALLET_MNEMONIC) {
      mnemonic = process.env.WALLET_MNEMONIC.split(' ');
      fs.writeFileSync(WALLET_FILE, JSON.stringify({ mnemonic, created: new Date().toISOString(), source: 'env' }, null, 2));
      logger.info('Wallet initialized from WALLET_MNEMONIC environment variable.');
    } else {
      logger.info('Generating new development wallet...');
      mnemonic = await mnemonicNew();
      fs.writeFileSync(WALLET_FILE, JSON.stringify({ mnemonic, created: new Date().toISOString() }, null, 2));
      logger.warn('NEW wallet generated — fund it via the faucet before deploying.');
    }
    
    logger.trace('Deriving private key from mnemonic...');
    walletKey   = await mnemonicToPrivateKey(mnemonic);
    
    logger.trace('Selecting RPC endpoint...');
    const endpoint = await getEndpoint();
    
    logger.trace(`Initializing TON Client with endpoint: ${endpoint}`);
    tonClient   = createTonClient(endpoint);
    
    devWallet   = WalletContractV4.create({ workchain: 0, publicKey: walletKey.publicKey });
    logger.info(`Wallet Address: ${devWallet.address.toString({ testOnly: IS_TESTNET })}`);
    
    initialized = true;
    logger.trace('Initialization flag set to true');

    // Migration: Move existing .tact files and artifacts to sessions/default if they exist and sessions/default is empty
    const defaultSessionPath = path.join(SESSIONS_DIR, 'default');
    if (!fs.existsSync(defaultSessionPath)) {
        logger.trace(`Creating default session directory: ${defaultSessionPath}`);
        fs.mkdirSync(defaultSessionPath, { recursive: true });
    }
    
    const existingTactFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.tact') && f !== 'contract.tact');
    if (existingTactFiles.length > 0 && fs.readdirSync(defaultSessionPath).filter(f => f.endsWith('.tact')).length === 0) {
        logger.info(`Migrating ${existingTactFiles.length} files to sessions/default...`);
        existingTactFiles.forEach(f => {
            try { 
                logger.trace(`Copying ${f} to sessions/default`);
                fs.copyFileSync(path.join(__dirname, f), path.join(defaultSessionPath, f)); 
            } catch (e) { logger.error(`Migration failed for ${f}`, '', e); }
        });
        
        const buildDir = path.join(__dirname, 'build');
        const defaultBuildDir = path.join(defaultSessionPath, 'build');
        if (fs.existsSync(buildDir) && !fs.existsSync(defaultBuildDir)) {
            logger.trace('Migrating build artifacts to sessions/default/build');
            fs.mkdirSync(defaultBuildDir, { recursive: true });
            fs.readdirSync(buildDir).forEach(f => {
                try { fs.copyFileSync(path.join(buildDir, f), path.join(defaultBuildDir, f)); } catch (e) {}
            });
        }
        
        const logsDir = path.join(__dirname, 'logs');
        const defaultLogsDir = path.join(defaultSessionPath, 'logs');
        if (fs.existsSync(logsDir) && !fs.existsSync(defaultLogsDir)) {
            logger.trace('Migrating logs to sessions/default/logs');
            fs.mkdirSync(defaultLogsDir, { recursive: true });
            fs.readdirSync(logsDir).forEach(f => {
                try { fs.copyFileSync(path.join(logsDir, f), path.join(defaultLogsDir, f)); } catch (e) {}
            });
        }
    }

    console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\n║   🚀  TEMIXIDE v2.0  —  SERVER ONLINE                      ║\n║      Rate-Limited · Compressed · WebSocket Live Logs        ║\n╚══════════════════════════════════════════════════════════════╝\x1b[0m');
    logger.info(`Network:  ${NETWORK.toUpperCase()}`);
    logger.info(`Wallet:   ${devWallet.address.toString({ testOnly: IS_TESTNET })}`);
    logger.info(`Endpoint: http://localhost:${PORT}`);
    logger.info(`Env:      ${ENV}`);
    logger.debug(`Debug mode: ${DEBUG}`);

    broadcastToChannel(`🚀 *${escapeMarkdownV2('Temix IDE')}:* ${escapeMarkdownV2('Connection Live for Channel Broadcasting')}`);
  } catch (e) {
    logger.error('[FATAL] Initialization failed', '', e);
    process.exit(1);
  }
}

const requireInit = (req, res, next) =>
  initialized ? next() : res.status(503).json({ error: 'Server still initializing — retry shortly.' });

// ─── Routes ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  logger.debug('Health check requested', req.requestId);
  res.json({
    status: 'Operational', version: '2.0.0', environment: ENV, network: NETWORK,
    uptime: process.uptime(), memory: process.memoryUsage(), hostname: os.hostname(),
    nodeVersion: process.version, walletReady: initialized, timestamp: new Date().toISOString()
  });
});

app.get('/api/wallet/seed', requireInit, (req, res) => {
    if (!fs.existsSync(WALLET_FILE)) return res.status(404).json({ error: 'No wallet file.' });
    try {
        const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
        res.json({ mnemonic: Array.isArray(w.mnemonic) ? w.mnemonic.join(' ') : w.mnemonic });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/wallet', requireInit, async (req, res) => {
  try {
    logger.debug('Fetching wallet balance...', req.requestId);
    const balance = await withRetry(async () => {
        const endpoint = await getEndpoint();
        const client = createTonClient(endpoint);
        return await client.getBalance(devWallet.address);
    }, 10, req.requestId);
    
    logger.info(`Wallet balance: ${(Number(balance) / 1e9).toFixed(6)} TON`, req.requestId);
    res.json({
      address: devWallet.address.toString({ testOnly: IS_TESTNET }),
      balance: (Number(balance) / 1e9).toFixed(6),
      network: NETWORK, walletVersion: 'V4R2'
    });
  } catch (e) {
    logger.error('Wallet Error', req.requestId, e);
    res.status(500).json({ error: 'Balance fetch failed: ' + e.message });
  }
});

app.delete('/api/wallet', requireInit, (req, res) => {
  try {
    logger.info('Wallet reset requested', req.requestId);
    if (!fs.existsSync(WALLET_FILE)) return res.status(404).json({ error: 'No wallet file found.' });
    const backup = WALLET_FILE.replace('.json', `.backup-${Date.now()}.json`);
    fs.copyFileSync(WALLET_FILE, backup);
    fs.unlinkSync(WALLET_FILE);
    logger.info(`Wallet cleared. Backup: ${backup}`, req.requestId);
    res.json({ success: true, message: 'Wallet cleared. Restart server to generate a new one.', backup });
  } catch (e) { 
    logger.error('Wallet Reset Error', req.requestId, e);
    res.status(500).json({ error: e.message }); 
  }
});

app.post('/api/compile', heavyLimiter, requireInit, (req, res) => {
  if (!req.body?.code) return res.status(400).json({ error: 'Source code payload is required.' });
  const { code } = req.body;
  if (code.length > 500000) return res.status(413).json({ error: 'Source exceeds 500 KB limit.' });
  const id = req.requestId;
  try {
    queueCompileTask(async () => {
      const sessionPath = getSessionPath();
      const buildDir = getSessionBuildDir();
      const logDir = getSessionLogDir();
      
      logger.info(`Compiling Tact contract in session ${state.currentSession} (${code.length} chars)...`, id);
      wsBroadcast('log', `[${id}] Compilation started for session ${state.currentSession}`);
      
      const fileName = 'contract.tact';
      const fullFilePath = path.join(sessionPath, fileName);
      fs.writeFileSync(fullFilePath, code, 'utf8');
      logger.debug(`Saved source to ${fullFilePath}`, id);
      
      const t0  = Date.now();
      
      // Use temporary config for compilation
      const tempConfigPath = path.join(sessionPath, `api_temp_config.json`);
      const tempConfig = {
          projects: [{
              name: 'Target',
              path: `./${fileName}`,
              output: './build',
              options: { debug: true, external: true }
          }]
      };
      fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));
      logger.debug(`Created temporary config: ${tempConfigPath}`, id);

      try {
        const cmd = 'npx tact --config api_temp_config.json 2>&1';
        logger.trace(`Exec: ${cmd}`, id);
        const out = execSync(cmd, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
        const dur = Date.now() - t0;
        const log = out.toString();
        
        wsBroadcast('compile-success', `Compiled in ${dur}ms`);
        fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] OK (${dur}ms)\n${log}\n---\n`);
        logger.info(`Compilation OK in ${dur}ms`, id);
        logger.trace(`Compiler Output:\n${log}`, id);

        const artifacts = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
        logger.debug(`Generated ${artifacts.length} artifacts in ${buildDir}`, id);
        
        const resData = { success: true, duration: dur, log, artifacts };

        const bocFile = artifacts.find(f => f.endsWith('.code.boc'));
        if (bocFile) {
            try {
                const boc = fs.readFileSync(path.join(buildDir, bocFile));
                resData.bytecodeSize = boc.length;
                resData.bytecodeHash = crypto.createHash('sha256').update(boc).digest('hex');
                logger.debug(`BOC Size: ${resData.bytecodeSize} bytes, Hash: ${resData.bytecodeHash}`, id);
            } catch (e) { logger.warn('Failed to read BOC for metrics', id, e); }
        }

        res.json(resData);
        } finally {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
            logger.trace(`Cleanup temporary config: ${tempConfigPath}`, id);
        }
    }).catch((e) => {
      const errLog = e.stdout ? e.stdout.toString('utf8') : e.message;
      const logDir = getSessionLogDir();
      logger.error(`Compilation FAILED: ${errLog}`, id, e);
      wsBroadcast('compile-error', errLog);
      fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
      res.status(400).json({ error: errLog });
    });
  } catch (e) {
    const errLog = e.stdout ? e.stdout.toString('utf8') : e.message;
    const logDir = getSessionLogDir();
    logger.error(`Compilation Error (Synchronous): ${errLog}`, id, e);
    wsBroadcast('compile-error', errLog);
    fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
    res.status(400).json({ error: errLog });
  }
});

app.get('/api/abi', requireInit, (req, res) => {
  const { contractName } = req.query;
  if (!contractName) return res.status(400).json({ error: 'contractName is required.' });
  
  const buildDir = getSessionBuildDir();
  let baseName = contractName;
  let abiPath = path.join(buildDir, `${baseName}.abi`);
  
  // Fallback if the user provided just the contract name without project prefix
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

app.get('/api/contracts', requireInit, (req, res) => {
  const buildDir = getSessionBuildDir();
  if (!fs.existsSync(buildDir)) return res.json({ contracts: [] });
  try {
    const files = fs.readdirSync(buildDir);
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
  const { contractName, args } = req.body;
  try {
    logger.info(`Deploying ${contractName || 'default'} to ${NETWORK} in session ${state.currentSession}...`, id);
    wsBroadcast('log', `[${id}] Deploy sequence started for ${contractName || 'default'}`);
    
    const buildDir = getSessionBuildDir();
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

    // If args are provided, try to pack them using ABI
    if (args && fs.existsSync(abiPath)) {
        try {
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            if (abi.init && abi.init.arguments) {
                const builder = beginCell();
                abi.init.arguments.forEach(f => packField(builder, f, args[f.name], abi));
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
    const addrStr = address.toString({ testOnly: IS_TESTNET });
    
    const seqno = await withRetry(async () => {
      const endpoint = await getEndpoint();
      const activeClient = createTonClient(endpoint);
      logger.debug(`Checking balance for ${devWallet.address.toString({ testOnly: IS_TESTNET })} on endpoint ${endpoint}`, id);
      const balance = await activeClient.getBalance(devWallet.address);
      logger.debug(`Balance found: ${balance}`, id);

      if (balance < 50000000n) { 
          throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON.`);
      }

      const contract = activeClient.open(devWallet);
      let s = 0;
      try { s = await contract.getSeqno(); } catch (e) { s = 0; }

      await contract.sendTransfer({
        seqno: s, secretKey: walletKey.secretKey,
        messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
      });
      return s;
    }, 10, id);

    getSession().deployed[baseName] = addrStr;
    const tx = { type: 'deploy', address: addrStr, ts: new Date().toISOString(), seqno };
    addHistory(tx);
    wsBroadcast('deploy-success', addrStr);
    
    res.json({ address: addrStr, network: NETWORK, seqno });
  } catch (e) {
    wsBroadcast('deploy-error', e.message);
    logger.error(`Deploy failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});


function packField(builder, field, value, abi) {
  const type = field.type;
  if (type.kind !== 'simple') throw new Error(`Unsupported field kind: ${type.kind}`);
  
  const format = field.type.format;
  const typeName = field.type.type;
  const isOptional = !!field.type.optional;

  logger.trace(`Packing field ${field.name} (${typeName}, format: ${format}, optional: ${isOptional}) with value: ${JSON.stringify(value)}`);

  try {
    if (isOptional) {
      if (value === undefined || value === null || value === '') {
        logger.trace(`Optional field ${field.name} is empty, storing bit 0`);
        builder.storeBit(0);
        return;
      }
      builder.storeBit(1);
      logger.trace(`Optional field ${field.name} has value, stored bit 1`);
    }

    switch (typeName) {
      case 'int':
      case 'uint': {
        if (value === undefined || value === null || value === '') {
          throw new Error(`Value for field "${field.name}" is required`);
        }
        const bits = typeof format === 'number' ? format : (format === 'coins' ? 124 : 257);
        if (format === 'coins') {
          logger.trace(`Storing coins: ${value}`);
          builder.storeCoins(BigInt(value));
        } else {
          logger.trace(`Storing ${typeName} (${bits} bits): ${value}`);
          if (typeName === 'uint') builder.storeUint(BigInt(value), bits);
          else builder.storeInt(BigInt(value), bits);
        }
        break;
      }
      case 'address': {
        if (!value) throw new Error(`Address for field "${field.name}" is required`);
        try {
          const normalized = String(value).trim().replace(/\+/g, '-').replace(/\//g, '_');
          const parsed = Address.parseFriendly(normalized);
          logger.trace(`Storing address: ${parsed.address.toString()}`);
          builder.storeAddress(parsed.address);
        } catch (e) {
          throw new Error(`Invalid address for "${field.name}": ${e.message}`);
        }
        break;
      }
      case 'bool': {
        const boolVal = value === true || value === 'true' || value === '1';
        logger.trace(`Storing bool: ${boolVal}`);
        builder.storeBit(boolVal);
        break;
      }
      case 'string': {
        const strVal = String(value || '');
        logger.trace(`Storing string: "${strVal}"`);
        const cell = beginCell().storeStringTail(strVal).endCell();
        builder.storeRef(cell);
        break;
      }
      case 'fixed-bytes': {
        const size = typeof format === 'number' ? format : 32;
        let buf;
        if (typeof value === 'string') {
          buf = Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex');
        } else if (Buffer.isBuffer(value)) {
          buf = value;
        } else {
          throw new Error(`Expected hex string or Buffer for "${field.name}"`);
        }
        if (buf.length !== size) throw new Error(`Expected ${size} bytes for "${field.name}", got ${buf.length}`);
        logger.trace(`Storing ${size} fixed-bytes: ${buf.toString('hex')}`);
        builder.storeBuffer(buf);
        break;
      }
      case 'slice':
      case 'cell': {
        if (!value) {
          if (typeName === 'cell') {
              logger.trace(`Empty cell for ${field.name}, storing empty cell ref`);
              builder.storeRef(beginCell().endCell());
          }
          else throw new Error(`Value for field "${field.name}" (slice) is required`);
        } else {
          try {
            const cell = Cell.fromBoc(Buffer.from(value, 'hex'))[0];
            logger.trace(`Storing ${typeName} from BOC: ${value.slice(0, 64)}...`);
            if (typeName === 'cell') builder.storeRef(cell);
            else builder.storeSlice(cell.beginParse());
          } catch (e) {
            throw new Error(`Invalid hex/BOC for "${field.name}": ${e.message}`);
          }
        }
        break;
      }
      default: {
        // Handle nested structs
        const nestedType = abi && abi.types ? abi.types.find(t => t.name === typeName) : null;
        if (nestedType) {
          logger.trace(`Packing nested struct ${typeName} for field ${field.name}`);
          if (typeof value !== 'object' || value === null) {
            throw new Error(`Expected object for nested type "${typeName}" in field "${field.name}"`);
          }
          nestedType.fields.forEach(f => {
            packField(builder, f, value[f.name], abi);
          });
        } else {
          throw new Error(`Unsupported type: ${typeName}`);
        }
      }
    }
  } catch (e) {
    if (e.message.includes('field "') || e.message.includes('for "')) throw e;
    throw new Error(`Error packing field "${field.name}": ${e.message}`);
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
      logger.info(`Encoding typed message ${type} for ${contractName} in session ${state.currentSession}`, id);
      const buildDir = getSessionBuildDir();
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
              packField(builder, f, args[f.name], abi);
          });
      }
      body = builder.endCell();
    } else {
      logger.info(`Encoding text message: "${message}"`, id);
      body = beginCell().storeUint(0, 32).storeStringTail(message).endCell();
    }

    logger.info(`Sending transaction to ${target} (${sendValue} TON)...`, id);
    wsBroadcast('log', `[${id}] Sending ${type || message} to ${target}`);
    
    const seqno = await withRetry(async () => {
      const endpoint = await getEndpoint();
      const activeClient = createTonClient(endpoint);
      const balance = await activeClient.getBalance(devWallet.address);
      if (balance < 25000000n) {
          throw new Error(`Insufficient funds on ${devWallet.address.toString({ testOnly: IS_TESTNET })}`);
      }

      const contract = activeClient.open(devWallet);
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

      await contract.sendTransfer({        seqno: s, secretKey: walletKey.secretKey,
        messages: [internal({ to: target, value: sendValue, bounce: true, body })]
      });
      return s;
    }, 10, id);

    const tx = { type: 'interact', target, message: type || message, value: sendValue, ts: new Date().toISOString(), seqno };
    addHistory(tx);
    wsBroadcast('interact-success', `${type || '"' + message + '"'} sent to ${target}`);
    logger.info(`Interaction successful. Seqno: ${seqno}`, id);
    res.json({ success: true, seqno });
  } catch (e) {
    wsBroadcast('interact-error', e.message);
    logger.error(`Interaction failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});

function decodeStackItem(item, typeName) {
  if (!item) return null;
  if (item.type === 'int') {
    const val = item.value;
    return (val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER)) 
      ? Number(val) 
      : val.toString();
  }
  if (item.type === 'cell') {
    if (typeName === 'string') {
      try { return item.cell.beginParse().loadStringTail(); } catch (e) { return '[Invalid String Cell]'; }
    }
    return '[Cell]';
  }
  if (item.type === 'slice') {
    if (typeName === 'address') {
      try { return item.cell.beginParse().loadAddress().toString({ testOnly: IS_TESTNET }); } catch (e) { return '[Invalid Address Slice]'; }
    }
    if (typeName === 'string') {
        try { return item.cell.beginParse().loadStringTail(); } catch (e) { return '[Invalid String Slice]'; }
    }
    return '[Slice]';
  }
  return item.value;
}

app.post('/api/getter', heavyLimiter, requireInit, async (req, res) => {
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

    const result = await withRetry(async () => {
      const endpoint = await getEndpoint();
      const client = createTonClient(endpoint);
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
            const buildDir = getSessionBuildDir();
            const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${contractName}.abi`), 'utf8'));
            const getterDef = abi.getters.find(g => g.name === method);
            if (getterDef && getterDef.returnType) {
                // Return type can be a single type or a struct
                returnTypes = [getterDef.returnType.type];
            }
        } catch (e) { logger.debug(`Could not load ABI for return type decoding: ${e.message}`); }
    }

    const resultStack = result.stack.items.map((i, idx) => decodeStackItem(i, returnTypes[idx]));
    
    logger.info(`Getter ${method} success. Result stack length: ${resultStack.length}`, id);
    res.json({ success: true, stack: resultStack });
  } catch (e) {
    logger.error(`Getter failed: ${e.message}`, id, e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/tx-history', requireInit, (req, res) => {
  logger.debug('Fetching transaction history', req.requestId);
  res.json({ history: getSession().txHistory || [] });
});

app.delete('/api/session', requireInit, (req, res) => {
  const session = getSession();
  session.deployed = {};
  session.txHistory = [];
  const buildDir = getSessionBuildDir();
  if (fs.existsSync(buildDir)) {
      try {
          fs.rmSync(buildDir, { recursive: true, force: true });
          fs.mkdirSync(buildDir, { recursive: true });
      } catch (e) { logger.error('Failed to clear build dir', '', e); }
  }
  saveState();
  res.json({ success: true });
});

app.get('/api/artifacts', requireInit, (req, res) => {
  const buildDir = getSessionBuildDir();
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

app.get('/api/files', (req, res) => {
  try {
    const sessionPath = getSessionPath();
    logger.debug(`Listing source files in session ${state.currentSession}`, req.requestId);
    const files = fs.readdirSync(sessionPath).filter(f => f.endsWith('.tact'));
    res.json({ files });
  } catch (e) { 
    logger.error('Failed to list files', req.requestId, e);
    res.status(500).json({ error: e.message }); 
  }
});

app.get('/api/file', (req, res) => {
  const { name } = req.query;
  if (!name || !name.endsWith('.tact')) return res.status(400).json({ error: 'Invalid file name.' });
  const id = req.requestId;
  try {
    const sessionPath = getSessionPath();
    logger.info(`Reading source file ${name} from session ${state.currentSession}`, id);
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

// ─── 404 & Global Error Handler ───────────────────────────────────────────
app.use((req, res) => {
  logger.warn(`404 Not Found: ${req.method} ${req.path}`, req.requestId);
  res.status(404).json({ error: `${req.method} ${req.path} not found.` });
});
app.use((err, req, res, _next) => {
  logger.error('Unhandled request error', req.requestId, err);
  res.status(500).json({ error: 'Internal server error.', requestId: req.requestId });
});

// ─── Boot & Graceful Shutdown ─────────────────────────────────────────────
init().then(() => {
  server.listen(PORT);
  
  if (BOT_TOKEN) {
    const bot = new TelegramBot(BOT_TOKEN, { polling: true });
    pollingBotInstance = bot;
    logger.info('Telegram Bot (TemixIDE) active.');

    // General Bot Activity Logger
    bot.on('message', (msg) => {
        logger.debug(`Bot Message: from=${msg.from.id} (@${msg.from.username || 'N/A'}) text="${msg.text || '[non-text]'}"`);
        if (msg.document) {
            logger.debug(`Bot Document: name=${msg.document.file_name} mime=${msg.document.mime_type} size=${msg.document.file_size}`);
        }
    });

    bot.on('callback_query', (query) => {
        logger.debug(`Bot Callback: from=${query.from.id} (@${query.from.username || 'N/A'}) data="${query.data}"`);
    });

    const isAuthorized = (msg) => {
      const authorized = state.authorizedUsers.length === 0 || state.authorizedUsers.includes(String(msg.from.id));
      if (!authorized) logger.warn(`Unauthorized access attempt from ${msg.from.id} (@${msg.from.username})`);
      return authorized;
    };

    const getMainMenu = () => ({
      reply_markup: {
        keyboard: [
          [{ text: '📂 Forge' }, { text: '📂 Contract' }],
          [{ text: '📂 Workspace' }, { text: '📂 Account' }],
          [{ text: '📂 Sessions' }, { text: '✨ AI Forge' }]
        ],
        resize_keyboard: true,
        is_persistent: true
      },
      parse_mode: 'HTML'
    });

    const userState = {}; 
    const USER_STATE_TTL_MS = 5 * 60 * 1000;

    const setUserState = (chatId, data) => {
      logger.debug(`Setting user state for ${chatId}: ${data.action}`);
      userState[chatId] = { ...data, updatedAt: Date.now() };
    };
    const clearUserState = (chatId) => {
      logger.debug(`Clearing user state for ${chatId}`);
      delete userState[chatId];
    };
    const getUserState = (chatId) => {
      const entry = userState[chatId];
      if (!entry) return null;
      if ((Date.now() - entry.updatedAt) > USER_STATE_TTL_MS) {
        logger.debug(`Expiring user state for ${chatId}`);
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
1. ✨ <b>AI Forge:</b> Generate smart contracts using DeepSeek AI.
2. 📂 <b>Forge:</b> Compile your .tact files and manage artifacts.
3. 📂 <b>Contract:</b> Deploy and interact with live contracts.
4. 📂 <b>Workspace:</b> Manage your files and project history.
5. 📂 <b>Account:</b> Check your wallet balance and credentials.

<i>Tip: You can send any .tact file to this bot to add it to your project instantly.</i>
      `;
      bot.sendMessage(msg.chat.id, welcome, { ...getMainMenu(), parse_mode: 'HTML' });
    });

    bot.setMyCommands([
        { command: 'menu', description: 'Show main menu' },
        { command: 'compile', description: 'Compile .tact files' },
        { command: 'deploy', description: 'Deploy compiled BOC' },
        { command: 'wallet', description: 'Check wallet status' },
        { command: 'history', description: 'View transaction history' },
        { command: 'help', description: 'Show help guide' }
    ]);

    const handleMenuAction = async (bot, chatId, data, query) => {
      const isQuery = !!(query && query.id);
      const messageId = (isQuery && query.message) ? query.message.message_id : null;
      logger.debug(`Menu action: ${data} (chat: ${chatId})`);

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
          const text = `📂 <b>Forge</b>\nFocuses on the creation and "building" phase of your project.\n\n🔨 <b>Compile:</b> The primary engine for building your code.\n✨ <b>AI Forge:</b> Generate smart contracts using DeepSeek AI.\n📦 <b>Artifacts:</b> Where your compiled BOC (Bag of Cells) and ABI files live.\n📜 <b>Logs:</b> Essential for debugging compilation errors or build outputs.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔨 Compile', callback_data: 'compile_menu' }, { text: '✨ AI Forge', callback_data: 'ai_forge_menu' }],
                [{ text: '📦 Artifacts', callback_data: 'artifacts_menu' }],
                [{ text: '📜 Logs', callback_data: 'logs_menu' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'ai_forge_menu') {
          setUserState(chatId, { action: 'awaiting_ai_prompt' });
          const text = `✨ <b>AI Forge — Smart Contract Generation</b>\n\nDescribe the contract you want to create. Be as specific as possible about state variables, messages, and logic.\n\n<b>Example:</b>\n<i>"Create a lottery contract where users can buy tickets for 1 TON. After 10 users join, a random winner is selected and gets the entire balance."</i>`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'forge_menu' }]]
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
        else if (data === 'sessions_menu') {
          const sessions = Object.keys(state.sessions || {});
          const text = `📂 <b>Sessions</b>\nManage your project sessions. Current: <code>${state.currentSession}</code>\n\n<i>Note: Deleting a session permanently removes all its files and history.</i>`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                ...sessions.map(s => [
                  { text: `${s === state.currentSession ? '✅ ' : ''}${s}`, callback_data: `switch_session:${getShort(s)}` },
                  ...(s !== 'default' ? [{ text: '🗑', callback_data: `confirm_del_session:${getShort(s)}` }] : [])
                ]),
                [{ text: '➕ New Session', callback_data: 'create_session' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
        else if (data === 'create_session') {
          setUserState(chatId, { action: 'awaiting_session_name' });
          await bot.sendMessage(chatId, "➕ <b>Enter name for new session:</b>", { parse_mode: 'HTML' });
        }
        else if (data === 'wallet') {
          const balance = await withRetry(async () => {
              const endpoint = await getEndpoint();
              const client = createTonClient(endpoint);
              return await client.getBalance(devWallet.address);
          });
          const addr = devWallet.address.toString({ testOnly: IS_TESTNET });
          const text = `💳 *Wallet Status*\n\n*Address:* \`${addr}\`\n*Balance:* \`${(Number(balance) / 1e9).toFixed(4)} TON\`\n*Network:* ${NETWORK.toUpperCase()}\n\n*Note:* Balance may take a few seconds to update after transactions.`;
          await sendOrEdit(text, {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🗝 View Seed Phrase', callback_data: 'view_seed' }],
                [{ text: '🗑 Reset Wallet', callback_data: 'confirm_reset' }],
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'view_seed') {
          if (!fs.existsSync(WALLET_FILE)) return bot.sendMessage(chatId, "❌ No wallet file found.");
          const w = JSON.parse(fs.readFileSync(WALLET_FILE, 'utf8'));
          const mnemonic = Array.isArray(w.mnemonic) ? w.mnemonic.join(' ') : w.mnemonic;
          await bot.sendMessage(chatId, `⚠️ <b>SECURITY WARNING</b>\nYour seed phrase is the key to your wallet. Never share it!\n\n<code>${mnemonic}</code>\n\n<i>This message will self-destruct (not really, but please delete it after viewing).</i>`, { parse_mode: 'HTML' });
        }

        else if (data === 'confirm_reset') {
          await sendOrEdit("⚠️ <b>Are you sure?</b>\nThis will discard your wallet and create a new one with 2 testnet TON (after funding). Continue?", {
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Yes, Reset', callback_data: 'do_reset' }],
                [{ text: '❌ Cancel', callback_data: 'wallet' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'do_confirmed_tx') {
            try {
                const stateData = getUserState(chatId);
                if (!stateData || !stateData.target) {
                    if (isQuery) bot.answerCallbackQuery(query.id, { text: "Session expired.", show_alert: true });
                    return bot.sendMessage(chatId, "❌ Session expired.");
                }
                
                if (isQuery) bot.answerCallbackQuery(query.id, { text: "Transaction confirmed. Signing..." });
                const { target, method, type, contractName, args, action } = stateData;
                clearUserState(chatId);

                if (action === 'confirm_call') {
                    await handleCallGetter(chatId, target, method, contractName, args);
                } else {
                    await handleSendMessage(chatId, target, type, contractName, args);
                }
            } catch (e) {
                logger.error('Error in do_confirmed_tx', '', e);
                bot.sendMessage(chatId, `❌ <b>Action Failed</b>\n\n${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
            }
        }
        else if (data === 'do_reset') {
          try {
            if (!fs.existsSync(WALLET_FILE)) throw new Error('No wallet file.');
            const backup = WALLET_FILE.replace('.json', `.backup-${Date.now()}.json`);
            fs.copyFileSync(WALLET_FILE, backup);
            fs.unlinkSync(WALLET_FILE);
            logger.info(`Wallet reset via bot. Backup: ${backup}`);
            await sendOrEdit(`✅ *Wallet reset successfully.*\nBackup created: \`${path.basename(backup)}\`\n\n*Please restart the server process manually.*`, { parse_mode: 'Markdown' });
          } catch (e) { 
            logger.error('Wallet reset failed', '', e);
            bot.sendMessage(chatId, "❌ Reset failed: " + e.message); 
          }
        }

        else if (data === 'compile_menu') {
          const sessionPath = getSessionPath();
          const files = fs.readdirSync(sessionPath).filter(f => f.endsWith('.tact'));
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No .tact files found in this session.");
          
          await sendOrEdit(`🔨 <b>Select file to compile:</b>\nSession: <code>${state.currentSession}</code>`, {
            reply_markup: {
              inline_keyboard: [
                ...files.map(f => [{ text: `📄 ${f}`, callback_data: `do_compile:${getShort(f)}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data === 'deploy_menu') {
          const buildDir = getSessionBuildDir();
          if (!fs.existsSync(buildDir)) return bot.sendMessage(chatId, "❌ No builds found. Compile first.");
          const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.code.boc'));
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No compiled artifacts found.");

          await sendOrEdit("🚀 <b>Select contract to deploy:</b>", {
            reply_markup: {
              inline_keyboard: [
                ...files.map(f => {
                  const name = f.replace('.code.boc', '');
                  return [{ text: `🚀 Deploy ${name}`, callback_data: `prep_manual_deploy:${getShort(name)}` }];
                }),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }
// ... (omitting intermediate for brevity, but I will include it in the actual tool call)


        else if (data === 'interact_menu') {
          const contracts = Object.keys(getSession().deployed);

          await sendOrEdit("🎮 <b>Select contract to interact with:</b>", {
            reply_markup: {
              inline_keyboard: [
                ...contracts.map(c => [{ text: `🕹 ${c}`, callback_data: `int_methods:${getShort(c)}` }]),
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
          const contracts = Object.keys(getSession().deployed);
          if (contracts.length === 0) return bot.sendMessage(chatId, "❌ No deployed contracts. Deploy one first!");

          await sendOrEdit("🔍 *Select contract to query:*", {
            reply_markup: {
              inline_keyboard: [
                ...contracts.map(c => [{ text: `📜 ${c}`, callback_data: `get_methods:${getShort(c)}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'files_list') {
          const files = fs.readdirSync(getSessionPath()).filter(f => f.endsWith('.tact'));
          await sendOrEdit(`📁 *Project Files:* (Total: ${files.length})`, {
            reply_markup: { 
              inline_keyboard: [
                ...files.map(f => [{ text: `📄 ${f}`, callback_data: `view_file:${getShort(f)}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ] 
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'logs_menu') {
          const logFiles = fs.readdirSync(getSessionLogDir()).filter(f => f.endsWith('.log'));
          await sendOrEdit("📜 *Select log to view:*", {
            reply_markup: {
              inline_keyboard: [
                ...logFiles.map(f => [{ text: `📜 ${f}`, callback_data: `view_log:${getShort(f)}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'artifacts_menu') {
          const bdir = getSessionBuildDir();
          if (!fs.existsSync(bdir)) return bot.sendMessage(chatId, "❌ No build directory found.");
          const files = fs.readdirSync(bdir);
          if (files.length === 0) return bot.sendMessage(chatId, "❌ No artifacts found.");
          
          await sendOrEdit("📦 *Build Artifacts:*", {
            reply_markup: {
              inline_keyboard: [
                ...files.slice(0, 10).map(f => [{ text: `📄 ${f}`, callback_data: `view_art:${getShort(f)}` }]),
                [{ text: '⬅️ Back', callback_data: 'menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data === 'history') {
          const history = getSession().txHistory || [];
          const text = history.length > 0 
            ? `📋 *Recent Transactions:*\n\n${history.slice(0, 10).map(t => `• *\`${t.type}\`* \`${t.target || t.address}\` \n  _${new Date(t.ts).toLocaleTimeString()}_`).join('\n\n')}`
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

<b>📂 Forge & ✨ AI</b>
• Use <b>AI Forge</b> to generate Tact contracts from natural language.
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
        logger.error(`Menu Action Error: ${data}`, '', e);
        if (isQuery) bot.answerCallbackQuery(msgOrQuery.id, { text: "Error: " + e.message, show_alert: true });
        else bot.sendMessage(chatId, "❌ Error: " + e.message);
      }
    };

    bot.on('callback_query', async (query) => {
      if (!isAuthorized(query)) return bot.answerCallbackQuery(query.id, { text: "Unauthorized", show_alert: true });
      
      const chatId = query.message.chat.id;
      const data = query.data;
      logger.debug(`Callback query: ${data} from ${query.from.id}`);

      // Answer immediately to avoid "query is too old" error during long RPC retries
      bot.answerCallbackQuery(query.id).catch(() => {});

      try {
        // Handle simple menu navigation first
        const simpleActions = ['forge_menu', 'ai_forge_menu', 'contract_menu', 'workspace_menu', 'account_menu', 'sessions_menu', 'create_session', 'wallet', 'view_seed', 'confirm_reset', 'do_confirmed_tx', 'do_reset', 'compile_menu', 'deploy_menu', 'interact_menu', 'prep_manual_int', 'health_check', 'getters_menu', 'files_list', 'logs_menu', 'artifacts_menu', 'history', 'help', 'menu'];
        if (simpleActions.includes(data)) {
            return handleMenuAction(bot, chatId, data, query);
        }

        else if (data === 'do_multi_generate') {
          const stateData = getUserState(chatId);
          if (!stateData || !stateData.plan) return bot.sendMessage(chatId, "❌ Plan expired or not found. Please try again.");

          const plan = stateData.plan;
          const statusMessageId = stateData.statusMessageId;
          clearUserState(chatId);

          bot.sendMessage(chatId, `🔄 <b>Temix IDE: Starting multi-contract generation (${plan.length} files)...</b>`, { parse_mode: 'HTML' });

          // Generate them sequentially to avoid rate limits and for cleaner chat history
          (async () => {
              for (let i = 0; i < plan.length; i++) {
                  const contractInfo = plan[i];
                  const tempStatus = await bot.sendMessage(chatId, `🧠 <b>Temix IDE: Working on ${i+1}/${plan.length} - ${contractInfo.name}...</b>`, { parse_mode: 'HTML' });
                      await executeContractGeneration(bot, chatId, contractInfo.prompt, tempStatus.message_id);
              }
              bot.sendMessage(chatId, "✅ <b>Multi-contract generation complete!</b>", { parse_mode: 'HTML' });
          })();
        }

        else if (data === 'cancel_multi_generate') {
            const stateData = getUserState(chatId);
            if (stateData && stateData.statusMessageId) {
                try { await bot.deleteMessage(chatId, stateData.statusMessageId); } catch(e){}
            }
            clearUserState(chatId);
            bot.sendMessage(chatId, "❌ <b>Multi-contract generation cancelled.</b>", { parse_mode: 'HTML' });
        }

        else if (data.startsWith('do_compile:')) {

          const fileName = getLong(data.split(':')[1]);
          logger.info(`Bot requested compile: ${fileName} (Session: ${state.currentSession})`);
          bot.sendMessage(chatId, `🔨 <b>Compiling ${fileName}...</b>`, { parse_mode: 'HTML' });
          queueCompileTask(async () => {
            const sessionPath = getSessionPath();
            const buildDir = getSessionBuildDir();
            
            // Save as contract.tact in session path for compatibility
            fs.writeFileSync(path.join(sessionPath, 'contract.tact'), fs.readFileSync(path.join(sessionPath, fileName))); 
            getSession().lastFile = fileName; saveState();
            
            const t0 = Date.now();
            const tempConfigPath = path.join(sessionPath, `temp_${fileName}.json`);
            const projectName = `Target_${fileName.replace('.tact', '')}`;
            const tempConfig = {
                projects: [{
                    name: projectName,
                    path: `./${fileName}`,
                    output: './build',
                    options: { debug: true, external: true }
                }]
            };
            fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));

            try {
                // Execute tact in the session directory
                execSync(`npx tact --config temp_${fileName}.json 2>&1`, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
                const dur = Date.now() - t0;
                const artifacts = fs.existsSync(buildDir) ? fs.readdirSync(buildDir).filter(f => f.startsWith(projectName)) : [];
                
                logger.info(`Bot compile OK: ${fileName} (${dur}ms)`);
                const firstContract = artifacts.find(a => a.endsWith('.code.boc'));
                const reply_markup = { inline_keyboard: [] };
                if (firstContract) {
                    const cName = firstContract.replace('.code.boc', '');
                    reply_markup.inline_keyboard.push([{ text: `🚀 Deploy ${cName} Now`, callback_data: `prep_manual_deploy:${getShort(cName)}` }]);
                }
                reply_markup.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu' }]);

                bot.sendMessage(chatId, `✅ <b>Compiled ${fileName} in ${dur}ms</b>\n\n<b>Artifacts:</b> ${artifacts.map(a => `<code>${a.replace('.code.boc','')}</code>`).join(', ')}`, { 
                    parse_mode: 'HTML',
                    reply_markup
                });
            } finally {
                if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
            }
          }).catch((e) => {
            const err = e.stdout ? e.stdout.toString('utf8') : e.message;
            logger.error(`Bot compile FAIL: ${fileName} - ${err}`, '', e);
            bot.sendMessage(chatId, `❌ <b>Compilation Failed</b>\n\n<pre>${escapeHtml(err.slice(0, 3000))}</pre>`, { parse_mode: 'HTML' });
          });
        }

        else if (data.startsWith('switch_session:')) {
          const sessionName = getLong(data.split(':')[1]);
          state.currentSession = sessionName;
          saveState();
          bot.sendMessage(chatId, `✅ Switched to session: <code>${sessionName}</code>`, { parse_mode: 'HTML' });
          handleMenuAction(bot, chatId, 'sessions_menu', query);
        }

        else if (data.startsWith('confirm_del_session:')) {
          const sessionName = getLong(data.split(':')[1]);
          bot.editMessageText(`⚠️ <b>Are you sure?</b>\nDeleting session <code>${sessionName}</code> will permanently erase all its files and deployment history.`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [
                [{ text: '✅ Yes, Delete', callback_data: `do_del_session:${getShort(sessionName)}` }],
                [{ text: '❌ Cancel', callback_data: 'sessions_menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data.startsWith('do_del_session:')) {
          const sessionName = getLong(data.split(':')[1]);
          if (sessionName === 'default') return bot.answerCallbackQuery(query.id, { text: "Cannot delete default session", show_alert: true });
          
          try {
            const sessionPath = path.join(SESSIONS_DIR, sessionName);
            if (fs.existsSync(sessionPath)) {
                fs.rmSync(sessionPath, { recursive: true, force: true });
            }
            
            delete state.sessions[sessionName];
            if (state.currentSession === sessionName) {
                state.currentSession = 'default';
            }
            saveState();
            
            bot.answerCallbackQuery(query.id, { text: `Session ${sessionName} deleted.` });
            handleMenuAction(bot, chatId, 'sessions_menu', query);
          } catch (e) {
            logger.error(`Failed to delete session ${sessionName}`, '', e);
            bot.sendMessage(chatId, `❌ Failed to delete session: ${e.message}`);
          }
        }

        else if (data.startsWith('do_deploy:')) {
          const name = getLong(data.split(':')[1]);
          await handleDoDeploy(chatId, name);
        }

        else if (data.startsWith('prep_manual_deploy:')) {
          const name = getLong(data.split(':')[1]);
          const buildDir = getSessionBuildDir();
          const abiPath = path.join(buildDir, `${name}.abi`);
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, "❌ ABI not found for " + name);

          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const initDef = abi.init;
          if (!initDef || !initDef.arguments || initDef.arguments.length === 0) {
              return handleDoDeploy(chatId, name);
          }

          setUserState(chatId, { action: 'awaiting_deploy_args', contractName: name });
          const args = initDef.arguments.map(a => `\`${a.name}\` (${a.type.type})`).join('\n');
          const cmdExample = `/deploy_${name} {\n  ${initDef.arguments.map(a => `"${a.name}": ...`).join(',\n  ')}\n}`;

          bot.sendMessage(chatId, `🚀 *Manual Deploy:* \`${name}\`\n📝 *Enter initialization arguments:*\n\nFormat as JSON OR use command:\n\`\`\`\n${cmdExample}\n\`\`\`\n\n*Required Arguments:*\n${args}`, { parse_mode: 'Markdown' });
        }
        else if (data.startsWith('int_methods:')) {
          const name = getLong(data.split(':')[1]);
          const buildDir = getSessionBuildDir();
          const abiPath = path.join(buildDir, `${name}.abi`);
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, "❌ ABI not found for " + name);
          
          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const receivers = abi.receivers || [];
          const session = getSession();
          
          bot.editMessageText(`🎮 <b>Actions for ${name}:</b>\nAddress: <code>${session.deployed[name]}</code>`, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [
                ...receivers.filter(r => r.receiver === 'external' || r.receiver === 'internal').map(r => {
                    const label = r.message.type === 'text' ? `"${r.message.text}"` : r.message.type;
                    return [{ text: `✉️ ${label}`, callback_data: `prep_int:${getShort(name)}:${getShort(r.message.type)}:${getShort(r.message.text || '')}` }];
                }),
                [{ text: '🤖 AI Explain Code', callback_data: `ai_explain:${getShort(name)}` }],
                [{ text: '⬅️ Back', callback_data: 'interact_menu' }]
              ]
            },
            parse_mode: 'HTML'
          });
        }

        else if (data.startsWith('prep_int:')) {
          const [, sName, sType, sText] = data.split(':');
          const name = getLong(sName);
          const type = getLong(sType);
          const text = getLong(sText);
          const session = getSession();
          const addr = session.deployed[name];
          logger.debug(`Bot prep interact: ${name} (${type})`);
          
          if (type === 'text') {
              // Immediate action for text messages
              bot.sendMessage(chatId, `Sending "${text}" to ${name}...`);
              try {
                  const body = beginCell().storeUint(0, 32).storeStringTail(text).endCell();
                  const seqno = await withRetry(async () => {
                      const endpoint = await getEndpoint();
                      const activeClient = createTonClient(endpoint);

                      const balance = await activeClient.getBalance(devWallet.address);
                      if (balance < 50000000n) {
                          throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON. Please fund your wallet ${devWallet.address.toString({ testOnly: IS_TESTNET })} via a faucet.`);
                      }

                      const contract = activeClient.open(devWallet);
                      let s = 0; 
                      try { 
                          s = await contract.getSeqno(); 
                      } catch (e) {
                          const msg = e.message || '';
                          if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('429')) {
                              throw e; 
                          }
                          logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`);
                          s = 0; 
                      }
                      await contract.sendTransfer({
                          seqno: s, secretKey: walletKey.secretKey,
                          messages: [internal({ to: Address.parseFriendly(addr).address, value: '0.05', bounce: true, body })]
                      });
                      return s;
                  });
                  logger.info(`Bot interaction OK: text "${text}" to ${name}`);
                  const explorerUrl = `https://${IS_TESTNET?'testnet.':''}tonscan.org/search?q=${seqno}`;
                  bot.sendMessage(chatId, `✅ <b>Transaction Sent!</b>\nSeqno: <code>${seqno}</code>\n<a href="${explorerUrl}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
              } catch (e) { 
                logger.error(`Bot interaction FAIL: text "${text}"`, '', e);
                bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); 
              }
          } else {
              // Typed message - check if it has fields
              const buildDir = getSessionBuildDir();
              const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.abi`), 'utf8'));
              const typeDef = abi.types.find(t => t.name === type);
              if (typeDef && typeDef.fields && typeDef.fields.length > 0) {
                  setUserState(chatId, { action: 'awaiting_args', target: addr, type, contractName: name });
                  const fields = typeDef.fields.map(f => `\`${f.name}\` (${f.type.type})`).join('\n');
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
                          const client = createTonClient(endpoint);

                          const balance = await client.getBalance(devWallet.address);
                          if (balance < 50000000n) {
                              throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON. Please fund your wallet ${devWallet.address.toString({ testOnly: IS_TESTNET })} via a faucet.`);
                          }

                          const contract = client.open(devWallet);
                                                let s = 0; 
                      try { 
                          s = await contract.getSeqno(); 
                      } catch (e) {
                          const msg = e.message || '';
                          if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('429')) {
                              throw e; 
                          }
                          logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`);
                          s = 0; 
                      }
                          await contract.sendTransfer({
                              seqno: s, secretKey: walletKey.secretKey,
                              messages: [internal({ to: Address.parseFriendly(addr).address, value: '0.05', bounce: true, body })]
                          });
                          return s;
                      });
                      logger.info(`Bot interaction OK: type ${type} to ${name}`);
                      const explorerUrl = `https://${IS_TESTNET?'testnet.':''}tonscan.org/search?q=${seqno}`;
                      bot.sendMessage(chatId, `✅ <b>Transaction Sent!</b>\nSeqno: <code>${seqno}</code>\n<a href="${explorerUrl}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
                  } catch (e) { 
                    logger.error(`Bot interaction FAIL: type ${type}`, '', e);
                    bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); 
                  }
              }
          }
        }

        else if (data.startsWith('get_methods:')) {
          const name = getLong(data.split(':')[1]);
          const buildDir = getSessionBuildDir();
          const abiPath = path.join(buildDir, `${name}.abi`);
          if (!fs.existsSync(abiPath)) return bot.sendMessage(chatId, "❌ ABI not found for " + name);
          
          const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
          const getters = abi.getters || [];
          
          bot.editMessageText(`🔍 *Getters for* \`${name}\`*:*\nAddress: \`${getSession().deployed[name]}\``, {
            chat_id: chatId,
            message_id: query.message.message_id,
            reply_markup: {
              inline_keyboard: [
                ...getters.map(g => [{ text: `${g.name}()`, callback_data: `call_get:${getShort(name)}:${getShort(g.name)}` }]),
                [{ text: '⬅️ Back', callback_data: 'getters_menu' }]
              ]
            },
            parse_mode: 'Markdown'
          });
        }

        else if (data.startsWith('call_get:')) {
          const [, sName, sMethod] = data.split(':');
          const name = getLong(sName);
          const method = getLong(sMethod);
          const addr = getSession().deployed[name];
          const buildDir = getSessionBuildDir();
          const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${name}.abi`), 'utf8'));
          const getterDef = abi.getters.find(g => g.name === method);
          logger.debug(`Bot call getter: ${name}.${method}()`);
// ...
          
          if (getterDef && getterDef.arguments && getterDef.arguments.length > 0) {
              setUserState(chatId, { action: 'awaiting_getter_args', target: addr, method, contractName: name });
              const args = getterDef.arguments.map(a => `\`${a.name}\` (${a.type.type})`).join('\n');
              const cmdExample = `/call_get_${method} [${getterDef.arguments.map(() => '0').join(', ')}]`;
              
              bot.sendMessage(chatId, `*Temix IDE:*\n📝 *Enter arguments for* \`${method}\`\n\nFormat as JSON array OR use command:\n\`\`\`\n${cmdExample}\n\`\`\`\n\n*Required Arguments:*\n${args}`, { parse_mode: 'Markdown' });
          } else {
              try {
                const result = await withRetry(async () => {
                    const endpoint = await getEndpoint();
                    const client = createTonClient(endpoint);
                    return await client.runMethod(Address.parseFriendly(addr).address, method);
                });
                const stack = result.stack.items.map(i => {
                  if (i.type === 'int') return i.value.toString();
                  if (i.type === 'cell') return '[Cell]';
                  return i.type;
                });
                logger.info(`Bot getter OK: ${name}.${method}()`);
                bot.sendMessage(chatId, `📊 *Result:* \`${name}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(stack, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
              } catch (e) {
                logger.error(`Bot getter FAIL: ${name}.${method}()`, '', e);
                bot.sendMessage(chatId, `❌ *Call Failed:* ${e.message}`);
              }
          }
        }

        else if (data.startsWith('view_file:')) {
          const fileName = getLong(data.split(':')[1]);
          logger.debug(`Bot view file: ${fileName}`);
          try {
            const sessionPath = getSessionPath();
            const filePath = path.resolve(sessionPath, fileName);
            // Prevent path traversal from callback payload tampering.
            if (!filePath.startsWith(sessionPath + path.sep)) {
              return bot.sendMessage(chatId, "❌ Forbidden file path.");
            }
            if (!fs.existsSync(filePath)) return bot.sendMessage(chatId, "❌ File not found in session.");

            const content = fs.readFileSync(filePath, 'utf8');
            bot.sendMessage(chatId, `📄 *File:* \`${fileName}\`\n\n\`\`\`tact\n${content.slice(0, 3900)}\n\`\`\``, {
              parse_mode: 'Markdown',
              reply_markup: { 
                inline_keyboard: [[
                  { text: '🔨 Compile', callback_data: `do_compile:${getShort(fileName)}` },
                  { text: '✨ AI Explain', callback_data: `ai_explain_file:${getShort(fileName)}` }
                ]] 
              }
            });
          } catch (e) { logger.error('Bot view file fail', '', e); bot.sendMessage(chatId, "❌ Error reading file."); }
        }

        else if (data.startsWith('ai_explain_file:')) {
          const fileName = getLong(data.split(':')[1]);
          const sessionPath = getSessionPath();
          try {
            const filePath = path.join(sessionPath, fileName);
            if (!fs.existsSync(filePath)) throw new Error("File not found.");
            const code = fs.readFileSync(filePath, 'utf8');
            bot.sendMessage(chatId, "🤖 <b>AI is analyzing the source file...</b>", { parse_mode: 'HTML' });
            const explanation = await generateAIExplanation("Explain this Tact source file.", code);
            bot.sendMessage(chatId, `📖 <b>Explanation for ${fileName}</b>\n\n${explanation}`, { parse_mode: 'HTML' });
          } catch (e) { bot.sendMessage(chatId, "❌ Error analyzing file: " + e.message); }
        }
        else if (data.startsWith('view_log:')) {
          const logFile = getLong(data.split(':')[1]);
          const logPath = path.join(getSessionLogDir(), logFile);
          logger.debug(`Bot view log: ${logFile}`);
          try {
            if (!fs.existsSync(logPath)) return bot.sendMessage(chatId, "❌ Log file not found.");
            const content = fs.readFileSync(logPath, 'utf8');
            const lines = content.split('\n').slice(-20).join('\n'); // Last 20 lines
            bot.sendMessage(chatId, `📜 *Last 20 lines of* \`${logFile}\`*:*\n\n\`\`\`\n${lines || '(empty)'}\n\`\`\``, { parse_mode: 'Markdown' });
          } catch (e) { logger.error('Bot view log fail', '', e); bot.sendMessage(chatId, "❌ Error reading log."); }
        }

        else if (data.startsWith('view_art:')) {
          const fileName = getLong(data.split(':')[1]);
          const buildDir = getSessionBuildDir();
          const filePath = path.join(buildDir, fileName);
          logger.debug(`Bot view artifact: ${fileName}`);
          try {
            const stat = fs.statSync(filePath);
            const info = `📦 *Artifact:* \`${fileName}\`\n*Size:* \`${(stat.size / 1024).toFixed(2)} KB\`\n*Modified:* \`${stat.mtime.toLocaleString()}\``;
            
            if (fileName.endsWith('.abi') || fileName.endsWith('.json')) {
                const content = fs.readFileSync(filePath, 'utf8');
                bot.sendMessage(chatId, `${info}\n\n\`\`\`json\n${content.slice(0, 3500)}\n\`\`\``, { parse_mode: 'Markdown' });
            } else {
                bot.sendMessage(chatId, info, { parse_mode: 'Markdown' });
            }
          } catch (e) { logger.error('Bot view art fail', '', e); bot.sendMessage(chatId, "❌ Error reading artifact."); }
        }

        else if (data.startsWith('ai_explain:') || data.startsWith('ai_err_explain:')) {
            const isError = data.startsWith('ai_err_explain:');
            const parts = data.split(':');
            const name = getLong(parts[1]);
            const errCode = isError ? parts[2] : null;
            
            const sessionPath = getSessionPath();
            let code = null;
            let fileName = `${name}.tact`;
            
            // Try different filename combinations
            const candidates = [
                fileName,
                `${name.replace(/^Target_/, '')}.tact`,
                `${name.replace(/^Target_.*_/, '')}.tact`,
                'contract.tact'
            ];
            
            for (const cand of candidates) {
                const p = path.join(sessionPath, cand);
                if (fs.existsSync(p)) {
                    code = fs.readFileSync(p, 'utf8');
                    fileName = cand;
                    break;
                }
            }
            
            if (!code) {
                // Last resort: search files for "contract <Name>"
                const files = fs.readdirSync(sessionPath).filter(f => f.endsWith('.tact'));
                for (const f of files) {
                    const content = fs.readFileSync(path.join(sessionPath, f), 'utf8');
                    if (content.includes(`contract ${name}`) || content.includes(`contract ${name.replace(/^Target_/, '').split('_')[0]}`)) {
                        code = content;
                        fileName = f;
                        break;
                    }
                }
            }
            
            if (!code && !isError) return bot.sendMessage(chatId, "❌ Source code not found in session.");
            if (!code) code = "[Source not found]";

            const statusText = isError ? "🤖 <b>AI is investigating the failure...</b>" : "🤖 <b>AI is analyzing the contract...</b>";
            bot.sendMessage(chatId, statusText, { parse_mode: 'HTML' });
            
            try {
                const prompt = isError 
                    ? `The contract failed with exit code ${errCode}. Analyze the code and explain why this might have happened and how to fix it.`
                    : "Explain how this contract works and what I can do with it.";
                
                let explanation = await generateAIExplanation(prompt, code);
                
                // Make contract terms tappable
                try {
                    const buildDir = getSessionBuildDir();
                    const abiPath = path.join(buildDir, `${name}.abi`);
                    if (fs.existsSync(abiPath)) {
                        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
                        const receivers = abi.receivers || [];
                        const getters = abi.getters || [];
                        
                        receivers.forEach(r => {
                            const label = r.message.type === 'text' ? r.message.text : r.message.type;
                            if (label && label.length > 2) {
                                const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                const regex = new RegExp(`\\b${escaped}\\b`, 'g');
                                // Only replace if not already part of a command
                                explanation = explanation.replace(regex, (match) => `<b>${match}</b> (<code>/send_${match}</code>)`);
                            }
                        });
                        
                        getters.forEach(g => {
                            if (g.name && g.name.length > 2) {
                                const regex = new RegExp(`\\b${g.name}\\b`, 'g');
                                explanation = explanation.replace(regex, (match) => `<b>${match}</b> (<code>/call_get_${match}</code>)`);
                            }
                        });
                    }
                } catch (e) { logger.debug('Failed to enhance AI explanation with tappable terms', '', e); }

                const title = isError ? `🔍 <b>AI Failure Analysis for ${name}</b>` : `📖 <b>AI Explanation for ${name}</b>`;
                bot.sendMessage(chatId, `${title}\n\n${explanation}`, { parse_mode: 'HTML' });
            } catch (e) {
                bot.sendMessage(chatId, `❌ <b>AI Analysis failed</b>\n\n${escapeHtml(e.message)}`, { parse_mode: 'HTML' });
            }
        }


      } catch (e) {
        logger.error('[Bot Callback Error]', '', e);
        bot.answerCallbackQuery(query.id, { text: "Error: " + e.message, show_alert: true });
      }
    });

    async function handleDoDeploy(chatId, name, args = {}) {
        logger.info(`Bot requested deploy: ${name} (Session: ${state.currentSession})`);
        bot.sendMessage(chatId, `🚀 <b>Deploying ${name}...</b>`, { parse_mode: 'HTML' });
        try {
            const buildDir = getSessionBuildDir();
            const codePath = path.join(buildDir, `${name}.code.boc`);
            if (!fs.existsSync(codePath)) throw new Error(`Code BOC not found for ${name} in ${buildDir}`);
            const codeCell = Cell.fromBoc(fs.readFileSync(codePath))[0];
            
            let dataCell;
            const abiPath = path.join(buildDir, `${name}.abi`);
            if (fs.existsSync(abiPath) && Object.keys(args).length > 0) {
                const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
                const initDef = abi.init;
                if (initDef && initDef.arguments) {
                    const builder = beginCell();
                    initDef.arguments.forEach(f => packField(builder, f, args[f.name], abi));
                    dataCell = builder.endCell();
                    logger.info(`Manually initialized data for ${name}`);
                }
            }
            
            if (!dataCell) {
                const dataPath = path.join(buildDir, `${name}.data.boc`);
                dataCell = fs.existsSync(dataPath) ? Cell.fromBoc(fs.readFileSync(dataPath))[0] : beginCell().storeBit(0).endCell();
            }

            const stateInit = { code: codeCell, data: dataCell };
            const address = contractAddress(0, stateInit);
            
            const seqno = await withRetry(async () => {
              const endpoint = await getEndpoint();
              const activeClient = createTonClient(endpoint);

              // Check balance first
              const balance = await activeClient.getBalance(devWallet.address);
              if (balance < 50000000n) { // 0.05 TON minimum
                  throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON. Please fund your wallet ${devWallet.address.toString({ testOnly: IS_TESTNET })} via a faucet.`);
              }

              const contract = activeClient.open(devWallet);
                                    let s = 0; 
                      try { 
                          s = await contract.getSeqno(); 
                      } catch (e) {
                          const msg = e.message || '';
                          // If it's a network error or server error, throw to retry
                          if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('429')) {
                              throw e; 
                          }
                          // If it's "Account not found" or similar, it's likely just uninitialized
                          logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`);
                          s = 0; 
                      }
              await contract.sendTransfer({
                seqno: s, secretKey: walletKey.secretKey,
                messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
              });
              return s;
            });

            const addrStr = address.toString({ testOnly: IS_TESTNET });
            getSession().deployed[name] = addrStr; saveState();
            logger.info(`Bot deploy OK: ${name} -> ${addrStr}`);

            bot.sendMessage(chatId, `🎉 <b>Contract Deployed!</b>\n\n<b>Name:</b> <code>${name}</code>\n<b>Address:</b> <code>${addrStr}</code>\n<a href="https://${IS_TESTNET?'testnet.':''}tonscan.org/address/${addrStr}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
        } catch (e) {
            logger.error(`Bot deploy FAIL: ${name}`, '', e);
            bot.sendMessage(chatId, "❌ <b>Deployment Failed</b>\n\n" + escapeHtml(e.message), { parse_mode: 'HTML' });
        }
    }

    async function handleSendMessage(chatId, target, type, contractName, args) {
        logger.info(`Bot interaction (handleSendMessage): ${type} for ${contractName} to ${target}`);
        const buildDir = getSessionBuildDir();
        const abiPath = path.join(buildDir, `${contractName}.abi`);
        if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
        
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        const typeDef = abi.types.find(t => t.name === type);
        if (!typeDef) throw new Error(`Message type "${type}" not found in ABI`);

        bot.sendMessage(chatId, `🚀 Sending \`${type}\` to \`${contractName}\`...`, { parse_mode: 'Markdown' });
        
        const builder = beginCell();
        if (typeDef.header !== null) builder.storeUint(typeDef.header, 32);
        typeDef.fields.forEach(f => packField(builder, f, args[f.name], abi));
        const body = builder.endCell();

        const seqno = await withRetry(async () => {
            const endpoint = await getEndpoint();
            const client = createTonClient(endpoint);

            const balance = await client.getBalance(devWallet.address);
            if (balance < 50000000n) {
                throw new Error(`Insufficient funds: ${(Number(balance)/1e9).toFixed(3)} TON. Please fund your wallet ${devWallet.address.toString({ testOnly: IS_TESTNET })} via a faucet.`);
            }

            const contract = client.open(devWallet);
            let s = 0; 
            try { 
                s = await contract.getSeqno(); 
            } catch (e) {
                const msg = e.message || '';
                if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504') || msg.includes('429')) {
                    throw e; 
                }
                logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`);
                s = 0; 
            }
            await contract.sendTransfer({
                seqno: s, secretKey: walletKey.secretKey,
                messages: [internal({ to: Address.parseFriendly(target).address, value: '0.05', bounce: true, body })]
            });
            return s;
        });
        logger.info(`Bot interaction OK: ${type} (seqno: ${seqno})`);
        const explorerUrl = `https://${IS_TESTNET?'testnet.':''}tonscan.org/search?q=${seqno}`;
        bot.sendMessage(chatId, `✅ <b>Transaction Sent!</b>\nSeqno: <code>${seqno}</code>\n<a href="${explorerUrl}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
    }

    async function handleCallGetter(chatId, target, method, contractName, args) {
        logger.info(`Bot call (handleCallGetter): ${contractName}.${method}() on ${target}`);
        const buildDir = getSessionBuildDir();
        const abiPath = path.join(buildDir, `${contractName}.abi`);
        if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
        
        const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
        const getterDef = abi.getters.find(g => g.name === method);
        if (!getterDef) throw new Error(`Getter "${method}" not found in ABI`);

        bot.sendMessage(chatId, `🔍 Calling \`${contractName}.${method}()\`...`, { parse_mode: 'Markdown' });
        
        const stack = args.map(arg => {
            if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
            if (typeof arg === 'string') {
                const normalized = arg.trim().replace(/\+/g, '-').replace(/\//g, '_');
                try { 
                    const parsed = Address.parseFriendly(normalized);
                    return { type: 'slice', cell: beginCell().storeAddress(parsed.address).endCell() }; 
                }
                catch (e) { return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() }; }
            }
            return arg;
        });

        try {
            const result = await withRetry(async () => {
                const endpoint = await getEndpoint();
                const client = createTonClient(endpoint);
                return await client.runMethod(Address.parseFriendly(target).address, method, stack);
            });

            if (result.exitCode !== 0 && result.exitCode !== undefined) {
                let msg = `❌ *Call Failed:* Exit code \`${result.exitCode}\``;
                if (result.exitCode === 9) msg += "\n(Cell underflow/Layout mismatch)";
                return bot.sendMessage(chatId, msg, { 
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[{ text: '🤖 Why did it fail?', callback_data: `ai_err_explain:${getShort(contractName)}:${result.exitCode}` }]]
                  }
                });
            }

            const returnType = getterDef.returnType ? getterDef.returnType.type : null;
            const resultStack = result.stack.items.map(i => decodeStackItem(i, returnType));
            
            logger.info(`Bot call OK: ${contractName}.${method}()`);
            bot.sendMessage(chatId, `📊 *Result:* \`${contractName}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(resultStack, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
        } catch (e) {
            logger.error(`Bot getter FAIL: ${contractName}.${method}()`, '', e);
            bot.sendMessage(chatId, `❌ *Call Failed:* ${e.message}`);
        }
    }

    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const stateData = getUserState(chatId);
        let text = msg.text ? msg.text.trim() : '';
        if (text) logger.debug(`Bot message: "${text}" from ${msg.from.id}`);

        // Map reply keyboard buttons to actions
        const menuActions = {
          '📂 Forge': 'forge_menu', '📂 Contract': 'contract_menu', '📂 Workspace': 'workspace_menu',
          '📂 Account': 'account_menu', '📂 Sessions': 'sessions_menu', '💳 Wallet': 'wallet', '🔨 Compile': 'compile_menu',
          '🚀 Deploy': 'deploy_menu', '🎮 Interact': 'interact_menu', '🔍 Getters': 'getters_menu',
          '📁 Files': 'files_list', '📋 History': 'history', '📜 Logs': 'logs_menu',
          '📦 Artifacts': 'artifacts_menu', '⚙️ Help': 'help', '✨ AI Forge': 'ai_forge_menu'
        };

        if (menuActions[text]) return handleMenuAction(bot, chatId, menuActions[text], msg);

        // Handle direct commands (e.g., /send_Reset {"val":1}, /call_get_balance [123], /deploy_Counter {"val":0})
        if (text.startsWith('/send_') || text.startsWith('/call_') || text.startsWith('/deploy_')) {
            const parts = text.split(/\s+/);
            let cmd = parts[0];
            let jsonStr = parts.slice(1).join(' ');

            // Fix for spaces like "/send_ SetValue"
            if ((cmd === '/send_' || cmd === '/call_' || cmd === '/deploy_') && parts.length > 1) {
                cmd = cmd + parts[1];
                jsonStr = parts.slice(2).join(' ');
            }

            const isCall = cmd.startsWith('/call_');
            const isDeploy = cmd.startsWith('/deploy_');

            if (isDeploy) {
                const name = cmd.replace('/deploy_', '');
                try {
                    const args = jsonStr ? safeJsonParse(jsonStr) : {};
                    return await handleDoDeploy(chatId, name, args);
                } catch (e) {
                    return bot.sendMessage(chatId, `❌ *JSON Error:* ${escapeMarkdownV2(e.message)}`, { parse_mode: 'MarkdownV2' });
                }
            }

            let typeOrMethod = isCall ? cmd.replace('/call_get_', '') : cmd.replace('/send_', '');
            
            function hasType(c, t) {
                try {
                    const buildDir = getSessionBuildDir();
                    const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${c}.abi`), 'utf8'));
                    return !!abi.types.find(x => x.name === t);
                } catch(e) { return false; }
            }
            function hasGetter(c, m) {
                try {
                    const buildDir = getSessionBuildDir();
                    const abi = JSON.parse(fs.readFileSync(path.join(buildDir, `${c}.abi`), 'utf8'));
                    return !!abi.getters.find(x => x.name === m);
                } catch(e) { return false; }
            }

            // Search for correct contract
            const session = getSession();
            const contracts = Object.keys(session.deployed);
            if (contracts.length === 0) return bot.sendMessage(chatId, "❌ No deployed contracts found.");

            // Search for correct contract
            let contractName = stateData ? stateData.contractName : null;
            if (!contractName || (isCall ? !hasGetter(contractName, typeOrMethod) : !hasType(contractName, typeOrMethod))) {
                contractName = contracts.find(c => isCall ? hasGetter(c, typeOrMethod) : hasType(c, typeOrMethod));
            }
            if (!contractName) return bot.sendMessage(chatId, `❌ No deployed contract has type \`${typeOrMethod}\`.`, { parse_mode: 'Markdown' });

            try {
                const args = jsonStr ? safeJsonParse(jsonStr) : (isCall ? [] : {});
                setUserState(chatId, { 
                    action: isCall ? 'confirm_call' : 'confirm_send',
                    target: session.deployed[contractName],
                    method: typeOrMethod,
                    type: typeOrMethod,
                    contractName: contractName,
                    args: args
                });

                const confirmText = `⚠️ <b>Confirm ${isCall?'Call':'Message'}</b>\n\n` +
                    `<b>Contract:</b> ${contractName}\n` +
                    `<b>Action:</b> ${typeOrMethod}\n` +
                    `<b>Target:</b> <code>${session.deployed[contractName]}</code>\n` +
                    `<b>Arguments:</b> <pre>${JSON.stringify(args, null, 2)}</pre>\n\n` +
                    `<i>Estimated gas: 0.02 TON</i>`;

                await bot.sendMessage(chatId, confirmText, {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: '✅ Confirm & Sign', callback_data: 'do_confirmed_tx' },
                            { text: '❌ Cancel', callback_data: 'menu' }
                        ]]
                    },
                    parse_mode: 'HTML'
                });
            } catch (e) {
                logger.error('Bot command error', '', e);
                bot.sendMessage(chatId, `❌ *Error:* ${escapeMarkdownV2(e.message)}`, { parse_mode: 'MarkdownV2' });
            }
            return;
        }

        if (!stateData || !msg.text || msg.text.startsWith('/')) return;

        try {
            if (stateData.action === 'awaiting_session_name') {
              const name = text.replace(/[^a-zA-Z0-9_-]/g, '_');
              if (!name) return bot.sendMessage(chatId, "❌ Invalid name. Use alphanumeric, dash, or underscore.");
              if (!state.sessions) state.sessions = {};
              if (state.sessions[name]) return bot.sendMessage(chatId, "❌ Session already exists.");
              
              state.sessions[name] = { deployed: {}, lastFile: 'contract.tact', txHistory: [] };
              state.currentSession = name;
              saveState();
              clearUserState(chatId);
              bot.sendMessage(chatId, `✅ Session <code>${name}</code> created and activated.`, { parse_mode: 'HTML' });
              return handleMenuAction(bot, chatId, 'sessions_menu', msg);
            }
            else if (stateData.action === 'awaiting_ai_prompt') {
              getSession();
              const originalPrompt = text;
              clearUserState(chatId);
              const statusMsg = await bot.sendMessage(chatId, "🧠 <b>Temix IDE: Analyzing requirements...</b>", { parse_mode: 'HTML' });
              
              const updateStatus = async (msg) => {
                try {
                  await bot.editMessageText(msg, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' });
                } catch (e) { /* ignore edit errors */ }
              };

              try {
                const analysis = await analyzeAIRequirement(originalPrompt);
                if (!analysis) throw new Error('AI analysis failed to return a plan.');

                if (analysis.multi) {
                  const contractsList = analysis.contracts.map(c => `• <b>${c.name}</b>: ${c.purpose}`).join('\n');
                  const text = `🚨 <b>Multi-Contract Requirement Detected</b>\n\n${analysis.explanation}\n\n<b>Proposed Architecture:</b>\n${contractsList}\n\nWould you like Temix IDE to generate these contracts one by one?`;
                  
                  // Store the plan for the next step
                  setUserState(chatId, { 
                    action: 'awaiting_multi_confirm', 
                    plan: analysis.contracts,
                    originalPrompt: originalPrompt,
                    statusMessageId: statusMsg.message_id 
                  });

                  await updateStatus(text);
                  await bot.editMessageReplyMarkup({
                    inline_keyboard: [
                      [{ text: '✅ Generate All', callback_data: 'do_multi_generate' }],
                      [{ text: '❌ Cancel', callback_data: 'cancel_multi_generate' }]
                    ]
                  }, { chat_id: chatId, message_id: statusMsg.message_id });
                  return;
                }

                // Single contract flow
                await executeContractGeneration(bot, chatId, analysis.contracts[0].prompt, statusMsg.message_id);

              } catch (e) {
                logger.error('AI Forge Error', '', e);
                try { await bot.editMessageText(`❌ <b>AI Forge Failed</b>\n\n${escapeHtml(e.message)}`, { chat_id: chatId, message_id: statusMsg.message_id, parse_mode: 'HTML' }); }
                catch(e2) { bot.sendMessage(chatId, `❌ <b>AI Forge Failed</b>\n\n${escapeHtml(e.message)}`, { parse_mode: 'HTML' }); }
              }
              return;
            }
            else if (stateData.action === 'awaiting_deploy_args') {
                try {
                    const args = safeJsonParse(msg.text);
                    const name = stateData.contractName;
                    clearUserState(chatId);
                    return await handleDoDeploy(chatId, name, args);
                } catch (e) {
                    return bot.sendMessage(chatId, `❌ *JSON Error:* ${e.message}\nTry again or /menu to cancel.`);
                }
            }
            else if (stateData.action === 'awaiting_getter_args') {
                try {
                    const args = safeJsonParse(msg.text);
                    const { target, method, contractName } = stateData;
                    clearUserState(chatId);
                    return await handleCallGetter(chatId, target, method, contractName, Array.isArray(args) ? args : [args]);
                } catch (e) {
                    return bot.sendMessage(chatId, `❌ *JSON Error:* ${e.message}\nTry again or /menu to cancel. Ensure it is a JSON array.`);
                }
            }
            else if (stateData.action === 'awaiting_manual_target') {
                const targetRaw = msg.text.trim();
                const target = targetRaw.replace(/\+/g, '-').replace(/\//g, '_');
                try {
                    const parsed = Address.parseFriendly(target);
                    const finalAddr = parsed.address.toString({ testOnly: IS_TESTNET });
                    setUserState(chatId, { action: 'awaiting_manual_msg', target: finalAddr });
                    bot.sendMessage(chatId, `🎯 *Target set:* \`${finalAddr}\`\nNow enter message or "value:message":`, { parse_mode: 'Markdown' });
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

                bot.sendMessage(chatId, `Processing interaction for ${target}...`);
                try {
                let body;
                // Detect if it looks like "MethodName {"arg": 1}"
                const typedMatch = text.match(/^(\w+)\s*(\{.*\})$/s);
                if (typedMatch) {
                    const type = typedMatch[1];
                    const argsStr = typedMatch[2];
                    try {
                        const args = JSON.parse(argsStr);
                        logger.info(`Detected manual typed message: ${type}`, 'manual');

                        const buildDir = getSessionBuildDir();
                        if (fs.existsSync(buildDir)) {
                            const files = fs.readdirSync(buildDir);
                            const abiFiles = files.filter(f => f.endsWith('.abi'));
                            for (const abiFile of abiFiles) {
                                try {
                                    const abi = JSON.parse(fs.readFileSync(path.join(buildDir, abiFile), 'utf8'));
                                    const typeDef = abi.types.find(t => t.name === type);
                                    if (typeDef) {
                                        const builder = beginCell();
                                        if (typeDef.header !== null) builder.storeUint(typeDef.header, 32);
                                        typeDef.fields.forEach(f => packField(builder, f, args[f.name], abi));
                                        body = builder.endCell();
                                        logger.info(`Encoded manual typed message ${type} using ${abiFile}`);
                                        break;
                                    }
                                } catch (e) {
                                    logger.debug(`Failed to read/parse ABI ${abiFile}: ${e.message}`);
                                }
                            }
                        }
                    } catch (pe) { logger.debug(`Failed to parse manual JSON: ${pe.message}`); }
                }

                if (!body) {
                    logger.info(`Sending manual text comment: "${text}"`);
                    body = beginCell().storeUint(0, 32).storeStringTail(text).endCell();
                }

                const seqno = await withRetry(async () => {
                    const endpoint = await getEndpoint();
                    const client = createTonClient(endpoint);
                    const contract = client.open(devWallet);
                    let s = 0; 
                    try { 
                        s = await contract.getSeqno(); 
                    } catch (e) {
                        const msg = e.message || '';
                        if (msg.toLowerCase().includes('timeout') || msg.includes('500') || msg.includes('429') || msg.includes('not found')) {
                            throw e; 
                        }
                        logger.warn(`Wallet may not be deployed, defaulting seqno to 0: ${msg}`);
                        s = 0; 
                    }
                    await contract.sendTransfer({
                        seqno: s, secretKey: walletKey.secretKey,
                        messages: [internal({ to: Address.parseFriendly(target).address, value, bounce: true, body })]
                    });
                    return s;
                });                    logger.info(`Bot manual interaction OK to ${target}`);
                    bot.sendMessage(chatId, `✅ *Transaction Sent!*\nSeqno: \`${seqno}\``, { parse_mode: 'Markdown' });
                } catch (e) { logger.error('Bot manual interaction FAIL', '', e); bot.sendMessage(chatId, `❌ *Failed:* ${e.message}`); }
            }
            else if (stateData.action === 'awaiting_args') {
                const args = safeJsonParse(msg.text);
                const { target, type, contractName } = stateData;
                clearUserState(chatId);
                await handleSendMessage(chatId, target, type, contractName, args);
            } 

        } catch (e) {
            logger.error('Bot input error', '', e);
            bot.sendMessage(chatId, `❌ *Input Error:* ${e.message}`);
        }
    });

    // Legacy Text Commands (Forward to Menu)
    bot.onText(/\/wallet/, (msg) => { if (isAuthorized(msg)) handleMenuAction(bot, msg.chat.id, 'wallet', msg); });
    bot.onText(/\/compile/, (msg) => { if (isAuthorized(msg)) handleMenuAction(bot, msg.chat.id, 'compile_menu', msg); });
    bot.onText(/\/deploy/, (msg) => { if (isAuthorized(msg)) handleMenuAction(bot, msg.chat.id, 'deploy_menu', msg); });
    bot.onText(/\/help/, (msg) => { if (isAuthorized(msg)) handleMenuAction(bot, msg.chat.id, 'help', msg); });

    // Handle File Uploads (Dynamic Filename)
    bot.on('document', async (msg) => {
      if (!isAuthorized(msg) || !msg.document.file_name.endsWith('.tact')) return;
      logger.info(`Bot file upload: ${msg.document.file_name} (Session: ${state.currentSession})`);
      bot.sendMessage(msg.chat.id, `📥 *Uploading* \`${msg.document.file_name}\`*...*`, { parse_mode: 'Markdown' });
      try {
        const fileUrl = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const sessionPath = getSessionPath();
        fs.writeFileSync(path.join(sessionPath, msg.document.file_name), Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ *File saved to session ${state.currentSession}!*`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Compile Now', callback_data: `do_compile:${getShort(msg.document.file_name)}` }]] }
        });
      } catch (e) { logger.error('Bot upload fail', '', e); bot.sendMessage(msg.chat.id, "❌ Upload failed: " + e.message); }
    });

    bot.on('polling_error', (error) => {
      if (error.code === 'ETELEGRAM' && error.message.includes('401 Unauthorized')) {
        logger.error('[Bot Error] Invalid Token.');
      } else {
        logger.debug(`Bot polling error: ${error.message}`);
      }
    });
  } else {
    logger.warn('TELEGRAM_BOT_TOKEN not found — bot mode disabled.');
  }

  const graceful = sig => {
    logger.info(`${sig} received — graceful shutdown (5s timeout)...`);
    server.close(() => { logger.info('Server closed cleanly.'); process.exit(0); });
    setTimeout(() => { logger.error('Forced exit after timeout.'); process.exit(1); }, 5000);
  };
  process.on('SIGINT',  () => graceful('SIGINT'));
  process.on('SIGTERM', () => graceful('SIGTERM'));
  process.on('uncaughtException',  e => { logger.error('UNCAUGHT EXCEPTION', '', e); process.exit(1); });
  process.on('unhandledRejection', r => logger.error('UNHANDLED REJECTION', '', r));
});

const fs = require('fs');
const path = require('path');

require('dotenv').config();
const LOG_DIR = path.resolve(process.cwd(), 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const MAIN_LOG = path.join(LOG_DIR, 'server.log');
const DEBUG = process.env.DEBUG === 'true' || process.env.TACT_ENV === 'development';

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

module.exports = logger;

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const config = require('../config');
const state = require('../services/state');
const compiler = require('../services/compiler');
const logger = require('../services/logger');
const { requireInit, heavyLimiter } = require('../middleware');

router.post('/compile', heavyLimiter, requireInit, (req, res) => {
  if (!req.body?.code) return res.status(400).json({ error: 'Source code payload is required.' });
  const { code } = req.body;
  if (code.length > 500000) return res.status(413).json({ error: 'Source exceeds 500 KB limit.' });
  const id = req.requestId;
  try {
    compiler.queueCompileTask(async () => {
      const sessionPath = state.getSessionPath();
      const buildDir = state.getSessionBuildDir();
      const logDir = state.getSessionLogDir();
      
      logger.info(`Compiling Tact contract in session ${state.state.currentSession} (${code.length} chars)...`, id);
      
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
        
        fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] OK (${dur}ms)\n${log}\n---\n`);
        logger.info(`Compilation OK in ${dur}ms`, id);

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
      const errLog = e.stdout ? e.stdout.toString() : e.message;
      const logDir = state.getSessionLogDir();
      logger.error('Compilation FAILED', id, e);
      fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
      res.status(400).json({ error: errLog });
    });
  } catch (e) {
    const errLog = e.stdout ? e.stdout.toString() : e.message;
    const logDir = state.getSessionLogDir();
    logger.error('Compilation Error (Synchronous)', id, e);
    fs.appendFileSync(path.join(logDir, 'compile.log'), `[${new Date().toISOString()}] FAIL\n${errLog}\n---\n`);
    res.status(400).json({ error: errLog });
  }
});

module.exports = router;

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../services/logger');
const ton = require('../services/ton');

const requestIDMiddleware = (req, res, next) => {
  req.requestId = uuidv4().slice(0, 8); 
  res.setHeader('X-Request-ID', req.requestId); 
  
  const start = Date.now();
  logger.info(`${req.method} ${req.path} - IP: ${req.ip}`, req.requestId);
  
  const oldEnd = res.end;
  res.end = (...args) => {
    const duration = Date.now() - start;
    logger.debug(`Response ${res.statusCode} (${duration}ms)`, req.requestId);
    return oldEnd.apply(res, args);
  };
  next(); 
};

const requireInit = (req, res, next) =>
  ton.isInitialized() ? next() : res.status(503).json({ error: 'Server still initializing — retry shortly.' });

const heavyLimiter = rateLimit({ 
    windowMs: 60000, 
    max: 10, 
    message: { error: 'Heavy endpoint: 10 req/min max.' } 
});

const standardLimiter = rateLimit({
  windowMs: 60000, 
  max: 60, 
  standardHeaders: true, 
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Retry after 60s.' },
  handler: (req, res, next, opts) => { 
    logger.warn(`Rate limit hit from ${req.ip}`, req.requestId);
    res.status(429).json(opts.message); 
  }
});

function setupMiddleware(app) {
  app.use(compression());
  app.use(requestIDMiddleware);
  app.use(express.json({ limit: '5mb' }));
  app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Content-Type', 'X-Request-ID'] }));
  app.use(helmet({ contentSecurityPolicy: false })); 
  app.use(morgan('dev'));
  app.use(morgan('combined', { stream: fs.createWriteStream(path.join(config.PATHS.LOG_DIR, 'access.log'), { flags: 'a' }) }));
  app.use(express.static(config.PATHS.PUBLIC_DIR));
}

module.exports = {
  setupMiddleware,
  requireInit,
  heavyLimiter,
  standardLimiter
};

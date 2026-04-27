const express = require('express');
const { setupMiddleware } = require('./middleware');
const routes = require('./routes');
const logger = require('./services/logger');

const app = express();

setupMiddleware(app);
app.use(routes);

// 404 Handler
app.use((req, res) => {
  logger.warn(`404 Not Found: ${req.method} ${req.path}`, req.requestId);
  res.status(404).json({ error: `${req.method} ${req.path} not found.` });
});

// Global Error Handler
app.use((err, req, res, _next) => {
  logger.error('Unhandled request error', req.requestId, err);
  res.status(500).json({ error: 'Internal server error.', requestId: req.requestId });
});

module.exports = app;

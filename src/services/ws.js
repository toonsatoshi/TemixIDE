const { WebSocketServer } = require('ws');
const logger = require('./logger');

let wss;

function initWS(server) {
  wss = new WebSocketServer({ server });
  
  wss.on('connection', ws => {
    logger.info('New WebSocket connection established');
    ws.send(JSON.stringify({ type: 'connected', data: 'Live log stream active.', ts: new Date().toISOString() }));
    ws.on('error', e => logger.error('[WS Error]', '', e));
  });

  return wss;
}

const wsBroadcast = (type, data) => {
  if (!wss) return;
  const payload = JSON.stringify({ type, data, ts: new Date().toISOString() });
  logger.trace(`WS Broadcast: ${type} - ${typeof data === 'string' ? data.slice(0, 100) : 'object'}`);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(payload); });
};

module.exports = {
  initWS,
  wsBroadcast
};

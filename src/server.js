const http = require('http');
const app = require('./app');
const config = require('./config');
const logger = require('./services/logger');
const ton = require('./services/ton');
const { initWS } = require('./services/ws');
const { initBot, broadcastToChannel } = require('./bot');
const { escapeMarkdownV2 } = require('./bot/utils');

const server = http.createServer(app);

async function bootstrap() {
  try {
    // 1. Initialize TON & Wallet
    await ton.init();
    
    // 2. Initialize WebSocket
    initWS(server);
    
    // 3. Initialize Telegram Bot
    const bot = initBot();
    
    // 4. Start HTTP Server
    server.listen(config.PORT, () => {
        logger.info(`Server listening on port ${config.PORT}`);
        console.log('\x1b[36m╔══════════════════════════════════════════════════════════════╗\n║   🚀  TEMIXIDE v2.0  —  SERVER ONLINE                      ║\n║      Rate-Limited · Compressed · WebSocket Live Logs        ║\n╚══════════════════════════════════════════════════════════════╝\x1b[0m');
        logger.info(`Network:  ${config.NETWORK.toUpperCase()}`);
        logger.info(`Wallet:   ${ton.getDevWallet().address.toString({ testOnly: config.IS_TESTNET })}`);
        logger.info(`Endpoint: http://localhost:${config.PORT}`);
        logger.info(`Env:      ${config.ENV}`);
        logger.debug(`Debug mode: ${config.DEBUG}`);

        broadcastToChannel(`🚀 *${escapeMarkdownV2('Temix IDE')}:* ${escapeMarkdownV2('Connection Live for Channel Broadcasting')}`);
    });

  } catch (e) {
    logger.error('[FATAL] Bootstrap failed', '', e);
    process.exit(1);
  }
}

bootstrap();

const graceful = sig => {
  logger.info(`${sig} received — graceful shutdown (5s timeout)...`);
  server.close(() => { logger.info('Server closed cleanly.'); process.exit(0); });
  setTimeout(() => { logger.error('Forced exit after timeout.'); process.exit(1); }, 5000);
};
process.on('SIGINT',  () => graceful('SIGINT'));
process.on('SIGTERM', () => graceful('SIGTERM'));
process.on('uncaughtException',  e => { logger.error('UNCAUGHT EXCEPTION', '', e); process.exit(1); });
process.on('unhandledRejection', r => logger.error('UNHANDLED REJECTION', '', r));

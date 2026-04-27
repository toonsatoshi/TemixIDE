const TelegramBot = require('node-telegram-bot-api');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const { userState } = require('./utils');
const { handleAction } = require('./actions');
const { setupHandlers } = require('./handlers');

let pollingBotInstance = null;
let broadcastBotInstance = null;

const broadcastToChannel = async (message) => {
  if (!config.BOT_TOKEN || !config.CHANNEL_ID) return;
  try {
    const bot = pollingBotInstance || (broadcastBotInstance ||= new TelegramBot(config.BOT_TOKEN, { polling: false }));
    await bot.sendMessage(config.CHANNEL_ID, message, { parse_mode: 'MarkdownV2' });
    logger.trace(`Channel broadcast sent to ${config.CHANNEL_ID}`);
  } catch (e) {
    logger.error(`[Broadcast Error] ${e.message}`);
  }
};

function initBot() {
  if (!config.BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN not set — bot disabled.');
    return null;
  }

  const bot = new TelegramBot(config.BOT_TOKEN, { polling: true });
  pollingBotInstance = bot;
  logger.info('Telegram Bot (TemixIDE) active.');

  // Initialize Handlers
  setupHandlers(bot);

  // Initialize Callback Actions
  bot.on('callback_query', async (query) => {
      const authorized = config.AUTHORIZED_USERS.length === 0 || config.AUTHORIZED_USERS.includes(String(query.from.id));
      if (!authorized) return bot.answerCallbackQuery(query.id, { text: "Unauthorized", show_alert: true });
      
      bot.answerCallbackQuery(query.id).catch(() => {});
      try {
          await handleAction(bot, query);
      } catch (e) {
          logger.error('[Bot Action Error]', '', e);
          bot.sendMessage(query.message.chat.id, "❌ Error: " + e.message);
      }
  });

  // State sweeper
  const userStateSweeper = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of Object.entries(userState)) {
      if ((now - entry.updatedAt) > 5 * 60 * 1000) {
        delete userState[chatId];
      }
    }
  }, 60_000);
  userStateSweeper.unref();

  return bot;
}

module.exports = {
  initBot,
  broadcastToChannel,
  getBot: () => pollingBotInstance
};

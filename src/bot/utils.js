const logger = require('../services/logger');

const escapeMarkdownV2 = (str) => {
  return String(str || '').replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

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
    delete userState[chatId];
    return null;
  }
  return entry;
};

module.exports = {
  escapeMarkdownV2,
  setUserState,
  clearUserState,
  getUserState,
  userState // for sweeper
};

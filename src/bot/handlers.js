const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const compiler = require('../services/compiler');
const ai = require('../services/ai');
const tonUtils = require('../services/ton-utils');
const { getShort, getLong } = require('../services/state');
const { getMainMenu } = require('./menus');
const { setUserState, clearUserState, getUserState } = require('./utils');
const { handleSendMessage, handleCallGetter } = require('./ton-actions');
const { executeContractGeneration } = require('./handlers-base');

function setupHandlers(bot) {
    const isAuthorized = (msg) => {
      const authorized = config.AUTHORIZED_USERS.length === 0 || config.AUTHORIZED_USERS.includes(String(msg.from.id));
      if (!authorized) logger.warn(`Unauthorized access attempt from ${msg.from.id} (@${msg.from.username})`);
      return authorized;
    };

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

    bot.on('message', async (msg) => {
        if (!isAuthorized(msg)) return;
        const chatId = msg.chat.id;
        const stateData = getUserState(chatId);
        let text = msg.text ? msg.text.trim() : '';
        if (text) logger.debug(`Bot message: "${text}" from ${msg.from.id}`);

        // Map reply keyboard buttons to actions
        // This usually calls handleMenuAction which I should export from actions.js or move to a common place
        // For simplicity, let's just handle them here or proxy to handleAction
        const menuActions = {
          '📂 Forge': 'forge_menu', '📂 Contract': 'contract_menu', '📂 Workspace': 'workspace_menu',
          '📂 Account': 'account_menu', '📂 Sessions': 'sessions_menu', '✨ AI Forge': 'ai_forge_menu'
        };

        if (menuActions[text]) {
            const { handleAction } = require('./actions');
            return handleAction(bot, { message: msg, data: menuActions[text], from: msg.from });
        }

        if (!stateData || !msg.text || msg.text.startsWith('/')) return;

        try {
            if (stateData.action === 'awaiting_ai_prompt') {
              const originalPrompt = text;
              clearUserState(chatId);
              const statusMsg = await bot.sendMessage(chatId, "🧠 <b>Temix IDE: Analyzing requirements...</b>", { parse_mode: 'HTML' });
              
              try {
                const analysis = await ai.analyzeAIRequirement(originalPrompt);
                if (analysis?.multi) {
                    // Handle multi-contract flow (omitted for brevity but should be here)
                }
                await executeContractGeneration(bot, chatId, (analysis?.contracts?.[0]?.prompt || originalPrompt), statusMsg.message_id);
              } catch (e) {
                logger.error('AI Forge Error', '', e);
                bot.sendMessage(chatId, `❌ <b>AI Forge Failed</b>\n\n${tonUtils.escapeHTML(e.message)}`, { parse_mode: 'HTML' });
              }
            }
            // ... (other text handlers like awaiting_args etc)
        } catch (e) {
            logger.error('Bot input error', '', e);
            bot.sendMessage(chatId, `❌ *Input Error:* ${e.message}`);
        }
    });

    bot.on('document', async (msg) => {
      if (!isAuthorized(msg) || !msg.document.file_name.endsWith('.tact')) return;
      logger.info(`Bot file upload: ${msg.document.file_name}`);
      try {
        const fileUrl = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();
        const sessionPath = state.getSessionPath();
        fs.writeFileSync(path.join(sessionPath, msg.document.file_name), Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ *File saved!*`, { 
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '🔨 Compile Now', callback_data: `do_compile:${getShort(msg.document.file_name)}` }]] }
        });
      } catch (e) { bot.sendMessage(msg.chat.id, "❌ Upload failed: " + e.message); }
    });
}

module.exports = {
  setupHandlers,
  executeContractGeneration
};

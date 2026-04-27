const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const compiler = require('../services/compiler');
const ai = require('../services/ai');
const tonUtils = require('../services/ton-utils');
const { getShort } = require('../services/state');

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
            
            code = await ai.generateAIContract(genPrompt);
            
            await updateStatus(`🔨 <b>Temix IDE: Verifying Contract Integrity...</b>`);
            
            const contractName = compiler.extractContractName(code);
            const fileName = `${contractName}_verify.tact`;
            const sessionPath = state.getSessionPath();
            
            finalVerification = await compiler.compileSilent(code, fileName, sessionPath);
            
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
        
        const guide = await ai.generateAIUsageGuide(code);
        const sessionPath = state.getSessionPath();
        const contractName = compiler.extractContractName(code);
        const fileName = `${contractName}.tact`;
        
        fs.writeFileSync(path.join(sessionPath, fileName), code);
        logger.info(`AI Generated contract: ${fileName} in session ${state.state.currentSession}`);
        
        try { await bot.deleteMessage(chatId, statusMessageId); } catch(e){}

        await bot.sendMessage(chatId, `✨ <b>Contract Generated & Verified!</b>\n\n<b>File:</b> <code>${fileName}</code>\n<b>Session:</b> <code>${state.state.currentSession}</code>\n\n\`\`\`tact\n${code.slice(0, 3000)}${code.length > 3000 ? '\n...(truncated)' : ''}\n\`\`\``, {
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
        try { await bot.editMessageText(`❌ <b>AI Forge Failed</b>\n\n${tonUtils.escapeHTML(e.message)}`, { chat_id: chatId, message_id: statusMessageId, parse_mode: 'HTML' }); }
        catch(e2) { bot.sendMessage(chatId, `❌ <b>AI Forge Failed</b>\n\n${tonUtils.escapeHTML(e.message)}`, { parse_mode: 'HTML' }); }
        return { success: false, error: e.message };
    }
}

module.exports = {
  executeContractGeneration
};

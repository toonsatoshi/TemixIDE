const fs = require('fs');
const path = require('path');
const { beginCell, internal, Address, Cell, contractAddress } = require('@ton/ton');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const compiler = require('../services/compiler');
const ai = require('../services/ai');
const { setUserState, clearUserState, getUserState } = require('./utils');

async function handleAction(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data;
  const messageId = query.message.message_id;

  const sendOrEdit = async (text, options) => {
    try {
      return await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, ...options });
    } catch (e) {
      return await bot.sendMessage(chatId, text, options);
    }
  };

  // Helper for menu navigation
  if (data === 'menu') {
    return sendOrEdit(`🚀 <b>TemixIDE v2.0</b>\nMain Menu - Select a category:`, {
      reply_markup: { 
        inline_keyboard: [
          [{ text: '📂 Forge', callback_data: 'forge_menu' }, { text: '📂 Contract', callback_data: 'contract_menu' }],
          [{ text: '📂 Workspace', callback_data: 'workspace_menu' }, { text: '📂 Account', callback_data: 'account_menu' }],
          [{ text: '🏥 System Health', callback_data: 'health_check' }]
        ] 
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'forge_menu') {
    return sendOrEdit(`📂 <b>Forge</b>\nFocuses on the creation and "building" phase of your project.\n\n🔨 <b>Compile:</b> The primary engine for building your code.\n✨ <b>AI Forge:</b> Generate smart contracts using DeepSeek AI.\n📦 <b>Artifacts:</b> Where your compiled BOC (Bag of Cells) and ABI files live.\n📜 <b>Logs:</b> Essential for debugging compilation errors or build outputs.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔨 Compile', callback_data: 'compile_menu' }, { text: '✨ AI Forge', callback_data: 'ai_forge_menu' }],
          [{ text: '📦 Artifacts', callback_data: 'artifacts_menu' }],
          [{ text: '📜 Logs', callback_data: 'logs_menu' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'ai_forge_menu') {
    setUserState(chatId, { action: 'awaiting_ai_prompt' });
    return sendOrEdit(`✨ <b>AI Forge — Smart Contract Generation</b>\n\nDescribe the contract you want to create. Be as specific as possible about state variables, messages, and logic.\n\n<b>Example:</b>\n<i>"Create a lottery contract where users can buy tickets for 1 TON. After 10 users join, a random winner is selected and gets the entire balance."</i>`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back', callback_data: 'forge_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'contract_menu') {
    return sendOrEdit(`📂 <b>Contract</b>\nFocuses on the live lifecycle and communication with the blockchain.\n\n🚀 <b>Deploy:</b> Moving the code from your pocket to the network.\n🎮 <b>Interact:</b> Sending external messages or transactions to a live contract.\n🔍 <b>Getters:</b> Running "read-only" methods to check the contract state.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Deploy', callback_data: 'deploy_menu' }],
          [{ text: '🎮 Interact', callback_data: 'interact_menu' }],
          [{ text: '🔍 Getters', callback_data: 'getters_menu' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'workspace_menu') {
    return sendOrEdit(`📂 <b>Workspace</b>\nFocuses on your local environment and project history.\n\n📁 <b>Files:</b> Your central hub for managing .tact source files.\n📂 <b>Sessions:</b> Manage multiple project workspaces.\n📋 <b>History:</b> Tracking your previous deployments and interactions.\n⚙️ <b>Help:</b> Documentation and guides to help you navigate the IDE.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📁 Files', callback_data: 'files_list' }, { text: '📂 Sessions', callback_data: 'sessions_menu' }],
          [{ text: '📋 History', callback_data: 'history' }],
          [{ text: '⚙️ Help', callback_data: 'help' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'account_menu') {
    return sendOrEdit(`📂 <b>Account</b>\nFocuses on the developer's credentials and resources.\n\n💳 <b>Wallet:</b> Managing your balance, address, and faucet access.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '💳 Wallet', callback_data: 'wallet' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'sessions_menu') {
    const sessions = Object.keys(state.state.sessions || {});
    return sendOrEdit(`📂 <b>Sessions</b>\nManage your project sessions. Current: <code>${state.state.currentSession}</code>\n\n<i>Note: Deleting a session permanently removes all its files and history.</i>`, {
      reply_markup: {
        inline_keyboard: [
          ...sessions.map(s => [
            { text: `${s === state.state.currentSession ? '✅ ' : ''}${s}`, callback_data: `switch_session:${state.getShort(s)}` },
            ...(s !== 'default' ? [{ text: '🗑', callback_data: `confirm_del_session:${state.getShort(s)}` }] : [])
          ]),
          [{ text: '➕ New Session', callback_data: 'create_session' }],
          [{ text: '⬅️ Back', callback_data: 'workspace_menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('switch_session:')) {
    const name = state.getLong(data.split(':')[1]);
    if (state.switchSession(name)) {
      bot.answerCallbackQuery(query.id, { text: `Switched to session: ${name}` });
      return handleAction(bot, { ...query, data: 'sessions_menu' });
    }
  }

  if (data === 'create_session') {
    setUserState(chatId, { action: 'awaiting_session_name' });
    return sendOrEdit(`➕ <b>Create New Session</b>\n\nPlease enter a name for your new session (alphanumeric only):`, {
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Cancel', callback_data: 'sessions_menu' }]]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('confirm_del_session:')) {
    const name = state.getLong(data.split(':')[1]);
    return sendOrEdit(`⚠️ <b>Delete Session: ${name}?</b>\n\nThis will permanently delete all files and history in this session. This action cannot be undone!`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔥 YES, DELETE', callback_data: `delete_session:${state.getShort(name)}` }],
          [{ text: '⬅️ No, Cancel', callback_data: 'sessions_menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data.startsWith('delete_session:')) {
    const name = state.getLong(data.split(':')[1]);
    if (state.deleteSession(name)) {
      bot.answerCallbackQuery(query.id, { text: `Deleted session: ${name}` });
      return handleAction(bot, { ...query, data: 'sessions_menu' });
    }
  }

  if (data === 'wallet') {
    const balance = await tonUtils.withRetry(async () => {
        const endpoint = await tonUtils.getEndpoint();
        const client = tonUtils.createTonClient(endpoint);
        return await client.getBalance(ton.getDevWallet().address);
    });
    const addr = ton.getDevWallet().address.toString({ testOnly: config.IS_TESTNET });
    return sendOrEdit(`💳 *Wallet Status*\n\n*Address:* \`${addr}\`\n*Balance:* \`${(Number(balance) / 1e9).toFixed(4)} TON\`\n*Network:* ${config.NETWORK.toUpperCase()}\n\n*Note:* Balance may take a few seconds to update after transactions.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗝 View Seed Phrase', callback_data: 'view_seed' }],
          [{ text: '🗑 Reset Wallet', callback_data: 'confirm_reset' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  }

  if (data === 'compile_menu') {
    const sessionPath = state.getSessionPath();
    const files = fs.readdirSync(sessionPath).filter(f => f.endsWith('.tact'));
    if (files.length === 0) return bot.sendMessage(chatId, "❌ No .tact files found in this session.");
    
    return sendOrEdit(`🔨 <b>Select file to compile:</b>\nSession: <code>${state.state.currentSession}</code>`, {
      reply_markup: {
        inline_keyboard: [
          ...files.map(f => [{ text: `📄 ${f}`, callback_data: `do_compile:${state.getShort(f)}` }]),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'deploy_menu') {
    const buildDir = state.getSessionBuildDir();
    if (!fs.existsSync(buildDir)) return bot.sendMessage(chatId, "❌ No builds found. Compile first.");
    const files = fs.readdirSync(buildDir).filter(f => f.endsWith('.code.boc'));
    if (files.length === 0) return bot.sendMessage(chatId, "❌ No compiled artifacts found.");

    return sendOrEdit("🚀 <b>Select contract to deploy:</b>", {
      reply_markup: {
        inline_keyboard: [
          ...files.map(f => {
            const name = f.replace('.code.boc', '');
            return [{ text: `🚀 Deploy ${name}`, callback_data: `prep_manual_deploy:${state.getShort(name)}` }];
          }),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'interact_menu') {
    const contracts = Object.keys(state.getSession().deployed);

    return sendOrEdit("🎮 <b>Select contract to interact with:</b>", {
      reply_markup: {
        inline_keyboard: [
          ...contracts.map(c => [{ text: `🕹 ${c}`, callback_data: `int_methods:${state.getShort(c)}` }]),
          [{ text: '🎯 Manual Address', callback_data: 'prep_manual_int' }],
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ]
      },
      parse_mode: 'HTML'
    });
  }

  if (data === 'getters_menu') {
    const contracts = Object.keys(state.getSession().deployed);
    if (contracts.length === 0) return bot.sendMessage(chatId, "❌ No deployed contracts. Deploy one first!");

    return sendOrEdit("🔍 *Select contract to query:*", {
      reply_markup: {
        inline_keyboard: [
          ...contracts.map(c => [{ text: `📜 ${c}`, callback_data: `get_methods:${state.getShort(c)}` }]),
          [{ text: '⬅️ Back', callback_data: 'getters_menu' }]
        ]
      },
      parse_mode: 'Markdown'
    });
  }

  if (data === 'files_list') {
    const files = fs.readdirSync(state.getSessionPath()).filter(f => f.endsWith('.tact'));
    return sendOrEdit(`📁 *Project Files:* (Total: ${files.length})`, {
      reply_markup: { 
        inline_keyboard: [
          ...files.map(f => [{ text: `📄 ${f}`, callback_data: `view_file:${state.getShort(f)}` }]),
          [{ text: '⬅️ Back', callback_data: 'menu' }]
        ] 
      },
      parse_mode: 'Markdown'
    });
  }

  if (data.startsWith('do_compile:')) {
    const fileName = state.getLong(data.split(':')[1]);
    bot.sendMessage(chatId, `🔨 <b>Compiling ${fileName}...</b>`, { parse_mode: 'HTML' });
    compiler.queueCompileTask(async () => {
        const sessionPath = state.getSessionPath();
        const buildDir = state.getSessionBuildDir();
        
        fs.writeFileSync(path.join(sessionPath, 'contract.tact'), fs.readFileSync(path.join(sessionPath, fileName))); 
        state.getSession().lastFile = fileName; state.saveState();
        
        const t0 = Date.now();
        const tempConfigPath = path.join(sessionPath, `temp_${fileName}.json`);
        const projectName = `Target_${fileName.replace('.tact', '')}`;
        const tempConfig = {
            projects: [{
                name: projectName,
                path: `./${fileName}`,
                output: './build',
                options: { debug: true, external: true }
            }]
        };
        fs.writeFileSync(tempConfigPath, JSON.stringify(tempConfig));

        try {
            const out = fs.readFileSync(path.join(sessionPath, fileName)); // just to check file exists
            require('child_process').execSync(`npx tact --config temp_${fileName}.json 2>&1`, { cwd: sessionPath, stdio: 'pipe', timeout: 60000 });
            const dur = Date.now() - t0;
            const artifacts = fs.existsSync(buildDir) ? fs.readdirSync(buildDir).filter(f => f.startsWith(projectName)) : [];
            
            logger.info(`Bot compile OK: ${fileName} (${dur}ms)`);
            const firstContract = artifacts.find(a => a.endsWith('.code.boc'));
            const reply_markup = { inline_keyboard: [] };
            if (firstContract) {
                const cName = firstContract.replace('.code.boc', '');
                reply_markup.inline_keyboard.push([{ text: `🚀 Deploy ${cName} Now`, callback_data: `prep_manual_deploy:${state.getShort(cName)}` }]);
            }
            reply_markup.inline_keyboard.push([{ text: '⬅️ Back to Menu', callback_data: 'menu' }]);

            bot.sendMessage(chatId, `✅ <b>Compiled ${fileName} in ${dur}ms</b>\n\n<b>Artifacts:</b> ${artifacts.map(a => `<code>${a.replace('.code.boc','')}</code>`).join(', ')}`, { 
                parse_mode: 'HTML',
                reply_markup
            });
        } finally {
            if (fs.existsSync(tempConfigPath)) fs.unlinkSync(tempConfigPath);
        }
    }).catch((e) => {
        const err = e.stdout ? e.stdout.toString('utf8') : e.message;
        logger.error(`Bot compile FAIL: ${fileName}`, '', e);
        logger.error(`Bot compile output:\n${err}`);
        bot.sendMessage(chatId, `❌ <b>Compilation Failed</b>\n\n<pre>${tonUtils.escapeHTML(err.slice(0, 3000))}</pre>`, { parse_mode: 'HTML' });
    });
  }

  if (data.startsWith('prep_manual_deploy:')) {
    const name = state.getLong(data.split(':')[1]);
    return bot.sendMessage(chatId, `🚀 <b>Ready to deploy ${name}?</b>\n\nThis will use 0.05 TON to deploy the contract on ${config.NETWORK.toUpperCase()}.`, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Confirm & Deploy', callback_data: `do_deploy:${state.getShort(name)}` }],
          [{ text: '⬅️ Back', callback_data: 'deploy_menu' }]
        ]
      }
    });
  }

  if (data.startsWith('do_deploy:')) {
    const name = state.getLong(data.split(':')[1]);
    await handleDoDeploy(bot, chatId, name);
  }

  // ... (rest of actions logic)
}

async function handleDoDeploy(bot, chatId, name, args = {}) {
    logger.info(`Bot requested deploy: ${name}`);
    bot.sendMessage(chatId, `🚀 <b>Deploying ${name}...</b>`, { parse_mode: 'HTML' });
    try {
        const buildDir = state.getSessionBuildDir();
        let baseName = name;
        let codePath = path.join(buildDir, `${baseName}.code.boc`);
        let abiPath = path.join(buildDir, `${baseName}.abi`);
        let dataPath = path.join(buildDir, `${baseName}.data.boc`);
        
        if (!fs.existsSync(codePath)) {
            const files = fs.readdirSync(buildDir);
            const match = files.find(f => f.endsWith(`_${name}.code.boc`) || f === `${name}.code.boc`);
            if (match) {
                baseName = match.replace('.code.boc', '');
                codePath = path.join(buildDir, `${baseName}.code.boc`);
                abiPath = path.join(buildDir, `${baseName}.abi`);
                dataPath = path.join(buildDir, `${baseName}.data.boc`);
            }
        }

        if (!fs.existsSync(codePath)) throw new Error(`Artifacts for "${baseName}" not found. Compile first.`);
        
        const codeCell = Cell.fromBoc(fs.readFileSync(codePath))[0];
        
        let dataCell;
        if (fs.existsSync(abiPath) && Object.keys(args).length > 0) {
            const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
            const initDef = abi.init;
            if (initDef && initDef.arguments) {
                const builder = beginCell();
                initDef.arguments.forEach(f => tonUtils.packField(builder, f, args[f.name], abi));
                dataCell = builder.endCell();
            }
        }
        
        if (!dataCell) {
            dataCell = fs.existsSync(dataPath) ? Cell.fromBoc(fs.readFileSync(dataPath))[0] : beginCell().storeBit(0).endCell();
        }

        const stateInit = { code: codeCell, data: dataCell };
        const address = contractAddress(0, stateInit);
        
        const seqno = await tonUtils.withRetry(async () => {
          const endpoint = await tonUtils.getEndpoint();
          const activeClient = tonUtils.createTonClient(endpoint);
          const balance = await activeClient.getBalance(ton.getDevWallet().address);
          if (balance < 50000000n) throw new Error(`Insufficient funds.`);

          const contract = activeClient.open(ton.getDevWallet());
          let s = 0; try { s = await contract.getSeqno(); } catch (e) { s = 0; }
          await contract.sendTransfer({
            seqno: s, secretKey: ton.getWalletKey().secretKey,
            messages: [internal({ to: address, value: '0.05', bounce: false, init: stateInit, body: beginCell().storeUint(0, 32).storeStringTail('Deploy').endCell() })]
          });
          return s;
        });

        const addrStr = address.toString({ testOnly: config.IS_TESTNET });
        state.getSession().deployed[name] = addrStr; state.saveState();
        bot.sendMessage(chatId, `🎉 <b>Contract Deployed!</b>\n\n<b>Address:</b> <code>${addrStr}</code>`, { parse_mode: 'HTML' });
    } catch (e) {
        bot.sendMessage(chatId, "❌ <b>Deployment Failed</b>\n\n" + e.message);
    }
}

module.exports = {
  handleAction,
  handleDoDeploy
};

const fs = require('fs');
const path = require('path');
const { beginCell, internal, Address } = require('@ton/ton');
const config = require('../config');
const logger = require('../services/logger');
const state = require('../services/state');
const ton = require('../services/ton');
const tonUtils = require('../services/ton-utils');
const { escapeMarkdownV2 } = require('./utils');

async function handleSendMessage(bot, chatId, target, type, contractName, args) {
    logger.info(`Bot interaction (handleSendMessage): ${type} for ${contractName} to ${target}`);
    const buildDir = state.getSessionBuildDir();
    const abiPath = path.join(buildDir, `${contractName}.abi`);
    if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
    
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    const typeDef = abi.types.find(t => t.name === type);
    if (!typeDef) throw new Error(`Message type "${type}" not found in ABI`);

    bot.sendMessage(chatId, `🚀 Sending \`${type}\` to \`${contractName}\`...`, { parse_mode: 'Markdown' });
    
    const builder = beginCell();
    if (typeDef.header !== null) builder.storeUint(typeDef.header, 32);
    typeDef.fields.forEach(f => tonUtils.packField(builder, f, args[f.name], abi));
    const body = builder.endCell();

    const seqno = await tonUtils.withRetry(async () => {
        const endpoint = await tonUtils.getEndpoint();
        const client = tonUtils.createTonClient(endpoint);
        const balance = await client.getBalance(ton.getDevWallet().address);
        if (balance < 50000000n) throw new Error(`Insufficient funds.`);

        const contract = client.open(ton.getDevWallet());
        let s = 0; try { s = await contract.getSeqno(); } catch (e) { s = 0; }
        await contract.sendTransfer({
            seqno: s, secretKey: ton.getWalletKey().secretKey,
            messages: [internal({ to: Address.parseFriendly(target).address, value: '0.05', bounce: true, body })]
        });
        return s;
    });
    
    const explorerUrl = `https://${config.IS_TESTNET?'testnet.':''}tonscan.org/search?q=${seqno}`;
    bot.sendMessage(chatId, `✅ <b>Transaction Sent!</b>\nSeqno: <code>${seqno}</code>\n<a href="${explorerUrl}">View on Explorer</a>`, { parse_mode: 'HTML', disable_web_page_preview: true });
}

async function handleCallGetter(bot, chatId, target, method, contractName, args) {
    logger.info(`Bot call (handleCallGetter): ${contractName}.${method}() on ${target}`);
    const buildDir = state.getSessionBuildDir();
    const abiPath = path.join(buildDir, `${contractName}.abi`);
    if (!fs.existsSync(abiPath)) throw new Error(`ABI not found for ${contractName}`);
    
    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    const getterDef = abi.getters.find(g => g.name === method);
    if (!getterDef) throw new Error(`Getter "${method}" not found in ABI`);

    bot.sendMessage(chatId, `🔍 Calling \`${contractName}.${method}()\`...`, { parse_mode: 'Markdown' });
    
    const stack = args.map(arg => {
        if (typeof arg === 'number' || !isNaN(arg)) return { type: 'int', value: BigInt(arg) };
        if (typeof arg === 'string') {
            const normalized = arg.trim().replace(/\+/g, '-').replace(/\//g, '_');
            try { 
                const parsed = Address.parseFriendly(normalized);
                return { type: 'slice', cell: beginCell().storeAddress(parsed.address).endCell() }; 
            }
            catch (e) { return { type: 'slice', cell: beginCell().storeStringTail(arg).endCell() }; }
        }
        return arg;
    });

    try {
        const result = await tonUtils.withRetry(async () => {
            const endpoint = await tonUtils.getEndpoint();
            const client = tonUtils.createTonClient(endpoint);
            return await client.runMethod(Address.parseFriendly(target).address, method, stack);
        });

        if (result.exitCode !== 0 && result.exitCode !== undefined) {
            let msg = `❌ *Call Failed:* Exit code \`${result.exitCode}\``;
            return bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        }

        const returnType = getterDef.returnType ? getterDef.returnType.type : null;
        const resultStack = result.stack.items.map(i => tonUtils.decodeStackItem(i, returnType));
        
        bot.sendMessage(chatId, `📊 *Result:* \`${contractName}.${method}()\`\n\n\`\`\`json\n${JSON.stringify(resultStack, null, 2)}\n\`\`\``, { parse_mode: 'Markdown' });
    } catch (e) {
        bot.sendMessage(chatId, `❌ *Call Failed:* ${e.message}`);
    }
}

module.exports = {
    handleSendMessage,
    handleCallGetter
};

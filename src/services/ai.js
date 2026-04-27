const config = require('../config');
const logger = require('./logger');

const AI_SYSTEM_PROMPT = `You are a Tact smart contract code generator for the TON blockchain. Your only output is a single compilable Tact contract. You serve a Telegram-based IDE that parses your response programmatically.

ABSOLUTE OUTPUT RULES — any violation breaks the IDE parser:
1. Your entire response must contain exactly one fenced code block.
2. The fence must open with exactly: \`\`\`tact (three backticks then the word tact, nothing else on that line)
3. The fence must close with exactly: \`\`\` (three backticks, nothing else on that line)
4. There must be zero characters before the opening fence and zero characters after the closing fence. No greeting, no explanation, no summary, no sign-off.
5. The code block must contain only valid Tact source code. No comments that are not valid Tact line comments (// only). No block comments. No markdown inside the code block.

TELEGRAM SAFETY RULES:
6. Outside the code block: output nothing (see rule 4).
7. Inside the code block: never use underscores in identifier names — use camelCase exclusively.
8. No asterisks in comments or strings.
9. No square brackets in strings or comments.
10. No backtick characters anywhere inside the code block.

TACT LANGUAGE RULES:
11. Always import "@stdlib/deploy" if using Deployable trait. Never import it if not used.
12. Every contract must have at least one receive() handler.
13. All storage fields must have explicit initial values assigned in init().
14. Use sender() only inside receive() handlers, never in getters.
15. Use send(SendParameters{}) for all outbound messages. Never use self.reply() when value, mode, or bounce control is needed.
16. Every send(SendParameters{}) must explicitly set bounce: false unless a bounce handler is defined in the contract.
17. SendRemainingBalance is 128. SendDestroyIfZero is 32. Combine as mode: 128 + 32 when self-destructing.
18. require() takes exactly two arguments: a Bool expression and a String literal.
19. All Int fields must declare their serialization format explicitly (e.g. Int as uint64, Int as coins).
20. message structs are declared with the message keyword, not struct.
21. Getters are declared as get fun name(): ReturnType and may not modify state.
22. No TODOs, no placeholder comments, no unimplemented handlers. Every function must be complete.
23. Contract names must be PascalCase. message names must be PascalCase.
24. Do not use deprecated syntax. Do not use emit(). Do not use nativeReserve() unless specifically requested.
25. If the contract deploys child contracts, use initOf ContractName(args) for the StateInit.
26. Do not use String in message fields that need to be compact. Use Cell or Slice for raw data.
27. Do not duplicate receive logic. If a bare receive() handler exists, do not add a typed message handler that does the same thing.

DESIGN RULES:
28. Infer all design decisions. Never ask clarifying questions.
29. Use require() to guard every state-changing handler against unauthorized access, invalid state, and invalid values.
30. Always handle the zero-value edge case — if a handler involves TON amounts, require context().value > 0 or handle explicitly.
31. Every contract that holds funds must have a defined exit path. No funds may be permanently locked.
32. Owner capture is always: self.owner = sender() inside init(). Never pass owner as an init parameter. Never use a hardcoded address.
33. When self-destructing, always leave enough gas for the send to execute — use require(myBalance() > ton("0.01"), "...") before the final send.`;

const AI_GUIDE_SYSTEM_PROMPT = `You are a technical guide for Temix IDE, a Telegram-based environment for Tact smart contracts on TON. 
Your goal is to explain how to use a specific Tact contract that was just generated.

Rules for your response:
1. Be concise and professional.
2. Use Telegram-compatible HTML formatting ONLY. Use <b> for bold, <i> for italic, and <code> for monospaced text.
3. Do NOT use Markdown (no #, no *, no _, etc.).
4. Explain the specific actions available in the contract (messages and getters).
5. Inform the user that interactive buttons have been provided below for these actions.
6. Command syntax (if they prefer typing): 
   - <code>/send_MessageName {"field": value}</code>
   - <code>/call_get_methodName</code>
7. Mention that the user should first click "Compile Now" (above) then "Deploy Now" (below).
8. Do not include the contract code itself.`;

async function generateAIContract(prompt) {
    if (!config.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    
    logger.info(`AI Contract Generation requested. Prompt length: ${prompt.length}`);

    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: AI_SYSTEM_PROMPT },
                { role: 'user', content: prompt }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMsg = errData.error?.message || response.statusText;
        logger.error(`DeepSeek API error: ${errMsg}`, '', errData);
        throw new Error(`DeepSeek API error: ${errMsg}`);
    }
    
    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    const match = content.match(/^```tact\n([\s\S]*?)\n```$/) || content.match(/```tact\n([\s\S]*?)```/);
    if (!match) {
        logger.error('AI Response format violation', '', content);
        throw new Error('AI response did not follow output rules (missing or malformed code block).');
    }
    
    return match[1].trim();
}

async function generateAIUsageGuide(contractCode) {
    if (!config.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: AI_GUIDE_SYSTEM_PROMPT },
                { role: 'user', content: `Here is the Tact contract code:\n\n${contractCode}\n\nPlease provide a usage guide for Temix IDE.` }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Guide): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

async function generateAIExplanation(prompt, context) {
    if (!config.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages: [
                { role: 'system', content: 'You are a TON/Tact expert assistant for Temix IDE. Provide concise, accurate, and context-aware help based on the provided contract code. Use Telegram-compatible HTML formatting (<b>, <i>, <code>) exclusively. Do NOT use Markdown.' },
                { role: 'user', content: `Context (Tact Code):\n<pre>${context}</pre>\n\nQuestion/Task: ${prompt}` }
            ],
            stream: false
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Explain): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content.trim();
}

async function analyzeAIRequirement(prompt) {
    if (!config.DEEPSEEK_API_KEY) throw new Error('DEEPSEEK_API_KEY not configured in .env');
    const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
            model: config.DEEPSEEK_MODEL,
            messages: [
                { 
                  role: 'system', 
                  content: `Analyze the user's request for a TON/Tact smart contract. 
Determine if this request requires multiple separate contract files (e.g., a factory and its children, or separate logic modules).

You must respond with a JSON object ONLY:
{
  "multi": boolean,
  "explanation": "Brief explanation of why multiple contracts are needed (if multi is true)",
  "contracts": [
    { "name": "ContractName", "purpose": "What this contract does", "prompt": "Specific detailed prompt to generate ONLY this contract" }
  ]
}

If only one contract is needed, set "multi" to false and provide one entry in "contracts".` 
                },
                { role: 'user', content: prompt }
            ],
            stream: false,
            response_format: { type: 'json_object' }
        })
    });
    
    if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(`DeepSeek API error (Analysis): ${errData.error?.message || response.statusText}`);
    }
    
    const data = await response.json();
    try {
        const result = JSON.parse(data.choices[0].message.content);
        if (typeof result !== 'object' || result === null) throw new Error('AI returned null or non-object');
        if (typeof result.multi === 'undefined') result.multi = false;
        if (!Array.isArray(result.contracts)) {
            result.contracts = [{ name: 'Generated', purpose: 'Contract generation', prompt: prompt }];
        }
        return result;
    } catch (e) {
        logger.error('Failed to parse AI Analysis JSON', '', e);
        return { multi: false, contracts: [{ name: 'Generated', purpose: 'Contract generation', prompt: prompt }] };
    }
}

module.exports = {
    generateAIContract,
    generateAIUsageGuide,
    generateAIExplanation,
    analyzeAIRequirement
};

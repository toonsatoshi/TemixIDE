const { TonClient, Address, Cell } = require('@ton/ton');
const { getHttpEndpoint } = require('@orbs-network/ton-access');
const config = require('../config');
const logger = require('./logger');

async function getEndpoint() {
  const isTestnet = config.NETWORK === 'testnet';
  const toncenter = isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
  
  const providers = [
    () => toncenter,
    async () => await getHttpEndpoint({ network: config.NETWORK }),
  ];
  
  for (let i = 0; i < providers.length; i++) {
    try {
      const url = await providers[i]();
      if (url) {
        logger.debug(`Selected RPC endpoint: ${url}`);
        return url;
      }
    } catch (e) {
      logger.debug(`Provider ${i} failed: ${e.message}`);
    }
  }
  const fallback = isTestnet ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
  logger.warn(`All providers failed, using fallback: ${fallback}`);
  return fallback;
}

function createTonClient(endpoint) {
    const tonConfig = { endpoint };
    if (endpoint.includes('toncenter.com')) {
        tonConfig.apiKey = config.TONCENTER_API_KEY;
    }
    return new TonClient(tonConfig);
}

async function withRetry(fn, retries = 10, id = '') {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      logger.trace(`RPC Call attempt ${i + 1}/${retries}`, id);
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = e.message || String(e);
      const isRetryable = msg.includes('502') || msg.includes('500') || msg.includes('429') || 
                          msg.includes('ECONNRESET') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') ||
                          msg.toLowerCase().includes('timeout') || 
                          msg.includes('getseqno') || msg.includes('execution reversed');

      if (isRetryable) {
        const wait = (2000 * (i + 1)) + Math.random() * 1000; 
        logger.warn(`RPC error (retryable): ${msg.slice(0,200)}. Retrying (${i+1}/${retries}) in ${Math.round(wait)}ms...`, id);
        // wsBroadcast is not available here, but we can emit an event or just log
        await new Promise(r => setTimeout(r, wait));
      } else {
        logger.error(`RPC error (non-retryable): ${msg}`, id, e);
        throw e;
      }
    }
  }
  logger.error(`RPC max retries reached (${retries})`, id, lastErr);
  throw lastErr;
}

function decodeStackItem(item, typeName) {
  if (!item) return null;
  if (item.type === 'int') {
    const val = item.value;
    return (val <= BigInt(Number.MAX_SAFE_INTEGER) && val >= BigInt(Number.MIN_SAFE_INTEGER)) 
      ? Number(val) 
      : val.toString();
  }
  if (item.type === 'cell') {
    if (typeName === 'string') {
      try { return item.cell.beginParse().loadStringTail(); } catch (e) { return '[Invalid String Cell]'; }
    }
    return '[Cell]';
  }
  if (item.type === 'slice') {
    if (typeName === 'address') {
      try { return item.cell.beginParse().loadAddress().toString({ testOnly: config.IS_TESTNET }); } catch (e) { return '[Invalid Address Slice]'; }
    }
    if (typeName === 'string') {
        try { return item.cell.beginParse().loadStringTail(); } catch (e) { return '[Invalid String Slice]'; }
    }
    return '[Slice]';
  }
  return item.value;
}

function packField(builder, field, value, abi) {
  const type = field.type;
  if (type.kind !== 'simple') throw new Error(`Unsupported field kind: ${type.kind}`);
  
  const format = field.type.format;
  const typeName = field.type.type;
  const isOptional = !!field.type.optional;

  logger.trace(`Packing field ${field.name} (${typeName}, format: ${format}, optional: ${isOptional}) with value: ${JSON.stringify(value)}`);

  try {
    if (isOptional) {
      if (value === undefined || value === null || value === '') {
        logger.trace(`Optional field ${field.name} is empty, storing bit 0`);
        builder.storeBit(0);
        return;
      }
      builder.storeBit(1);
      logger.trace(`Optional field ${field.name} has value, stored bit 1`);
    }

    switch (typeName) {
      case 'int':
      case 'uint': {
        if (value === undefined || value === null || value === '') {
          throw new Error(`Value for field "${field.name}" is required`);
        }
        const bits = typeof format === 'number' ? format : (format === 'coins' ? 124 : 257);
        if (format === 'coins') {
          logger.trace(`Storing coins: ${value}`);
          builder.storeCoins(BigInt(value));
        } else {
          logger.trace(`Storing ${typeName} (${bits} bits): ${value}`);
          if (typeName === 'uint') builder.storeUint(BigInt(value), bits);
          else builder.storeInt(BigInt(value), bits);
        }
        break;
      }
      case 'address': {
        if (!value) throw new Error(`Address for field "${field.name}" is required`);
        try {
          const normalized = String(value).trim().replace(/\+/g, '-').replace(/\//g, '_');
          const parsed = Address.parseFriendly(normalized);
          logger.trace(`Storing address: ${parsed.address.toString()}`);
          builder.storeAddress(parsed.address);
        } catch (e) {
          throw new Error(`Invalid address for "${field.name}": ${e.message}`);
        }
        break;
      }
      case 'bool': {
        const boolVal = value === true || value === 'true' || value === '1';
        logger.trace(`Storing bool: ${boolVal}`);
        builder.storeBit(boolVal);
        break;
      }
      case 'string': {
        const strVal = String(value || '');
        logger.trace(`Storing string: "${strVal}"`);
        const cell = beginCell().storeStringTail(strVal).endCell();
        builder.storeRef(cell);
        break;
      }
      case 'fixed-bytes': {
        const size = typeof format === 'number' ? format : 32;
        let buf;
        if (typeof value === 'string') {
          buf = Buffer.from(value.startsWith('0x') ? value.slice(2) : value, 'hex');
        } else if (Buffer.isBuffer(value)) {
          buf = value;
        } else {
          throw new Error(`Expected hex string or Buffer for "${field.name}"`);
        }
        if (buf.length !== size) throw new Error(`Expected ${size} bytes for "${field.name}", got ${buf.length}`);
        logger.trace(`Storing ${size} fixed-bytes: ${buf.toString('hex')}`);
        builder.storeBuffer(buf);
        break;
      }
      case 'slice':
      case 'cell': {
        if (!value) {
          if (typeName === 'cell') {
              logger.trace(`Empty cell for ${field.name}, storing empty cell ref`);
              builder.storeRef(Cell.EMPTY);
          }
          else throw new Error(`Value for field "${field.name}" (slice) is required`);
        } else {
          try {
            const cell = Cell.fromBoc(Buffer.from(value, 'hex'))[0];
            logger.trace(`Storing ${typeName} from BOC: ${value.slice(0, 64)}...`);
            if (typeName === 'cell') builder.storeRef(cell);
            else builder.storeSlice(cell.beginParse());
          } catch (e) {
            throw new Error(`Invalid hex/BOC for "${field.name}": ${e.message}`);
          }
        }
        break;
      }
      default: {
        // Handle nested structs
        const nestedType = abi && abi.types ? abi.types.find(t => t.name === typeName) : null;
        if (nestedType) {
          logger.trace(`Packing nested struct ${typeName} for field ${field.name}`);
          if (typeof value !== 'object' || value === null) {
            throw new Error(`Expected object for nested type "${typeName}" in field "${field.name}"`);
          }
          nestedType.fields.forEach(f => {
            packField(builder, f, value[f.name], abi);
          });
        } else {
          throw new Error(`Unsupported type: ${typeName}`);
        }
      }
    }
  } catch (e) {
    if (e.message.includes('field "') || e.message.includes('for "')) throw e;
    throw new Error(`Error packing field "${field.name}": ${e.message}`);
  }
}

const safeJsonParse = (str) => {
  if (!str) return null;
  const sanitized = String(str)
    .replace(/[\u201C\u201D]/g, '"')  // " " → "
    .replace(/[\u2018\u2019]/g, "'")  // ' ' → '
    .replace(/\u00A0/g, ' ')          // Non-breaking space → space
    .replace(/[\u1680\u180e\u2000-\u200a\u202f\u205f\u3000]/g, ' '); // Other exotic spaces
  try {
    return JSON.parse(sanitized);
  } catch (e) {
    return null;
  }
};

const escapeHTML = (str) => {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
};

module.exports = {
  getEndpoint,
  createTonClient,
  withRetry,
  decodeStackItem,
  packField,
  safeJsonParse,
  escapeHTML
};

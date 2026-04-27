const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('./logger');

const STATE_FILE = config.PATHS.STATE_FILE;
const SESSIONS_DIR = config.PATHS.SESSIONS_DIR;

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

let state = {
  currentSession: 'default',
  sessions: {
    'default': {
      deployed: {},
      lastFile: 'contract.tact',
      txHistory: []
    }
  },
  authorizedUsers: config.AUTHORIZED_USERS,
  short: {} // { shortKey: longValue }
};

function getSession() {
  if (!state.sessions) state.sessions = {};
  if (!state.currentSession) state.currentSession = 'default';
  if (!state.sessions[state.currentSession]) {
    state.sessions[state.currentSession] = { deployed: {}, lastFile: 'contract.tact', txHistory: [] };
  }
  return state.sessions[state.currentSession];
}

function getSessionPath() {
  const p = path.join(SESSIONS_DIR, state.currentSession);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getSessionBuildDir() {
  const p = path.join(getSessionPath(), 'build');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function getSessionLogDir() {
  const p = path.join(getSessionPath(), 'logs');
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      
      // Migration: if old state format (no sessions)
      if (loaded.deployed && !loaded.sessions) {
        state.sessions.default.deployed = loaded.deployed || {};
        state.sessions.default.lastFile = loaded.lastFile || 'contract.tact';
        state.sessions.default.txHistory = Array.isArray(global.txHistory) ? global.txHistory : [];
        state.authorizedUsers = loaded.authorizedUsers || state.authorizedUsers;
        state.short = loaded.short || {};
        logger.info("Migrated old state to session 'default'");
      } else {
        state = { ...state, ...loaded };
      }
      logger.info(`State loaded from ${STATE_FILE} (Session: ${state.currentSession})`);
    } catch (e) { logger.error('Failed to load state', '', e); }
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    logger.debug(`State saved to ${STATE_FILE}`);
  } catch (e) { logger.error('Failed to save state', '', e); }
}

function addHistory(tx) {
  const session = getSession();
  if (!session.txHistory) session.txHistory = [];
  session.txHistory.unshift(tx);
  if (session.txHistory.length > 10) session.txHistory.pop();
  saveState();
}

function getShort(val) {
  if (!val) return '';
  if (val.length < 8) return val;
  for (const [k, v] of Object.entries(state.short || {})) {
    if (v === val) return k;
  }
  const k = `_${Math.random().toString(36).slice(2, 7)}`;
  state.short = state.short || {};
  state.short[k] = val;
  saveState();
  return k;
}

function getLong(k) {
  if (k && k.startsWith('_')) {
    return (state.short || {})[k] || k;
  }
  return k;
}

function switchSession(name) {
  if (state.sessions[name]) {
    state.currentSession = name;
    saveState();
    return true;
  }
  return false;
}

function createSession(name) {
  if (!state.sessions[name]) {
    state.sessions[name] = { deployed: {}, lastFile: 'contract.tact', txHistory: [] };
    state.currentSession = name;
    saveState();
    return true;
  }
  return false;
}

function deleteSession(name) {
  if (name === 'default') return false;
  if (state.sessions[name]) {
    delete state.sessions[name];
    if (state.currentSession === name) {
      state.currentSession = 'default';
    }
    const sessionPath = path.join(SESSIONS_DIR, name);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
    saveState();
    return true;
  }
  return false;
}

loadState();

module.exports = {
  state,
  getSession,
  getSessionPath,
  getSessionBuildDir,
  getSessionLogDir,
  saveState,
  addHistory,
  getShort,
  getLong,
  switchSession,
  createSession,
  deleteSession
};

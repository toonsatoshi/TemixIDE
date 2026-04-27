# TemixIDE Development Plan & Roadmap

This document outlines the strategic tasks required to move TemixIDE from a functional prototype to a production-ready Telegram IDE for Tact smart contracts.

## 🎯 Project Overview
TemixIDE is a backend-driven IDE for the TON blockchain, utilizing DeepSeek AI for contract generation and the official Tact compiler for verification. Current status is "Functional Prototype" with a single-user focus.

---

## 🔴 Priority 1: Critical Beta Blockers
*These tasks must be completed before opening the bot to a wider audience to prevent data corruption and service abuse.*

- [ ] **Multi-User Session Isolation**
    - Replace the global `state.currentSession` with a per-user mapping: `state.userSessions[chatId]`.
    - Update all path-building functions (`getSessionPath`, `getSessionBuildDir`, etc.) to accept a `chatId` or `sessionName` parameter.
    - Ensure filesystem paths are correctly namespaced: `sessions/{chatId}/{sessionName}/`.
- [ ] **Bot-Level Rate Limiting**
    - Implement a per-user cooldown for `/forge` and `/compile` commands.
    - Prevent AI API budget exhaustion by limiting a single user to $X$ generations per hour.
- [ ] **Input Sanitization for Bot Handlers**
    - Hardened regex validation for session names and filenames provided via Telegram text inputs to prevent path traversal.

---

## 🟡 Priority 2: Reliability & Scalability
*Focuses on UX and the "smoothness" of the development lifecycle.*

- [ ] **Transaction FIFO Queue**
    - Implement an async queue per wallet to handle deployments.
    - Ensure sequential processing of transactions to eliminate `seqno` mismatch errors during parallel usage.
- [ ] **Auto-Generated Test Wallets**
    - Implement logic to generate a unique `WalletContractV4` for new sessions.
    - Create a "Master Faucet" system to auto-fund new wallets with ~2 Test TON upon creation.
    - Encrypt session-specific mnemonics at rest if stored in `state.json`.
- [ ] **Enhanced AI Validation (Logical Check)**
    - Beyond syntax checking, implement a "Sanity Test" phase using `tact-emulator` or `ton-sandbox`.
    - Verify that the generated contract has at least one owner-protected method and one getter.

---

## 🔵 Priority 3: Production & Mainnet Hardening
*Long-term goals for professional-grade deployment.*

- [ ] **TonConnect Integration**
    - Develop a web-view or deep-link flow to allow users to sign transactions via Tonkeeper/MyTonWallet instead of relying on server-side private keys.
- [ ] **Persistent Database Migration**
    - Move `state.json` metadata to a real database (SQLite or PostgreSQL) for better concurrency and ACID compliance.
- [ ] **Artifact Inspector Web UI**
    - Expand the `public/` folder to provide a full-screen web inspector for ABI and BOC files, linked from the Telegram bot.
- [ ] **Advanced Logging & Audit Trails**
    - Implement structured logging for all AI generations and deployments for future model fine-tuning and security auditing.

---

## 🛠 Implementation Strategy
1.  **Phase 1 (Isolation):** Resolve the global session pointer to enable concurrent users.
2.  **Phase 2 (Protection):** Add the bot-level rate limiting and input hardening.
3.  **Phase 3 (Expansion):** Roll out the auto-generated wallets and transaction queuing.

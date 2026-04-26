# TemixIDE v2.0 — Hardened Production Edition

A professional-grade TON smart contract IDE for the Tact language.

## What's New in v2.0
- Rate limiting (60/min global · 10/min for heavy endpoints)
- Gzip compression on all responses
- WebSocket live log console in the browser
- Request ID tracing across server and browser logs
- Graceful shutdown (SIGINT/SIGTERM) with 5s forced-exit fallback
- Auto-backup of existing workspace on re-run
- TX history persisted in localStorage
- Resizable editor/sidebar panels
- Build artifact inspector with compiler output
- Ctrl+Enter keyboard shortcut to compile
- Error line highlighting in Monaco editor
- `/api/artifacts` and `/api/tx-history` endpoints
- DELETE `/api/wallet` for safe wallet reset with backup
- **New in v2.1:** Advanced Telegram Bot with Inline Keyboards, Persistent Deployed Addresses, and ABI-aware Getters.

## Telegram Bot (TemixIDE)
| Feature | Description |
|---------|-------------|
| 💳 Wallet | Check balance & address via TON API |
| 🔨 Compile | Select and compile any `.tact` file in workspace |
| 🚀 Deploy | Select compiled artifact and deploy to network |
| 🔍 Getters | Interactive list of read-only methods for deployed contracts |
| 📁 Files | View workspace contents and upload new `.tact` files |
| 📋 History | View recent server-side transactions |

## Environment Variables
| Variable | Default | Description |
|----------|---------|-------------|
| TACT_PORT | 3000 | HTTP/WS port |
| TACT_ENV | development | Environment label |
| TACT_NETWORK | testnet | TON network target |
| TELEGRAM_BOT_TOKEN | - | Bot token from @BotFather |
| TELEGRAM_AUTHORIZED_ID | - | Optional: CSV list of user IDs for restricted access |

## Security Notes
- `dev-wallet.json` is git-ignored — NEVER commit it
- Helmet.js headers enabled (CSP off for Monaco)
- For mainnet: set TACT_NETWORK=mainnet and audit thoroughly

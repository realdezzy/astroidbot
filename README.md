# AstroidBot

AstroidBot is an AI-powered automated trading bot and web dashboard for the Stacks blockchain. It combines a Telegram bot interface, a React web dashboard, autonomous AI agents, and multi-strategy trading automation.

## Features

### AI Automation
- **AI Trading Agents** with three modes: Advisor (suggests trades), Autonomous (executes independently), Off (deterministic strategies only)
- **Natural language commands** — type "buy 10 STX for sUSDT" or "show my portfolio" in Telegram or the web dashboard
- **LLM-powered strategy analysis** — AI generates portfolio targets, grid spreads, and market sentiment

### Trading Strategies
- **Portfolio Rebalancing** — AI-driven target weights, threshold-based rebalancing
- **Grid Market Making** — configurable buy/sell bands around current prices
- **Dollar Cost Averaging (DCA)** — periodic buys at fixed intervals
- **Token Sniper** — auto-buy newly listed tokens matching your watchlist
- **Copy Trading** — mirror trades from a target wallet
- **Limit Orders** — set and forget buy/sell orders at target prices

### Interfaces
- **Telegram Bot** — full trading bot with inline keyboards, natural language AI, wallet management, agent control
- **Web Dashboard** — React dashboard with TradingView financial charts, portfolio tracking, trade execution

### Platform Features
- **Multi-DEX routing** — ALEX and Bitflow providers, automatic best-price routing
- **Wallet management** — generate, import, reveal (password-protected), encrypted at rest with AES-256-GCM
- **BullMQ job queues** — async trade execution with retry logic and priority (SELL > BUY)
- **WebSocket real-time updates** — trade confirmations, cycle completions
- **Multi-wallet support** — manage multiple Stacks wallets per account

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js, TypeScript, Express v5 |
| Database | PostgreSQL + Prisma ORM |
| Queue | BullMQ + Redis |
| AI | DeepSeek / OpenAI / Google Gemini |
| Telegram | GrammY bot framework |
| Frontend | React 19, Vite 6, Tailwind CSS v4, TradingView Lightweight Charts |
| Blockchain | @stacks/transactions, ALEX SDK v2 |
| Infra | Docker Compose (PostgreSQL, Redis, Bot) |

## Getting Started

### Prerequisites
- Docker and Docker Compose
- Node.js 20+ (for local dev)

### Quick Start (Docker)
```bash
cp .env.example .env.docker
# Edit .env.docker — set DEEPSEEK_API_KEY, TELEGRAM_BOT_TOKEN, AES_KEY, JWT_SECRET
docker compose up --build -d
# Bot available on http://localhost:8006
```

### Local Development
```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma db push
npm run dev        # Backend on :8006
cd web && npm run dev  # Frontend on :5173
```

## API

Base URL: `http://localhost:8006/api`

- `GET /api/health` — health check
- `POST /api/auth/email/register` — email signup
- `POST /api/auth/email/login` — email login
- `POST /api/auth/refresh` — JWT refresh token rotation
- `GET /api/me` — user profile
- `GET /api/me/wallets` — list wallets
- `POST /api/me/wallets/generate` — create new wallet
- `POST /api/me/wallets/import` — import private key
- `POST /api/me/trades/execute` — execute swap
- `GET /api/me/trades/quote` — preview swap quote
- `GET /api/me/strategies` — list trading strategies
- `GET /api/me/agents` — list AI agents
- `POST /api/me/agents/:id/run` — run agent cycle
- `POST /api/ai/command` — natural language command parsing
- `GET /api/admin/queues` — BullMQ queue stats

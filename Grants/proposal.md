# Stacks Foundation Grant Application: AstroidBot

## Project Overview
- **Project Name**: AstroidBot
- **Category**: Developer Tooling / DeFi Infrastructure
- **Requested Funding**: $5,000 USD

---

## 1. Problem Statement
The Stacks DeFi ecosystem lacks automated trading tools. Currently, traders must manually execute and sign every transaction. There are no mechanisms for setting limit orders, establishing trailing stops, or writing natural-language execution queries. AstroidBot addresses this gap by implementing an off-chain condition monitor and transaction queue that automates interactions with Stacks DEXs (ALEX, Bitflow, Velum), enabling programmatic and conversational trading.

*Read more in [Problem Statement](problem_statement.md).*

---

## 2. Proof of Concept & Architecture
AstroidBot has a functional, responsive dashboard and backend:
- **Express Backend**: Connects to the Stacks network, ALEX SDK, and LLMs for command execution.
- **Vite React Frontend**: Visualizes user assets, active agents, limit orders, and execution histories.
- **Task Queue**: Managed via Redis and BullMQ to check price conditions and process orders asynchronously.

*Read more in [Proof of Concept](proof_of_concept.md).*

---

## 3. Milestones & Deliverables
We propose a 12-week development timeline split into four key milestones:
1. **Milestone 1 (Weeks 1-3)**: Multi-Agent Orchestration & Natural Language Processing.
2. **Milestone 2 (Weeks 4-6)**: Multi-DEX Integration & Smart Order Routing (SOR).
3. **Milestone 3 (Weeks 7-9)**: Advanced Order Types (DCA, Trailing Stops) & Self-Healing Queue.
4. **Milestone 4 (Weeks 10-12)**: Production Deployment & Mainnet Release.

*Read more in [Milestones & Deliverables](milestones.md).*

---

## 4. Budget & Funding Allocation
The $5,000 grant budget will be allocated as follows:
- **Infrastructure & RPCs**: $800 (6 months of server and node access).
- **AI APIs**: $600 (OpenAI & Gemini model access).
- **Security Audit**: $1,200 (External security review of key storage and signing).
- **Development**: $1,800 (Engineering compensation for DEX integrations and order logic).
- **Testing & Docs**: $600 (Beta tester rewards and documentation hosting).

*Read more in [Budget Breakdown](budget.md).*

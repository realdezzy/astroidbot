# Stacks Grant Proposal: Milestones & Deliverables

We propose a 12-week development timeline broken down into 4 clear milestones.

## Milestone Timeline

### Milestone 1: Multi-Agent Orchestration & Natural Language Processing
- **Duration**: Weeks 1-3
- **Objective**: Refactor strategy handling to support parent-child agent routing and improve NLP reliability.
- **Deliverables**:
  - Implementation of Agent-Strategy schemas in backend.
  - Core command parser refinement to support complex conditional logic (e.g., "If STX drops below $1.50, buy, then sell if it gains 10%").
  - Test suite validating agent-to-strategy execution isolation.
- **Validation Criteria**:
  - Backend and frontend build successfully.
  - Unit tests verify that agents execute tasks using their dedicated sub-wallets.

### Milestone 2: Multi-DEX Integration & Smart Order Routing (SOR)
- **Duration**: Weeks 4-6
- **Objective**: Expand liquidity routing beyond ALEX to include Bitflow and Velum.
- **Deliverables**:
  - Wrapper services for Velum and Bitflow swap executions.
  - Smart Order Routing (SOR) module that fetches rates across ALEX, Bitflow, and Velum to select the best execution path.
  - Real-time fee and slippage optimization displays on the dashboard.
- **Validation Criteria**:
  - Dynamic route selection demonstrated in staging environment.
  - Verification logs showing route splits or redirection based on optimal fees/slippage.

### Milestone 3: Advanced Order Types & Self-Healing Queue
- **Duration**: Weeks 7-9
- **Objective**: Implement DCA (Dollar-Cost Averaging), Trailing Stops, and transaction self-healing.
- **Deliverables**:
  - DCA scheduler job in BullMQ.
  - Trailing stop-loss monitoring engine checking price tick changes.
  - Nonce manager and automated transaction fee multiplier for stuck transactions.
- **Validation Criteria**:
  - Stacks Testnet simulation running DCA and stop-losses over 72 hours without manual intervention.
  - Automated detection and replacement (speed-up) of pending low-fee transactions.

### Milestone 4: Production Deployment & Mainnet Release
- **Duration**: Weeks 10-12
- **Objective**: Hardening, documentation finalization, and public mainnet launch.
- **Deliverables**:
  - Codebase security hardening (credential protection, rate-limit settings).
  - Clean public developer and user documentation.
  - Production deployment (Dockerized, hosted on scalable VPS).
- **Validation Criteria**:
  - Live mainnet application accessible to beta testers.
  - Zero critical issues reported during final integration tests.

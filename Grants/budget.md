# Stacks Grant Proposal: Budget Breakdown ($5K USD)

Below is the proposed allocation of the $5,000 grant funding to move AstroidBot from prototype to production.

| Category | Description | Cost (USD) |
| :--- | :--- | :--- |
| **Infrastructure & RPCs** | High-performance RPC nodes (Hiro, QuickNode) and server hosting (VPS, Postgres, Redis) for 6 months. | $800 |
| **AI API Costs** | API credits for OpenAI (Whisper, GPT-4o) and Gemini models to support voice and text command parsing. | $600 |
| **Security Audit** | External review of wallet management, key storage (Privy TEE), and transaction signing processes. | $1,200 |
| **Development** | Compensation for integration of Velum/Bitflow SDKs, Smart Order Routing logic, and self-healing transaction loops. | $1,800 |
| **Testing & Docs** | Beta testing incentives for community users and hosting costs for public documentation. | $600 |
| **Total** | | **$5,000** |

---

## Detailed Allocations

### 1. Infrastructure & RPC Nodes ($800)
To run automated trading bots, AstroidBot requires high-frequency, reliable connection to Stacks nodes.
- Dedicated RPC endpoints: $50/month × 6 months = $300.
- Cloud Hosting (VPS for backend/frontend + managed database and Redis): $83/month × 6 months = $500.

### 2. AI APIs ($600)
Supports processing voice and text inputs for conversational command execution.
- LLM API usage: $100/month × 6 months = $600.

### 3. Security Audit ($1,200)
Since AstroidBot manages Stacks keys and executes trades, securing the keys is our top priority. We will contract a security researcher to review:
- Key encryption in transit and at rest.
- Privy TEE integration configurations.

### 4. Development ($1,800)
Covers engineering time required to build the multi-DEX routing logic, fee estimators, and order triggers.

### 5. Testing & Docs ($600)
Provides rewards to the first 50 beta traders who provide feedback, and covers the setup of public documentation tools.

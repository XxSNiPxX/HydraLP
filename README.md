# HydraLP — Autonomous USD₮ Capital Allocator

> HydraLP is an autonomous system that takes USD₮ and continuously reallocates it across DeFi strategies to maximize yield — without user intervention.

**Submission for Tether Hackathon Galactica — Autonomous DeFi Agent Track**

---

## 🔁 Capital Lifecycle

```
USD₮ → Deploy → Earn Yield → Rebalance → Return to USD₮
```

HydraLP continuously cycles capital through this loop autonomously.

---

## 🧠 System Overview

HydraLP is a three-layer autonomous system:

- **Agent (Client)** — decides *when and why* to act (LLM + WDK wallet)
- **Optimizer (Backend)** — prevents irrational or unsafe capital flows
- **Executor (Backend)** — builds and executes on-chain transactions

**Key property:**
- The AI plans but never acts
- The optimizer constrains but never decides
- The executor acts but never thinks

No single layer can cause catastrophic loss.

---

## 🔒 Proprietary Backend

HydraLP uses a production-grade backend for:
- real-time pool intelligence
- capital flow optimization
- transaction construction

This repository includes:
- full autonomous agent (decision-making, WDK wallet, execution)
- interface layer to backend
- architecture and execution pipeline

The backend itself is not fully included due to its proprietary nature.
Its structure and interaction model are documented in `/proprietary`.

This reflects the real system design:
- user owns keys (client)
- backend provides intelligence
- no shared custody

---

## ⚙️ What It Does

HydraLP autonomously manages liquidity positions on Solana (Raydium CLMM).

- An LLM analyzes wallet + market state
- Generates a structured plan
- Backend validates + optimizes it
- Client signs and executes transactions via WDK

All capital allocation decisions are evaluated in **USD₮ terms**.

The agent:
- deploys USD₮ into USD₮-paired pools
- captures yield
- rebalances when positions drift
- returns capital back to USD₮

No manual intervention required.

---

## 🧩 Architecture

```
PROPRIETARY BACKEND (Rust, shared infrastructure)
├── Poolwatcher         — live tick data, LP discovery, Jupiter prices
├── Capital optimizer   — token flow analysis, doom-swap prevention
├── Position executor   — CLMM math, Raydium TX construction, Jupiter swaps
└── Gateway             — wallet-ownership auth, per-agent data filtering

    ↕ WebSocket + REST (any client can subscribe)

CLIENT AGENT (Node.js, user-deployed)
├── WDK wallet          — keys on user's machine, signs all TXs
├── SKILL.md rules      — strategy prompt (swappable)
├── Plan validator       — schema checks, capital flow safety
├── LLM connection      — Claude (or any provider)
└── Dashboard UI        — portfolio, positions, brain, execution
```

Each client is fully sovereign — different wallets, strategies, and LLM providers. They share the intelligence backend but never share keys, decisions, or capital.

---

## 📁 Repository Structure

```
/agents-server      → autonomous agent (LLM, WDK wallet, execution)
/autobots-gateway   → authentication + routing layer
/autobots-server    → optimization + execution backend
/SKILL.md           → strategy definition (LLM behavior)
```

> Note: `autobots-server` represents the core execution logic.
> Full production backend is partially abstracted.

---

## 🧠 Agent Intelligence

The agent receives:
- wallet balances
- pool state
- token prices
- existing positions

It outputs:
- structured execution plans
- explicit reasoning (logged + visible)

### Example Output

```json
{
  "steps": [...],
  "reasoning": [
    "closing position near upper range",
    "reopening with wider range",
    "reusing tokens, no swap required"
  ]
}
```

---

## 🛡️ Safety Model

Safety is enforced across layers:

```
LLM          → constrained by SKILL rules
Orchestrator → validates + reorders steps
Optimizer    → prevents doom-swaps
Executor     → enforces feasibility
WDK          → guarantees self-custody
```

Worst case: the agent does nothing, not loses funds.

---

## 🔑 WDK Integration

WDK is the only key management layer.

- **Wallet creation** — seed phrase via `getRandomSeedPhrase()`
- **Account derivation** — Solana keypair from WDK seed
- **Transaction signing** — all on-chain actions signed by WDK keypair
- **Authentication** — wallet proves ownership via signed Memo TX with server nonce

Keys never leave the client runtime. The LLM never sees key material. The backend never accesses private keys. Self-custody is enforced by architecture, not policy.

---

## 🚀 Demo

**Live dashboard:** [coreengine.site](https://www.coreengine.site/)

Real-time views:
- **Portfolio** — balances, prices, USD values
- **Positions** — tick ranges vs current price
- **Brain** — LLM reasoning as it happens
- **Execution** — step-by-step plan progress
- **Transactions** — Solscan-linked TX history
- **Diagnostics** — RPC latency, wallet status, connectivity

The agent runs autonomously. The UI is observational only.

---

## ⚡ What Makes This Different

- **USD₮-first capital model** — stablecoin-denominated strategies
- **True autonomy** — agent decides *when and why*, not just how
- **Global capital optimization** — multi-step token flow reasoning
- **Separated intelligence** — AI cannot directly execute
- **Self-custodial by architecture** — not by promise
- **Works on small wallets ($10–50)** — optimized for low capital

---

## 🧪 Running

```bash
# backend
cd autobots-server && cargo run

# gateway
cd autobots-gateway && cargo run

# agent
cd agents-server
npm install
node server.js
```

Fund the WDK wallet → agent runs autonomously.

---

## 📊 Status

- ✅ Autonomous execution loop implemented
- ✅ Real on-chain transactions (Solana mainnet)
- ✅ Live dashboard + reasoning trace
- ✅ USD₮-denominated capital allocation
- ✅ Designed for small capital ($10–50)

---

## 🧠 Core Insight

HydraLP is not a bot. It is a continuous autonomous capital allocation system.

---

## License

Apache 2.0

# HydraLP — Autonomous USD₮ Capital Allocator

> HydraLP is an autonomous system that takes USD₮ and continuously reallocates it across DeFi strategies to maximize yield — without user intervention.

**Submission for Tether Hackathon Galactica — Autonomous DeFi Agent Track**

---

## 🔁 Capital Lifecycle

USD₮ → Deploy → Earn Yield → Rebalance → Return to USD₮

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

![Architecture Diagram](your-image-here)

### Flow
→ Executor (transaction construction)
→ Client (WDK signing)
→ On-chain execution


---

## 📁 Repository Structure


/agents-server → autonomous agent (LLM, WDK wallet, execution)
/autobots-gateway → authentication + routing layer
/autobots-server → optimization + execution backend
/SKILL.md → strategy definition (LLM behavior)  


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

🛡️ Safety Model

Safety is enforced across layers:

LLM → constrained by SKILL rules
Orchestrator → validates + reorders steps
Optimizer → prevents doom-swaps
Executor → enforces feasibility
WDK → guarantees self-custody

Worst case:

the agent does nothing, not loses funds

🔑 WDK Integration

WDK is the only key management layer.

wallet creation (seed phrase)
account derivation
transaction signing
authentication via signed memo TX

Keys never leave the client runtime.

🚀 Demo
Dashboard: http://localhost:8002
Real-time:
portfolio
positions
LLM reasoning
execution steps
transaction logs
⚡ What Makes This Different
USD₮-first capital model — stablecoin-denominated strategies
True autonomy — agent decides when and why, not just how
Global capital optimization — multi-step token flow reasoning
Separated intelligence — AI cannot directly execute
Self-custodial by architecture — not by promise
🧪 Running (Simplified)
# backend
cd autobots-server && cargo run

# gateway
cd autobots-gateway && cargo run

# agent
cd agents-server
npm install
node server.js

Fund wallet → agent runs autonomously.

⚠️ Scope

This repository showcases the core architecture and execution logic.

Full system includes:

production backend infra
orchestration layers
monitoring
📊 Status
Autonomous execution loop implemented
Real on-chain interaction
Live dashboard + reasoning trace
Designed for small capital ($10–50)
🧠 Core Insight

HydraLP is not a bot.

It is a continuous autonomous capital allocation system.

License

Apache 2.0


---

# What changed (important)

### 1. Front-loaded clarity
- immediately defines **what it is**
- no scrolling needed

### 2. Strong framing
- “capital allocator” > “liquidity agent”

### 3. Proprietary handled correctly
- now looks **intentional**, not missing

### 4. Faster mental model
- lifecycle + flow visible instantly

---

# Result

Before:
> “complex system, needs reading”

After:
> **“autonomous USD₮ capital system” (instant understanding)**

---

If you want next step:
I can align this README + your DoraHacks page so they reinforce each other (that’s what top submissions do).

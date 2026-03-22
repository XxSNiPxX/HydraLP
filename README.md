# HydraLP

**Autonomous Concentrated Liquidity Management with Separated Intelligence**

> *Submission for [Tether Hackathon Galactica: WDK Edition 1](https://dorahacks.io) — Autonomous DeFi Agent Track*

HydraLP is a three-headed architecture for autonomous CLMM (Concentrated Liquidity Market Maker) position management on Solana. An LLM reasons about strategy, a capital flow optimizer prevents economically irrational operations, and a deterministic executor handles on-chain math and transaction construction — each head operating independently with strict boundaries.

The key insight: **the AI plans but never acts. The optimizer constrains but never decides. The executor acts but never thinks.** No single layer can cause catastrophic loss on its own.

**Demo Video:** [YouTube (unlisted)](TODO)
**Live Dashboard:** `http://localhost:8002` after setup

---

## Why This Exists

Existing DeFi automation falls into two categories: hardcoded bots that can't adapt, and AI agents that try to do everything (sign transactions, compute liquidity math, manage keys) and fail unpredictably.

HydraLP separates concerns the way production systems actually work. The LLM outputs a JSON plan — that's it. A deterministic Rust pipeline validates, optimizes, and executes that plan with mathematical guarantees. The AI can be wrong about strategy (pick bad ranges, mistime rebalances) without draining the wallet, because the optimizer and executor enforce invariants the LLM cannot override.

---

## WDK Integration — Where, How, and Why

WDK (Tether's Wallet Development Kit) is the **sole custodian of private keys** in HydraLP. It is not bolted on — it is the foundation that makes the entire autonomous agent architecture safe.

### Where WDK Is Used

| Location | File | WDK Usage |
|----------|------|-----------|
| Wallet creation | `server.js` → `createWallet()` | `WDK.getRandomSeedPhrase()` generates entropy for new agent wallets |
| Wallet restoration | `server.js` → `initWalletFromSeed()` | `WalletManagerSolana(seedPhrase, { rpcUrl, commitment })` restores wallets across restarts |
| Account derivation | `server.js` → `initWalletFromSeed()` | `walletManager.getAccount(0)` derives the Solana account from the HD path |
| Address resolution | `server.js` → `initWalletFromSeed()` | `solAccount.getAddress()` resolves the on-chain public key |
| Balance queries | `server.js` → `updateBalance()` | `solAccount.getBalance()` used in diagnostics for SOL balance verification |
| Keypair extraction | `server.js` → `initWalletFromSeed()` | `solAccount.keyPair` extracts the signing keypair for transaction submission |
| Persistence | `server.js` → `save(DB_FILE, ...)` | Seed phrase persisted to `db_openclaw.json` for wallet recovery |
| Gateway auth | `server.js` → `authenticateWithBackend()` | WDK-derived keypair signs a Memo transaction to prove wallet ownership to the gateway |
| TX signing | `server.js` → `sendAnyTx()` | WDK-derived keypair signs every transaction (swaps, position opens, position closes) |

### How WDK Fits the Architecture

```
                    ┌─────────────────────────────┐
                    │  WDK Wallet Runtime          │
                    │                              │
                    │  seed phrase → HD derivation  │
                    │  → Solana keypair             │
                    │  → address + signing          │
                    │                              │
                    │  Keys NEVER leave this box    │
                    └──────────┬──────────────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
     Auth signing      TX signing       Balance checks
     (Memo + nonce     (every swap,     (diagnostics,
      → gateway)        every LP tx)     SOL reserve)
```

### Why WDK (Not Raw Keypairs)

1. **HD wallet derivation** — WDK derives keys from a seed phrase using standard BIP paths. The agent can be restored on any machine from the seed alone. No raw private key files sitting on disk.

2. **Separation of concerns** — The LLM never receives key material. The Rust executor never receives key material. Only the WDK runtime in the Node.js orchestrator can sign. This is enforced by architecture, not by policy.

3. **Self-custodial guarantee** — The `/wallet/export` endpoint returns 403. The `/agent/stop` endpoint returns 403. The agent controls its own keys and operates autonomously. No human in the loop for signing.

4. **Wallet lifecycle management** — WDK handles creation, persistence, restoration, and account derivation. The agent survives process restarts, server reboots, and redeployments without losing access to funds.

---

## Agent Intelligence — How the LLM Decides

The LLM (Anthropic Claude) is the strategic reasoning layer. It receives a complete snapshot of on-chain state and outputs a structured plan. Here's the decision pipeline:

### Input (What the Agent Sees)

Every ~30 seconds, the agent receives a `CombinedWalletUpdate` from the poolwatcher containing:

- **Wallet tokens** — every token mint with raw balance and USD price
- **Pool state** — current tick, sqrt price, tick spacing, liquidity, TVL, volume
- **Existing positions** — NFT mints, tick ranges, liquidity amounts
- **Token prices** — real-time Jupiter oracle prices

### Reasoning (How the Agent Thinks)

The LLM operates under a **SKILL prompt** (`SKILL.md`) — a 4,000-word behavioral framework that constrains its output. Key encoded behaviors:

**Capital deployment policy:**
- Deploy 50–70% of wallet value (never 100%)
- Reserve ≥0.05 SOL for transaction fees at all times
- Budget from pool tokens only — never count SOL in the deployment budget
- For small wallets (<$20), prefer single-pool deployment over fragmentation

**Anti-oscillation rules (the #1 failure mode for autonomous agents):**
- Check `position_pct = (current_tick - tick_lower) / (tick_upper - tick_lower)`
- If 0.1 < position_pct < 0.9 → position is healthy → **output empty steps**
- Never close a position just to reopen with slightly different parameters
- If last 2+ decisions were decrease+increase on the same pool → **stop, do nothing**

**Capital flow awareness:**
- Mentally trace token flows before generating steps
- Tokens freed by decreases flow into increases — account for this
- Anti-doom-swap: never plan swaps that cancel each other out (A→B then B→A)
- All decrease steps must come before all increase steps

**Token ratio reasoning:**
- "Having both tokens" ≠ "no swap needed"
- Compute `current_ratio` vs `target_ratio` — if deviation > 20%, swaps are required
- Include `target_ratio0` in every increase step so the optimizer knows the intended split

### Output (What the Agent Produces)

```json
{
  "steps": [
    { "type": "decrease_position", "pool": "F1Eg...", "fraction": 1.0 },
    { "type": "increase_position", "pool": "F1Eg...", "budget_usd": 9.0, "range_pct": 0.25, "target_ratio0": 0.52 }
  ],
  "reasoning": [
    "step 0: closing existing position — tick at 93% of range, near upper boundary",
    "step 1: reopening with wider range (25%) centered on current price",
    "sol_safety: 0.12 SOL available, well above 0.05 minimum",
    "token_flow: decrease releases both tokens, increase reuses them — no swap needed"
  ]
}
```

The reasoning is broadcast to the dashboard in real-time so operators can observe the agent's logic.

### Validation (What Catches LLM Mistakes)

Before any plan reaches the executor, the orchestrator runs **three layers of validation**:

1. **Schema normalization** (`inspectAndNormalizePlan`) — fixes `"action"` → `"type"`, `range_pct: 20` → `0.20`, validates pool addresses against known pools, fills missing `target_ratio0` defaults

2. **Capital flow analysis** (`analyzeCapitalFlows`) — checks SOL reserves, reorders steps (decreases first), detects doom-swap potential, reduces budgets by 50% if SOL < 0.05

3. **Execution guards** — prevents repeated increase on the same pool, skips steps where the backend already shows a position, aborts if wallet state is missing

---

## Architecture — Full Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                        HydraLP                                   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  agents-server/ (Node.js — port 8002)                       │ │
│  │                                                              │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │ │
│  │  │ WDK      │  │ LLM      │  │ Plan     │  │ TX Signer  │  │ │
│  │  │ Wallet   │  │ Agent    │  │ Validator │  │ & Sender   │  │ │
│  │  │ Runtime  │  │ (Claude) │  │ + Flow   │  │            │  │ │
│  │  │          │  │          │  │ Analyzer │  │            │  │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │ │
│  │       │              │              │              │         │ │
│  │  WDK seed      Anthropic API   Safety checks  Solana RPC   │ │
│  │  phrase         (reasoning)    (pre-execution)  (submit)    │ │
│  │                                                              │ │
│  │  ┌──────────────────────────────────────────────────────┐   │ │
│  │  │  Dashboard (WebSocket → browser)                      │   │ │
│  │  │  Portfolio · Positions · Brain · Execution · Diagnostics│  │ │
│  │  └──────────────────────────────────────────────────────┘   │ │
│  └──────────────────────────────┬──────────────────────────────┘ │
│                                 │ REST + WS (port 9000)          │
│  ┌──────────────────────────────▼──────────────────────────────┐ │
│  │  autobots-gateway/ (Rust — port 9000)                       │ │
│  │                                                              │ │
│  │  Wallet-ownership auth (Memo TX signing via WDK keypair)     │ │
│  │  Per-agent WebSocket filtering (wallet + token pairs)        │ │
│  │  Execution proxying (/next_step, /execute_optimized)         │ │
│  │  Nonce replay protection                                     │ │
│  └──────────────────────────────┬──────────────────────────────┘ │
│                                 │ HTTP + WS (port 8080)          │
│  ┌──────────────────────────────▼──────────────────────────────┐ │
│  │  autobots-server/ (Rust — port 8080)                        │ │
│  │                                                              │ │
│  │  ┌──────────────┐  ┌───────────────┐  ┌──────────────────┐  │ │
│  │  │ Poolwatcher   │  │ Capital       │  │ Position         │  │ │
│  │  │ (live state)  │  │ Optimizer     │  │ Executor         │  │ │
│  │  │               │  │               │  │                  │  │ │
│  │  │ Raydium pools │  │ Token flow    │  │ CLMM math        │  │ │
│  │  │ Jupiter prices│  │ Doom-swap     │  │ Tick ranges      │  │ │
│  │  │ NFT positions │  │ prevention    │  │ Jupiter swaps    │  │ │
│  │  │ Wallet scans  │  │ SOL protection│  │ TX construction  │  │ │
│  │  └──────────────┘  └───────────────┘  └──────────────────┘  │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## Project Structure

### `agents-server/` — The Autonomous Agent (Node.js)

| File | Purpose |
|------|---------|
| `server.js` | **Core orchestrator.** WDK wallet lifecycle, LLM agent loop, plan validation, capital flow analysis, transaction signing, dashboard API, WebSocket fan-out to browser |
| `SKILL.md` | **LLM behavioral framework.** 4,000-word prompt defining capital policy, anti-oscillation rules, token flow reasoning, output schema. This is the "brain configuration" — swap it out for a different strategy |
| `settings.json` | Agent configuration: gateway URL, LLM provider/model, batch parameters, token pairs to track |
| `index.html` | Dashboard UI: real-time portfolio, position visualization, LLM reasoning feed, execution tracking, diagnostics |
| `db_openclaw.json` | **WDK wallet persistence.** Stores seed phrase + agent ID for wallet recovery across restarts |
| `openclaw_decisions.json` | Decision audit log: every LLM reasoning entry with timestamps |
| `openclaw_txlog.json` | Transaction log: every signed TX with signature, type, Solscan link |

### `autobots-gateway/` — Agent Authentication Gateway (Rust)

| File | Purpose |
|------|---------|
| `main.rs` | HTTP/WS server. Wallet-ownership verification (Memo TX signed by WDK keypair), nonce replay protection, per-agent WebSocket filtering, execution proxying to the backend |

**WDK touchpoint:** The gateway verifies that agents own their wallet by checking a signed Solana transaction. The WDK keypair in the agent signs a Memo containing a nonce — the gateway deserializes and cryptographically verifies this. No passwords, no OAuth — wallet ownership is the identity.

### `autobots-server/` — Execution Intelligence (Rust)

| File | Purpose |
|------|---------|
| `main.rs` | HTTP/WS server. Routes for `/next_step` (per-step execution), `/execute_optimized` (full-plan execution), `/add_wallet` (pool tracking), WebSocket state broadcasting |
| `capital_optimizer.rs` | **Global capital flow optimizer.** Builds a per-mint ledger (wallet balance + expected inflows − required outflows), routes surplus→deficit swaps, enforces SOL reserve, eliminates doom-swaps, validates plan feasibility |
| `position_executor.rs` | **On-chain transaction builder.** Fetches real-time pool state via RPC, computes tick ranges, calculates feasible liquidity from actual balances, builds Raydium CLMM instructions (open/increase/decrease/close position), integrates Jupiter for swaps, handles dust-collapse recovery |
| `poolwatcher/` (module) | Real-time state ingestion: Raydium pool state, wallet token balances (Helius), Jupiter prices, NFT position discovery. Broadcasts `CombinedWalletUpdate` over WebSocket |

### `SKILL.md` — The Strategy Brain

This isn't a README — it's the LLM's operating manual. It defines:

- **Input data model** — how to interpret `CombinedWalletUpdate` fields
- **Capital flow model** — SOL is sacred, token reuse rules, anti-doom-swap
- **Behavioral rules** — no oscillation, rebalance only when meaningful, idle tokens are normal
- **Planning logic** — when to open, when to close, when to do nothing
- **Output schema** — strict JSON format with required fields and validation rules
- **Priority order** — SOL safety > feasibility > deployment > swap minimization > efficiency

Changing this file changes the agent's entire strategy without touching any code.

---

## What Makes This Novel

### 1. Separated Intelligence with Deterministic Safety Bounds

The LLM's output is a suggestion, not a command. The capital flow analyzer can reject plans. The optimizer can reorder and modify steps. The executor can skip steps that would produce dust positions. This layered veto system means the AI can hallucinate a bad plan and the worst outcome is nothing happens.

### 2. Capital Flow Optimization Across Multi-Step Plans

Most DeFi bots execute steps independently. HydraLP analyzes the entire plan holistically — tokens freed from a decrease in step 1 are routed to an increase in step 3 without intermediate swaps. This matters enormously when operating on $10–50 wallets where every swap fee is material.

### 3. Dust-Collapse Recovery for Extreme-Price Pools

Pools with extreme price ratios (e.g., 156,000 IDLE/TSLAx) cause standard CLMM math to produce sub-dust positions. The executor detects when the budget split produces a near-zero minority-side request and automatically resizes from actual wallet balances instead.

### 4. Self-Custodial by Architecture, Not by Promise

WDK holds keys in-process. The LLM never receives key material. The Rust backend never receives key material. Transaction signing happens exclusively in the Node.js orchestrator after all validation passes. The `/wallet/export` endpoint is blocked. This isn't a policy — it's a code path that doesn't exist.

### 5. Anti-Oscillation at the Strategy Layer

The SKILL prompt encodes position health checks that prevent the most common autonomous agent failure mode: closing and reopening positions every cycle (burning SOL fees for no benefit). The planner evaluates `position_pct` and refuses to act unless the position is genuinely near a range boundary.

### 6. The Agent Decides When and Why, Not Just How

Per the hackathon criteria: "Agent decides when and why (not just how)." The LLM receives raw market state and reasons about *whether* to act, *which* pools to target, *how much* capital to deploy, and *why* (with explicit reasoning that's logged and displayed). The executor only handles the *how* — transaction construction is purely mechanical.

---

## Safety Model

HydraLP enforces safety at every layer:

| Layer | Invariant | Enforcement |
|-------|-----------|-------------|
| **Planner (LLM)** | SOL reserve ≥ 0.05 | SKILL prompt rules + reasoning requirement |
| **Planner (LLM)** | No oscillation | Position health check (`position_pct`) before planning |
| **Planner (LLM)** | Budget excludes SOL | SKILL prompt: "budget should reflect pool tokens, not total wallet" |
| **Orchestrator** | Execution lock | Only one plan executes at a time; deferred updates queued |
| **Orchestrator** | Plan validation | Type/pool/range/ratio checks before dispatch |
| **Orchestrator** | SOL floor | Aborts if SOL < 0.03; halves budgets if SOL < 0.05 |
| **Orchestrator** | Step ordering | Reorders decreases before increases |
| **Orchestrator** | Doom-swap detection | Checks bidirectional token flows before forwarding |
| **Gateway** | Wallet ownership | Cryptographic verification via WDK-signed Memo TX |
| **Gateway** | Nonce replay | Permanent nonce storage prevents auth replay attacks |
| **Gateway** | Data isolation | Per-agent WebSocket filtering by wallet + token pairs |
| **Optimizer** | No doom-swaps | Bidirectional edge detection in swap graph |
| **Optimizer** | SOL never swapped | SOL mint excluded from surplus→deficit routing |
| **Optimizer** | Minimum swap threshold | Skips swaps < $0.50 (dust) |
| **Executor** | No dust positions | Minimum position value guard |
| **Executor** | No over-budget TXs | Scales liquidity down when token needs > wallet balance |
| **Executor** | Dust-collapse recovery | Detects extreme-ratio budget splits and resizes from wallet |
| **WDK** | Keys never exported | `/wallet/export` returns 403 |
| **WDK** | Keys never leave runtime | Only the orchestrator process can sign |

---

## Judging Criteria Alignment

### Agent Intelligence ✅
- Claude reasons about market state with a structured SKILL prompt
- Explicit reasoning output logged and displayed in real-time
- Anti-oscillation rules prevent the most common autonomous agent failure
- Capital flow reasoning traces token movement across multi-step plans

### WDK Wallet Integration ✅
- WDK is the sole key management layer (not a wrapper around raw keypairs)
- Seed phrase derivation, account management, wallet recovery
- Every transaction signed via WDK-derived keypair
- Gateway auth uses WDK keypair to prove wallet ownership
- Keys never leave the WDK runtime — enforced by architecture

### Technical Execution ✅
- Three-language stack: Rust (executor, optimizer, gateway), Node.js (orchestrator), Markdown (strategy)
- Real-time on-chain state via WebSocket pipeline
- Jupiter DEX integration for swap routing
- Raydium CLMM V3 instruction construction from scratch (not wrapper SDK)
- Capital flow optimization eliminates redundant swaps globally

### Agentic Payment Design ✅
- Agent autonomously deploys capital into liquidity positions
- Conditional logic: only acts when positions drift out of range
- Programmable capital flow: decrease → free tokens → route to new position → increase
- SOL management as a resource constraint (fees, rent) separate from trading capital

### Originality ✅
- Three-headed separation of concerns (plan / optimize / execute) is novel in DeFi automation
- SKILL.md as a swappable strategy layer — change strategy without changing code
- Dust-collapse recovery for extreme-price-ratio pools (not handled by any existing framework)
- Capital flow optimizer that reasons about token reuse across multi-step plans

### Polish & Ship-ability ✅
- Real-time dashboard with portfolio, positions, reasoning, execution, diagnostics
- Wallet export blocked, agent stop blocked — autonomous by design
- Transaction log with Solscan links
- Auto-reconnect on WebSocket failure, auto-restart on process reboot
- Configuration via environment variables, no manual intervention after funding

### Presentation & Demo ✅
- Dashboard shows the complete decision lifecycle: state → reasoning → plan → validation → execution → confirmation
- Every LLM decision is logged with reasoning
- Every transaction is tracked with signature and Solscan link
- Position visualization shows tick range vs current price

---

## Running

### Prerequisites
- Node.js 18+
- Rust toolchain
- Solana RPC access (Helius recommended)
- Anthropic API key

### 1. Start the Execution Backend (Rust)
```bash
cd autobots-server
cargo run
# Listens on :8080
```

### 2. Start the Agent Gateway (Rust)
```bash
cd autobots-gateway
cargo run
# Listens on :9000, proxies to :8080
```

### 3. Start the Autonomous Agent (Node.js)
```bash
cd agents-server
npm install
export LLM_API_KEY="sk-ant-..."
export SOLANA_RPC="https://mainnet.helius-rpc.com/?api-key=..."
node server.js
# Dashboard on :8002, agent auto-starts after wallet init
```

On first run, create the agent wallet via the dashboard or `POST /agent/create`. The agent generates a WDK wallet, authenticates with the gateway, connects to the state stream, and begins autonomous operation.

**Fund the wallet** with SOL (≥0.1 recommended) and the target token pair. The agent handles everything from there.

### Dashboard
Open `http://localhost:8002` to observe:
- Portfolio value and token holdings
- Live position data with range visualization
- LLM reasoning feed (every decision explained)
- Step-by-step execution progress
- Transaction signatures with Solscan links
- System diagnostics (RPC, backend, wallet, LLM)

---

## Known Limitations

- Single-pool operation tested extensively; multi-pool token routing is implemented but less battle-tested
- Position NFT discovery relies on Helius `getAsset` which can be slow (2–5s per NFT)
- The LLM occasionally suggests rebalances that waste fees on small improvements — mitigated by SKILL prompt rules but not fully eliminated
- No impermanent loss tracking or yield accounting yet
- Jupiter swap routing assumes sufficient on-chain liquidity for the swap pair
- USD₮ integration via WDK is architecturally supported but current deployment targets SOL-pair CLMM pools

---

## License

Apache 2.0 — see LICENSE file.
# HydraLP

# OpenClaw — Autonomous CLMM Agent

A self-custodial autonomous agent that manages concentrated liquidity positions on Solana. This is the brain of the system — it holds the wallet, receives live market data, feeds it to an LLM for strategy decisions, and executes the resulting plans by signing and submitting transactions on-chain. It ties together the entire three-layer stack: executor → gateway → this.

## What Problem This Solves

The executor builds transactions. The gateway authenticates and routes them. But neither of those services *decides* anything, and neither can *sign* anything. Someone needs to watch the market, decide when to open or close positions, and actually put pen to paper on the transactions that come back.

This agent does all of that autonomously. It creates a self-custodial wallet (via Tether's WDK), authenticates with the gateway, subscribes to live pool and balance updates, batches those updates into an LLM prompt, validates and normalizes the LLM's plan, runs a capital flow analysis to catch dangerous patterns before they reach the executor, then signs and submits every transaction in the plan — all without human intervention.

The user's role is to fund the wallet and choose which token pairs to track. Everything else runs on its own.

## How It Works (Pseudocode)

### Startup

```
load saved wallet from db.json (or wait for user to create one via dashboard)
extract Solana keypair from WDK account for transaction signing

authenticate with the gateway:
  fetch nonce → build Memo transaction with nonce → sign with wallet keypair
  POST /agent/register with { wallet, nonce, signed_tx }
  receive api_key

register token pairs with gateway:
  POST /agent/add_pairs with configured pairs from settings

connect to gateway WebSocket stream (filtered to this wallet + these pairs)
auto-start the LLM agent after 3 seconds
run diagnostics every 15 seconds
```

### Main Loop (Event-Driven)

```
on each WebSocket message from gateway:
  parse the CombinedWalletUpdate (balances, prices, pools, positions)
  update local portfolio state (for UI)

  if a plan is currently executing → skip (don't stack plans)

  otherwise → feed the data into the LLM batch buffer

when batch buffer reaches threshold OR timeout expires:
  flush the batch → call the LLM

LLM query:
  load SKILL.md (the strategy prompt — see below)
  normalize token balances (raw → human-readable with USD values)
  build prompt with full wallet state + pool data + position data
  call Anthropic API (Claude) with the prompt
  parse JSON response → extract { steps, reasoning }

validate the plan:
  inspect every step:
    normalize type names ("increase" → "increase_position", etc.)
    verify pool addresses exist in matched_pools
    validate budget_usd, range_pct, fraction are sane numbers
    ensure target_ratio0 is present and in [0, 1]
  if plan is empty but wallet has >$3 → force a fallback position open

capital flow analysis (before execution):
  check SOL balance:
    < 0.03 SOL → abort entirely (can't pay fees)
    < 0.05 SOL → cut all budgets by 50%
  reorder steps: all decreases before all increases
  detect token reuse (tokens freed by decreases that cover increase needs)
  detect doom-swap potential (swapping A→B and B→A)
  adjust budgets if SOL is low

execute the plan:
  try optimized endpoint first (POST /agent/execute_optimized)
    → sends entire plan, executor handles capital optimization + all steps
    → returns array of results, each with unsigned transactions

  if optimized endpoint returns 404 → fall back to per-step execution
    → POST /agent/next_step for each step, re-fetch wallet state between steps

  for each result with transactions:
    deserialize transaction (versioned or legacy)
    sign with wallet keypair
    submit to Solana RPC
    wait for confirmation
    record in transaction log
    broadcast to dashboard UI
    wait for next WebSocket update (fresh chain state) before continuing

  unlock execution → process any deferred updates
```

### The Strategy Prompt (SKILL.md)

The LLM doesn't freestyle. It operates under a detailed system prompt (`SKILL.md`) that functions as a deterministic strategy framework. Key rules the LLM must follow:

```
SOL is sacred — never use it for swaps, always keep ≥0.05 reserve
single position per pool — close before reopening
decreases before increases — so freed tokens can flow to new positions
anti-oscillation — if position is in range (10%-90%), do nothing
anti-doom-swap — never plan swaps that cancel each other out
budget from pool tokens only — don't count SOL in the budget
if position is healthy → output empty steps (doing nothing is valid)
```

The prompt includes the full wallet state (tokens, prices, pool data, existing positions) and expects a strict JSON response with steps and reasoning.

## Architecture & Where This Fits

```
┌──────────────────────────────────────────────────────────────┐
│              THIS SERVICE (autonomous agent)                  │
│              port 8002 — dashboard + API                     │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │  WDK      │  │  LLM     │  │  Plan    │  │ TX Signer  │  │
│  │  Wallet   │  │  Agent   │  │  Executor│  │ & Submitter│  │
│  │  (self-   │  │ (Claude) │  │ (local)  │  │            │  │
│  │  custody) │  │          │  │          │  │            │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│       │              │              │              │          │
│       │         Anthropic API       │         Solana RPC     │
│       │              │              │              │          │
└───────┼──────────────┼──────────────┼──────────────┼─────────┘
        │              │              │              │
        │              │     REST + WS (port 9000)   │
        │              │              │              │
┌───────┼──────────────┼──────────────▼──────────────┼─────────┐
│       │              │      Agent Gateway          │         │
│       │              │   (auth, filtering, proxy)  │         │
└───────┼──────────────┼──────────────┬──────────────┼─────────┘
        │              │              │              │
        │              │     HTTP + WS (port 8080)   │
        │              │              │              │
┌───────┼──────────────┼──────────────▼──────────────┼─────────┐
│       │              │      Executor               │         │
│       │              │   (pool watcher, optimizer,  │         │
│       │              │    position executor)        │         │
└───────┼──────────────┼──────────────┬──────────────┼─────────┘
        │              │              │              │
        ▼              ▼              ▼              ▼
   Self-Custodial   Anthropic      Raydium V3     Solana
   Wallet (WDK)    Claude API     + Jupiter      Mainnet
```

The three services form a pipeline: the executor provides intelligence (what transactions to build), the gateway provides access control (who can use it), and this agent provides autonomy (deciding what to do and signing the result). The private key never leaves this process.

## Key Design Decisions

**Self-custodial wallet via WDK.** The agent creates and manages its own Solana wallet using Tether's Wallet Development Kit. The seed phrase is stored locally in `db.json`. The private key is extracted into a Solana `Keypair` for transaction signing but is never exposed via any API endpoint — the `/wallet/export` route explicitly returns 403.

**LLM as strategy layer, not as executor.** The LLM (Claude) only produces a JSON plan with steps and reasoning. It never sees private keys, never signs anything, and never talks to the chain. Its output is validated, normalized, and safety-checked before any transaction is built. If the LLM returns garbage, the plan is rejected and nothing happens.

**Execution locking.** While a plan is being executed (transactions in flight), the agent ignores new WebSocket updates and won't trigger another LLM query. This prevents stacking plans or making decisions based on stale mid-execution state. Deferred updates are processed once execution completes.

**Two execution paths.** The agent tries the optimized endpoint first (`/execute_optimized`), which sends the entire plan to the executor for global capital optimization. If the executor doesn't support it (404), it falls back to step-by-step execution via `/next_step`, re-fetching wallet state between each step. Both paths sign and submit transactions identically.

**Client-side capital flow analysis.** Before forwarding any plan to the executor, the agent runs its own safety checks: SOL balance floor, step ordering (decreases before increases), doom-swap detection, and budget adjustment for low-SOL situations. This is a defense-in-depth layer — the executor has its own optimizer, but the agent catches problems before they leave the building.

**Plan normalization and validation.** LLMs are unreliable with schema compliance. The agent normalizes type names (`"increase"` → `"increase_position"`), converts `range_pct` from percentage to decimal if needed, validates pool addresses against known pools, fills in missing `target_ratio0` defaults, and rejects plans with invalid fields. A fallback mechanism forces a position open if the LLM returns empty steps but the wallet has deployable capital.

**Dashboard as observer, not controller.** The Express server on port 8002 serves a dashboard UI and exposes read-only state endpoints. Settings cannot be changed via the UI (403 on POST /settings). The agent cannot be stopped from the UI (403 on POST /agent/stop). Configuration comes exclusively from environment variables and `settings.json`. The dashboard watches — it doesn't drive.

## Components

**WDK wallet manager** — Creates or restores a Solana wallet from a seed phrase. Extracts the keypair for transaction signing. Tracks balances from the WebSocket stream rather than polling the chain directly.

**Backend auth** — Authenticates with the gateway using the same Memo-transaction-signing flow. Registers token pairs. Manages the API key lifecycle.

**WebSocket consumer** — Maintains a persistent connection to the gateway's `/stream` endpoint. Parses `CombinedWalletUpdate` messages, updates local state, and feeds data to the LLM batch buffer. Auto-reconnects on disconnect.

**LLM agent** — Batches incoming state updates, flushes when the batch is full or a timeout expires, queries Claude with the full wallet state + SKILL.md strategy prompt, and parses the JSON response.

**Plan inspector** — Validates and normalizes LLM output. Fixes common LLM mistakes (wrong field names, percentage vs decimal, missing types). Rejects structurally invalid plans.

**Capital flow analyzer** — Pre-execution safety net. Checks SOL reserves, reorders steps, detects doom-swaps, adjusts budgets. Runs entirely in the agent before anything reaches the gateway.

**Transaction signer** — Deserializes base64 transactions (versioned or legacy), signs with the local keypair, submits to Solana RPC, waits for confirmation, and records the result.

**Dashboard server** — Express app serving static files + JSON API endpoints + WebSocket for real-time UI updates. Broadcasts every state change, decision, step execution, and transaction to connected dashboard clients.

## Configuration

Configuration is managed via environment variables (or hardcoded defaults in the source). The `settings.json` file provides initial values but the agent treats its running config as immutable.

| Setting | Default | Description |
|---|---|---|
| `UI_PORT` | 8002 | Dashboard + API port |
| `SOLANA_RPC` | mainnet-beta | Solana RPC endpoint |
| `AGENT_SERVER` | 127.0.0.1:9000 | Gateway address |
| `LLM_PROVIDER` | anthropic | LLM provider |
| `LLM_MODEL` | claude-sonnet-4-20250514 | Model to use |
| `LLM_API_KEY` | — | Anthropic API key |
| `BATCH_SIZE` | 10 | WebSocket updates before LLM flush |
| `BATCH_TIMEOUT_S` | 30 | Max seconds before LLM flush |

Token pairs are configured in `settings.json` or hardcoded in `staticConfig`.

## Roadmap / Future Development

**Multi-strategy support.** Currently the agent runs a single SKILL.md prompt for all pairs. A natural evolution is multiple strategy files — one per pair or per risk profile — with the agent selecting the right prompt based on pool characteristics.

**Backtesting harness.** The SKILL.md framework is deterministic enough to replay against historical pool data. A backtester that feeds recorded `CombinedWalletUpdate` snapshots through the LLM and tracks simulated PnL would enable strategy iteration without risking capital.

**Fee tracking and PnL.** The agent records transactions but doesn't yet track earned fees, impermanent loss, or net PnL per position. Integrating on-chain fee claim data would close this loop.

**Multi-agent coordination.** Running multiple agents with different strategies on different pairs, sharing a single gateway and executor. The gateway already supports multi-tenant — the agent just needs to be parameterized.

**Hardware wallet signing.** Replace or supplement the WDK keypair with Ledger/Trezor signing for higher-security deployments. The architecture already separates plan generation from signing — the signing step just needs an alternative backend.

**Strategy marketplace.** If SKILL.md files become portable and testable, they could be shared, rated, and composed. An agent could run a portfolio of community-contributed strategies with risk isolation per pair.

## Running

Requires the gateway (port 9000) and executor (port 8080) to be running.

```bash
npm install
node server.js
```

On first run with no existing wallet, create one via the dashboard or `POST /agent/create`. The agent will generate a WDK wallet, authenticate with the gateway, and begin streaming data. Fund the wallet with SOL and the target tokens, then the agent auto-starts and begins making decisions.

Dashboard: `http://localhost:8002`

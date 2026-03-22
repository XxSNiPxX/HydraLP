# Autobots CLMM Intelligence Provider

An execution intelligence layer for Solana concentrated liquidity (CLMM) positions on Raydium V3. This service sits between an AI planner and the end user's wallet, translating high-level strategy decisions into optimized, ready-to-sign transactions. It is not a strategy engine itself — it is the infrastructure that makes custom strategies practical to execute.

## What Problem This Solves

Managing concentrated liquidity positions on-chain is brutally manual. A user who wants to rebalance across three pools has to figure out token ratios, compute tick ranges, handle swaps, avoid wasting SOL on unnecessary round-trips, build the right instructions, and sign everything in the correct order. Multiply that by every rebalance event and it becomes untenable.

This service absorbs all of that complexity. A planner (AI or otherwise) says *"increase position in pool X with $50, 5% range"* and the intelligence provider figures out what swaps are actually needed, what on-chain state looks like right now, how to size the position given real wallet balances, and hands back unsigned transactions the client simply signs and sends.

## How It Works (Pseudocode)

The system operates in a request/response loop. The client sends a **Plan** (a list of steps), and the server walks through execution one step at a time — or optimizes the entire plan at once.

### Step-by-Step Mode (`POST /next_step`)

```
receive(plan, step_index, wallet_metadata)

step = plan.steps[step_index]

if step is "increase_position":
    fetch pool state from chain (retry up to 3x)
    fetch user's actual token balances from chain (ignore stale client data)
    compute tick range from current price ± range_pct
    compute ideal token ratio from CLMM math
    compare wallet balances to ideal ratio

    if imbalance > 35%:
        try swapping surplus pool token → deficit token (no SOL spent)
        if that fails or isn't enough:
            swap SOL → deficit token (capped at 30% of available SOL, always keep 0.05 SOL reserve)
        return swap transaction, ask client to come back for liquidity step

    compute max feasible liquidity from available balances
    handle edge cases (dust amounts, extreme ratios, single-sided positions)
    build open_position instruction with Token-2022 NFT
    return unsigned transaction

if step is "decrease_position":
    fetch pool state and user's position from chain
    compute liquidity to remove (fraction of total)
    build decrease_liquidity instruction
    if removing 100%, also build close_position instruction
    return unsigned transaction
```

### Optimized Mode (`POST /execute_optimized`)

```
receive(plan, wallet_metadata)

--- PHASE 1: Capital Optimization ---
for each decrease step:
    estimate tokens that will be released

for each increase step:
    estimate tokens that will be needed

build a global ledger of every token mint:
    wallet_balance + expected_inflows - required_outflows = net position

identify deficits (tokens we need more of)
identify surpluses (tokens we have excess of)

route surplus → deficit swaps:
    prefer non-SOL surplus tokens first
    use SOL only as last resort
    apply 45% damping (don't over-correct)
    skip dust amounts (< $0.50)

detect doom-swaps (A→B and B→A in same plan) and remove the weaker leg

return pre-swap transactions

--- PHASE 2: Execute Steps (no per-step swaps) ---
for each step in plan:
    run liquidity-only execution (tokens already balanced from Phase 1)
    return unsigned transaction
```

### Pool Watching (`WebSocket /ws`)

```
on connect(wallet_filter, pool_filter):
    subscribe to broadcast channel

main loop (runs continuously):
    for each tracked wallet:
        fetch token balances
        fetch position states
        fetch prices from Jupiter
        broadcast updates to connected clients
```

## Architecture & Where This Fits

```
┌─────────────────────────────────────────────────────────┐
│                     CLIENT (wallet app)                  │
│  Signs transactions, sends to chain, displays state      │
└──────────────┬──────────────────────────▲────────────────┘
               │ POST /next_step          │ unsigned TXs
               │ POST /execute_optimized  │ (base64)
               │ WS /ws                   │
┌──────────────▼──────────────────────────┴────────────────┐
│             THIS SERVICE (intelligence provider)         │
│                                                          │
│  ┌──────────────┐  ┌───────────────┐  ┌───────────────┐ │
│  │ Pool Watcher  │  │   Capital     │  │   Position    │ │
│  │ (live state)  │  │  Optimizer    │  │   Executor    │ │
│  └──────────────┘  └───────────────┘  └───────────────┘ │
└──────────────┬──────────────────────────┬────────────────┘
               │ RPC calls                │ Jupiter API
               │ (balances, pool state)   │ (swap quotes)
┌──────────────▼──────────────────────────▼────────────────┐
│              SOLANA + RAYDIUM V3 + JUPITER               │
└──────────────────────────────────────────────────────────┘
```

The AI planner (not included here) produces a `Plan` — a JSON array of increase/decrease steps with pool IDs, budgets, and range parameters. The planner doesn't need to know anything about transaction construction, tick math, or token routing. It just decides *what* to do. This service figures out *how*.

## Key Design Decisions

**The server is the sole authority on balances.** Client-provided token balances are ignored for execution. Every step fetches real on-chain state via RPC before building transactions. The client's `wallet_update` is used only for metadata: which pools to target, current prices, and the wallet pubkey.

**SOL is sacred.** The capital optimizer and position executor both enforce a minimum SOL reserve (0.05 SOL) and cap SOL usage for swaps at 30% of available balance. Non-SOL surplus tokens are always preferred as swap inputs.

**Transactions are never signed server-side.** The service builds unsigned (or partially-signed, for NFT keypairs) transactions and returns them as base64. The user's wallet signs and submits. The server never holds private keys.

**Doom-swap prevention.** The optimizer detects circular swap patterns (swapping A→B and B→A in the same plan) and eliminates the weaker leg. This is critical for multi-pool rebalances where naive per-step swapping would waste fees.

## Components

**`main.rs`** — HTTP/WebSocket server (Axum). Defines the API surface, request/response types, and route handlers. Orchestrates the optimizer and executor for each request.

**`position_executor.rs`** — Core execution engine. Translates a single plan step into Solana instructions. Handles swap logic (Jupiter integration), feasible liquidity computation, position opening/closing, and edge cases like dust-collapse recovery and single-sided positions.

**`capital_optimizer.rs`** — Global plan analyzer. Builds a token-flow ledger across all steps, computes net deficits and surpluses, routes minimal swaps, and validates feasibility. Runs before the executor to eliminate redundant swaps.

**`poolwatcher` (module, not included)** — Background service that continuously tracks pool states, wallet balances, and token prices. Broadcasts updates over WebSocket to connected clients.

## Roadmap / Future Development

This service is the execution backbone. As it matures, the surrounding infrastructure grows with it:

**Multi-step transaction batching.** Currently each step returns one or two transactions. Future versions could batch multiple instructions into single transactions where possible (Solana's 1232-byte limit permitting), reducing the number of signatures the user needs to provide.

**Strategy plugin interface.** Right now the planner is external and produces a flat `Plan` JSON. A natural evolution is a plugin system where strategy authors register their logic (e.g., "rebalance when price moves 5% from center", "auto-compound fees daily") and the service handles scheduling, execution, and monitoring.

**Simulation / dry-run mode.** Before committing real capital, users should be able to preview exactly what transactions will be built, what the expected token flows are, and what fees they'll pay. The optimizer's reasoning log is a first step toward this.

**Historical performance tracking.** Logging position opens/closes, fee accruals, and impermanent loss over time. This feeds back into the planner to improve future strategy decisions.

**Cross-DEX support.** The current implementation targets Raydium V3 (CLMM). The executor and optimizer interfaces are general enough to extend to Orca Whirlpools, Meteora DLMM, or any concentrated liquidity protocol with similar primitives (ticks, ranges, liquidity math).

**On-chain automation.** Moving from a request/response model (user triggers each step) to a keeper model where the service monitors conditions and executes plans autonomously via pre-authorized transactions or a smart-contract-based delegation system.

## Running

The service listens on `0.0.0.0:8080`. It expects a pools JSON file at startup and connects to Solana mainnet via Helius RPC. Wallet tracking is dynamic — clients register wallets via `POST /add_wallet` and receive updates over WebSocket.

```
cargo run
```

Endpoints:

- `GET /` — health check
- `POST /add_wallet` — register a wallet for tracking
- `GET /list_state` — snapshot of all tracked state
- `WS /ws?wallet=...&pool=...` — live updates
- `POST /next_step` — execute one plan step
- `POST /execute_optimized` — execute full plan with capital optimization

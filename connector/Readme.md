# Autobots Agent Gateway

An authenticated API gateway for the CLMM execution intelligence provider. This service sits between external clients (bots, frontends, strategy agents) and the internal execution engine, handling identity, access control, and real-time data routing. It is the public-facing entry point — the executor never talks to the outside world directly.

## What Problem This Solves

The execution engine (pool watcher + capital optimizer + position executor) is a stateless, internal service with no concept of who is calling it. It accepts any request and builds transactions for any wallet. That's fine for a single-user setup, but the moment multiple agents or clients share the same infrastructure, you need a layer that answers: *who is this, do they own this wallet, and should they see this data?*

This gateway provides that layer. It authenticates agents via on-chain transaction signing (no passwords, no custodial keys), manages which token pairs each agent cares about, filters the real-time data stream so agents only see updates relevant to their positions, and proxies execution requests to the internal engine after verifying ownership.

## How It Works (Pseudocode)

### Registration / Login

```
client calls GET /agent/nonce
  → server returns a random UUID nonce

client builds a Solana transaction containing:
  - a Memo instruction with the nonce as data
  - signed by the wallet they claim to own

client calls POST /agent/register with { wallet, nonce, signed_tx }

server:
  decode the base64 transaction
  verify the cryptographic signature
  check that the first signer matches the claimed wallet pubkey
  scan instructions for a Memo program call containing the nonce
  reject if nonce was already used (replay protection)

  if wallet already registered → return existing agent_id + api_key
  otherwise → create new agent, generate api_key, persist to db

  all subsequent requests use the api_key for auth
```

Login follows the same flow but only succeeds if the wallet is already registered.

### Token Pair Management

```
client calls POST /agent/add_pairs with { api_key, token_pairs }

server:
  look up agent by api_key
  add new pairs to the agent's tracked set
  forward the wallet + pairs to the executor's /add_wallet endpoint
    (so the pool watcher starts tracking those pools for this wallet)

client calls POST /agent/remove_pairs with { api_key, token_pairs }

server:
  remove pairs from the agent's set
  (pool watcher cleanup is not yet implemented)
```

### Execution Proxying

```
client calls POST /agent/next_step with { api_key, plan, step_index, wallet_update }

server:
  authenticate via api_key
  verify wallet_update.wallet_pubkey matches the agent's registered wallet
    (prevents agent A from building transactions for agent B's wallet)
  strip the api_key from the request
  forward to executor's POST /next_step
  return the executor's response (unsigned transactions) verbatim

client calls POST /agent/execute_optimized with { api_key, plan, wallet_update }

server:
  same auth + ownership check
  forward to executor's POST /execute_optimized (120s timeout for multi-step plans)
  return the full array of execution results
```

### Real-Time Data Stream

```
client connects to WS /stream?api_key=...

server:
  authenticate via api_key
  subscribe to the internal broadcast channel
    (upstream listener rebroadcasts everything from the executor's /ws)

  for each incoming message from upstream:
    if message wallet doesn't match this agent's wallet → skip
    if message pools don't overlap with this agent's token pairs → skip
    forward to client

  the client only sees updates for their own wallet and their own pairs
```

### Upstream Listener (Background)

```
on startup:
  connect to executor's WebSocket at ws://localhost:8080/ws

  for each message:
    parse JSON
    broadcast to all connected gateway clients
      (per-client filtering happens in the WS handler above)

  on disconnect:
    wait 2 seconds
    reconnect (infinite retry loop)
```

## Architecture & Where This Fits

```
┌──────────────────────────────────────────────────────────┐
│              EXTERNAL CLIENTS                            │
│  Strategy bots, frontends, AI agents                     │
│  (each has an api_key tied to a verified wallet)         │
└──────────────┬───────────────────────▲───────────────────┘
               │ REST + WebSocket      │ unsigned TXs
               │ (port 9000)           │ + filtered updates
┌──────────────▼───────────────────────┴───────────────────┐
│              THIS SERVICE (agent gateway)                 │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Auth (tx     │  │ Pair/Agent   │  │ WS Fan-out    │  │
│  │ verification)│  │ Management   │  │ (per-agent    │  │
│  │              │  │ (db.json)    │  │  filtering)   │  │
│  └─────────────┘  └──────────────┘  └────────────────┘  │
└──────────────┬───────────────────────▲───────────────────┘
               │ HTTP proxy            │ WebSocket relay
               │ (port 8080)           │
┌──────────────▼───────────────────────┴───────────────────┐
│              EXECUTOR (intelligence provider)             │
│  Pool watcher, capital optimizer, position executor       │
│  (stateless, no auth, no concept of agents)              │
└──────────────────────────────────────────────────────────┘
```

The gateway is the only service exposed to the network. The executor runs on localhost and trusts all incoming requests. This separation means the executor can stay simple and stateless while the gateway handles all the multi-tenant concerns.

## Key Design Decisions

**Wallet ownership via on-chain signing.** Registration doesn't use passwords or OAuth. The client signs a real Solana transaction containing a nonce in a Memo instruction. The server verifies the signature, confirms the signer matches the claimed wallet, and checks the nonce hasn't been replayed. This proves ownership without ever touching private keys.

**Nonce replay protection.** Every nonce used for registration or login is stored permanently. A nonce can only be used once. This prevents replay attacks where someone intercepts a signed transaction and resubmits it.

**Wallet ownership enforcement on execution.** When a client sends a plan via `/agent/next_step` or `/agent/execute_optimized`, the gateway checks that the `wallet_pubkey` in the request body matches the wallet registered to that API key. This prevents one agent from crafting transactions for another agent's wallet, even if they somehow obtained the other agent's wallet address.

**Per-agent data filtering.** The upstream WebSocket from the executor broadcasts updates for all tracked wallets and pools. The gateway filters these per-connection, ensuring each agent only receives updates for their own wallet and the token pairs they've registered. An agent tracking SOL/USDC will never see updates about someone else's BONK/WIF position.

**Simple persistence.** Agent data is stored in a flat `db.json` file, rewritten on every mutation. This is intentionally simple — the service manages a small number of agents and the data is not high-frequency. For production scale, this would move to a proper database.

## Components

**Auth system** — Nonce generation, Solana transaction verification (signature + signer + memo content), nonce replay tracking, agent creation, and login.

**Agent management** — CRUD for agents and their token pair subscriptions. Forwards pair additions to the executor's pool watcher so it starts tracking the relevant pools.

**Execution proxy** — Authenticates and forwards `/next_step` and `/execute_optimized` requests to the internal executor. Strips the API key, verifies wallet ownership, and returns unsigned transactions.

**WebSocket fan-out** — Connects to the executor's WebSocket as a single upstream client, then redistributes messages to many downstream clients with per-agent filtering by wallet and token pairs.

**Upstream listener** — Background task that maintains a persistent WebSocket connection to the executor, with automatic reconnection on failure.

## API Reference

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/agent/nonce` | GET | None | Get a fresh nonce for signing |
| `/agent/register` | POST | Signed TX | Register a new agent (or return existing) |
| `/agent/login` | POST | Signed TX | Log in to an existing agent |
| `/agent/add_pairs` | POST | API key | Subscribe to token pairs |
| `/agent/remove_pairs` | POST | API key | Unsubscribe from token pairs |
| `/agent/info` | GET | API key | Get agent details |
| `/agent/next_step` | POST | API key | Execute one plan step (proxied) |
| `/agent/execute_optimized` | POST | API key | Execute full optimized plan (proxied) |
| `/stream` | WS | API key | Real-time filtered updates |
| `/health` | GET | None | Service status + agent count |

## Roadmap / Future Development

**API key rotation.** Currently the API key is static from registration. A rotation endpoint would let agents cycle keys without re-registering, which is important for long-lived deployments.

**Rate limiting and usage tracking.** Per-agent request limits, execution budgets, and audit logs. This is the natural foundation for a metered service where agents pay per execution or per data subscription.

**Role-based access.** Not all agents need execution capability — some might be read-only observers, others might only have access to specific pools. A permission model layered on top of the current agent system would enable this.

**Database migration.** Moving from `db.json` to SQLite or Postgres for durability, concurrent access, and query capability. The current approach works for prototyping but won't survive process crashes gracefully.

**Multi-executor routing.** If the execution layer scales to multiple instances (e.g., one per chain, one per DEX), the gateway becomes the routing layer that directs requests to the right backend based on the plan contents.

**Webhook notifications.** In addition to WebSocket streaming, agents should be able to register webhook URLs for critical events (position out of range, rebalance triggered, execution failed) so they can react without maintaining a persistent connection.

## Running

The gateway listens on `127.0.0.1:9000` and expects the executor to be running on `localhost:8080`.

```
cargo run
```

The executor must be started first — the gateway's upstream listener will retry the WebSocket connection every 2 seconds until it succeeds, but execution requests will fail if the executor is down.

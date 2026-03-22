import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  Connection,
  Transaction,
  VersionedTransaction,
  VersionedMessage,
  PublicKey,
  Keypair,
} from "@solana/web3.js";

/* ===== OPTIONAL WDK IMPORT ===== */
let WDK = null;
let WalletManagerSolana = null;
try {
  WDK = (await import("@tetherto/wdk")).default;
  WalletManagerSolana = (await import("@tetherto/wdk-wallet-solana")).default;
} catch {
  console.log("[BOOT] WDK not installed — running in keypair-only mode");
}
import dotenv from "dotenv";
dotenv.config();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ===== ENVIRONMENT / STATIC CONFIG ===== */

process.env.HTTP_PROXY = "";
process.env.HTTPS_PROXY = "";
process.env.NO_PROXY = "127.0.0.1,localhost";

const PORT = process.env.UI_PORT || 8002;

const SOLANA_RPC = process.env.SOLANA_RPC;
const AGENT_SERVER = process.env.AGENT_SERVER;

const LLM_PROVIDER = process.env.LLM_PROVIDER || "anthropic";
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_MODEL = process.env.LLM_MODEL || "claude-sonnet-4-20250514";

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "10");
const BATCH_TIMEOUT_S = parseInt(process.env.BATCH_TIMEOUT_S || "30");

const MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);

const DB_FILE = "./db_openclaw.json";
const DECISIONS_FILE = "./openclaw_decisions.json";
const TX_LOG_FILE = "./openclaw_txlog.json";
const MAX_HISTORY = 50;

const connection = new Connection(SOLANA_RPC);
const app = express();
app.use(express.json());
app.use(express.static(__dirname));
function normalizeForLLM(state) {
  const tokens = state.tokens || {};
  const prices = state.token_prices || {};
  const pools = state.matched_pools || [];

  const normalized = {};

  for (const mint in tokens) {
    const raw = Number(tokens[mint].amount_raw || 0);

    // ===== DECIMALS RESOLUTION =====
    let decimals = prices[mint]?.decimals;

    if (decimals === undefined) {
      const pool = pools.find(
        (p) => p.mintA?.address === mint || p.mintB?.address === mint,
      );

      if (pool) {
        if (pool.mintA?.address === mint) {
          decimals = pool.mintA.decimals;
        } else if (pool.mintB?.address === mint) {
          decimals = pool.mintB.decimals;
        }
      }
    }

    if (decimals === undefined) decimals = 9; // final fallback

    // ===== PRICE =====
    const price = prices[mint]?.usdPrice ?? null;

    const amount = raw / Math.pow(10, decimals);
    const usd = price ? amount * price : 0;

    normalized[mint] = {
      amount,
      usd_value: usd,
    };
  }

  return normalized;
}
/* ===== STATIC CONFIG (cannot be mutated from UI) ===== */
function inspectAndNormalizePlan(plan, opportunities) {
  const result = {
    valid: true,
    errors: [],
    normalized: { steps: [] },
  };

  if (!plan?.steps || !Array.isArray(plan.steps)) {
    return { valid: false, errors: ["No steps array"] };
  }

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];

    let type = step.type || step.action;

    if (!type) {
      result.errors.push(`step ${i}: missing type`);
      result.valid = false;
      continue;
    }

    if (type === "increase" || type === "open") type = "increase_position";
    if (type === "decrease" || type === "close") type = "decrease_position";

    const normalizedStep = { ...step, type };
    delete normalizedStep.action;

    // ===== POOL =====
    let pool = normalizedStep.pool;

    if (!pool) {
      result.errors.push(`step ${i}: missing pool`);
      result.valid = false;
    } else {
      const match = (opportunities || []).find(
        (p) => p.pool_address === pool || p.id === pool,
      );

      if (match) {
        normalizedStep.pool = match.pool_address || match.id;
      } else {
        result.errors.push(`step ${i}: invalid pool ${pool}`);
        result.valid = false;
      }
    }

    // ==================== INCREASE ====================
    if (type === "increase_position") {
      let budget = Number(normalizedStep.budget_usd);
      let range = Number(normalizedStep.range_pct);

      if (!budget || budget <= 0) {
        result.errors.push(`step ${i}: invalid budget`);
        result.valid = false;
      }

      if (range > 1) range = range / 100;

      if (!range || range <= 0 || range > 1) {
        result.errors.push(`step ${i}: invalid range`);
        result.valid = false;
      }

      // 🔴 ratio fix
      let ratio = Number(normalizedStep.target_ratio0);
      if (isNaN(ratio) || ratio < 0 || ratio > 1) {
        ratio = 0.5;
      }

      normalizedStep.target_ratio0 = ratio;
      normalizedStep.budget_usd = budget;
      normalizedStep.range_pct = range;
    }

    // ==================== DECREASE ====================
    if (type === "decrease_position") {
      const frac = Number(normalizedStep.fraction);

      if (!frac || frac <= 0 || frac > 1) {
        result.errors.push(`step ${i}: invalid fraction`);
        result.valid = false;
      }

      normalizedStep.fraction = frac;
    }

    result.normalized.steps.push(normalizedStep);
  }

  return result;
}
const staticConfig = Object.freeze({
  agent_server: AGENT_SERVER,
  llm_provider: LLM_PROVIDER,
  llm_model: LLM_MODEL,
  batch_size: BATCH_SIZE,
  batch_timeout_s: BATCH_TIMEOUT_S,
  token_pairs: [
    [
      "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
      "BjcRmwm8e25RgjkyaFE56fc7bxRgGPw96JUkXRJFEroT",
    ],
  ],
});

/* ===== GLOBAL STATE ===== */

let walletManager = null;
let solAccount = null;
let walletAddress = null;
let walletKeypairForTx = null;
let backendApiKey = null;
let backendWs = null;
let dashboardClients = [];
let currentState = null;
let stateHistory = [];
let wdkInitialized = false;

const agentState = {
  // ===== EXECUTION CONTROL =====
  executingPlan: false,
  latestWalletUpdate: null,
  hasFreshUpdate: false,

  // ===== IDENTITY =====
  wallet: null,
  agent_id: null,

  // ===== PORTFOLIO =====
  portfolio: { total_value: 0, tokens: [] },
  balance: { sol: 0, usdc: 0, total_usd: 0 },

  // ===== STRATEGY STATE =====
  pools: [],
  positions: [],
  opportunities: [],

  // ===== METRICS =====
  statistics: {
    positions_opened: 0,
    positions_closed: 0,
    total_deployed: 0,
    total_returned: 0,
    total_fees: 0,
    tx_count: 0,
    volume_usd: 0,
  },

  // ===== META =====
  last_activity: null,
};
let solPriceCache = {
  value: null,
  lastFetch: 0,
};

const PRICE_TTL_MS = 30_000; // 30s (safe for CoinGecko)

function getSolPriceFromStream() {
  try {
    const prices = latestWsState?.token_prices;
    if (!prices) return lastValidSolPrice;

    const SOL_MINT = "So11111111111111111111111111111111111111112";
    const sol = prices[SOL_MINT];

    if (!sol) return lastValidSolPrice;

    const price = sol.price || sol.usdPrice;

    if (price && price > 0) {
      lastValidSolPrice = price;
      return price;
    }

    return lastValidSolPrice;
  } catch {
    return lastValidSolPrice;
  }
}
const txLog = []; // { sig, type, pool, amount, ts, status, solscan }
const inFlight = new Set();

/* ===== LLM AGENT ===== */

let llmRunning = false;
let batchBuffer = [];
let batchTimer = null;
let decisionLog = [];
const llmConfig = {
  batchSize: staticConfig.batch_size,
  batchTimeoutMs: staticConfig.batch_timeout_s * 1000,
  maxTokens: 2048,
};

/* ===== EXECUTION STATE (for UI step tracking) ===== */

let currentPlan = null;
let currentStepIndex = -1;
let planRunning = false;
let executionLog = []; // { ts, phase, step, description, status }

/* ===== UTILITY ===== */

function load(file, fallback = null) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  } catch {}
  return fallback;
}
function save(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch {}
}
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}
function iso() {
  return new Date().toISOString();
}
function broadcast(type, data) {
  const p = JSON.stringify({ type, data });
  dashboardClients.forEach((ws) => {
    if (ws.readyState === 1)
      try {
        ws.send(p);
      } catch {}
  });
}

function broadcastCleanState() {
  const { latestWalletUpdate, ...clean } = agentState;
  broadcast("state_update", clean);
}

/* ===== WALLET — WDK + Keypair Hybrid ===== */

async function initWalletFromSeed(seedPhrase) {
  if (!WalletManagerSolana) throw new Error("WDK not available");

  log("[WDK] Initializing wallet...");
  walletManager = new WalletManagerSolana(seedPhrase, {
    rpcUrl: SOLANA_RPC,
    commitment: "confirmed",
  });
  solAccount = await walletManager.getAccount(0);
  walletAddress = await solAccount.getAddress();
  wdkInitialized = true;

  log("[WDK] Address:", walletAddress);

  // Extract Keypair for TX signing (WDK cannot sign arbitrary serialized TXs)
  const kp = solAccount.keyPair;
  if (!kp?.privateKey || !kp?.publicKey)
    throw new Error("Cannot access keyPair from WDK account");

  const sk = new Uint8Array(64);
  sk.set(kp.privateKey, 0);
  sk.set(kp.publicKey, 32);
  walletKeypairForTx = Keypair.fromSecretKey(sk);

  const kpAddr = walletKeypairForTx.publicKey.toBase58();
  if (kpAddr !== walletAddress) {
    log("[WDK] Address resolved via keypair:", kpAddr);
    walletAddress = kpAddr;
  }

  await updateBalance();
  return walletAddress;
}

async function createWallet() {
  if (!WDK) throw new Error("WDK not installed");
  log("[WDK] Creating new wallet...");
  const seedPhrase = WDK.getRandomSeedPhrase();
  const address = await initWalletFromSeed(seedPhrase);
  return { seedPhrase, address };
}

async function updateBalance() {
  try {
    if (!latestWsState) return;

    const tokens = latestWsState.tokens || {};
    const prices = latestWsState.token_prices || {};
    const pools = latestWsState.matched_pools || [];

    // Build mint→symbol map from matched_pools
    const symbolMap = {
      So11111111111111111111111111111111111111112: {
        symbol: "SOL",
        name: "Solana",
      },
    };
    for (const p of pools) {
      if (p.mintA?.address)
        symbolMap[p.mintA.address] = {
          symbol: p.mintA.symbol,
          name: p.mintA.name,
        };
      if (p.mintB?.address)
        symbolMap[p.mintB.address] = {
          symbol: p.mintB.symbol,
          name: p.mintB.name,
        };
    }

    let totalUsd = 0;
    let portfolioTokens = [];
    let solBalance = 0;

    for (const mint in tokens) {
      const amountRaw = Number(tokens[mint]?.amount_raw || 0);
      const decimals =
        prices[mint]?.decimals ??
        (mint === "So11111111111111111111111111111111111111112" ? 9 : 9);
      const price = prices[mint]?.usdPrice || 0;
      const amount = amountRaw / Math.pow(10, decimals);
      const usd = amount * price;

      // Skip NFT position tokens (amount=1, no price)
      if (amountRaw === 1 && !price) continue;

      totalUsd += usd;

      if (mint === "So11111111111111111111111111111111111111112") {
        solBalance = amount;
      }

      const info = symbolMap[mint] || {};
      portfolioTokens.push({
        mint,
        symbol: info.symbol || mint.slice(0, 6) + "…",
        name: info.name || "Unknown",
        balance: amount.toFixed(6),
        usd_value: usd.toFixed(2),
        decimals,
        price,
      });
    }

    agentState.balance = { sol: solBalance, usdc: 0, total_usd: totalUsd };
    agentState.portfolio = { total_value: totalUsd, tokens: portfolioTokens };
    agentState.wallet = walletAddress;

    // Store live position data from WS for UI
    agentState.livePositions = latestWsState.owner_positions_summary || null;
    agentState.matchedPools = pools;
    agentState.poolsFull = latestWsState.matched_pools_full || [];
  } catch (err) {
    log("[BALANCE ERROR]", err.message);
  }
}

/* ===== TX SIGNING & SENDING ===== */

async function sendTx(tx_b64, signers) {
  const tx = Transaction.from(Buffer.from(tx_b64, "base64"));
  tx.feePayer = walletKeypairForTx.publicKey;
  for (const s of signers) tx.partialSign(s);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  log("[TX SENT]", sig);

  const conf = await connection.confirmTransaction(sig, "confirmed");
  if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
  log("[TX OK]", sig);

  recordTx(sig, "legacy", null, 0);
  return sig;
}

/**
 * Send versioned TX — compatible with test.js's sendAnyTx pattern.
 * Used by the plan executor for next_step returned TXs.
 */
async function sendAnyTx(txB64) {
  const bytes = Buffer.from(txB64, "base64");
  let vtx;
  try {
    vtx = VersionedTransaction.deserialize(bytes);
  } catch {
    const msg = VersionedMessage.deserialize(bytes);
    vtx = new VersionedTransaction(msg);
  }
  vtx.sign([walletKeypairForTx]);

  const sig = await connection.sendRawTransaction(vtx.serialize(), {
    skipPreflight: false,
  });
  log("[TX SENT v0]", sig);

  await connection.confirmTransaction(
    { signature: sig, commitment: "confirmed" },
    "confirmed",
  );
  log("[TX CONFIRMED]", sig);

  recordTx(sig, "versioned", null, 0);
  return sig;
}

function recordTx(sig, type, pool, amountUsd) {
  const entry = {
    sig,
    type,
    pool: pool || "unknown",
    amount_usd: amountUsd,
    ts: iso(),
    solscan: `https://solscan.io/tx/${sig}`,
  };
  txLog.push(entry);
  agentState.statistics.tx_count++;
  agentState.statistics.volume_usd += amountUsd || 0;
  save(TX_LOG_FILE, txLog);
  broadcast("tx_logged", entry);
}

/* ===== BACKEND AUTH (same as test.js) ===== */

async function authenticateWithBackend() {
  const SERVER = staticConfig.agent_server;

  log("[AUTH] Fetching nonce...");
  const nonceRes = await axios.get(`${SERVER}/agent/nonce`, { proxy: false });
  const nonce = nonceRes.data.nonce;

  // Build memo TX with nonce (identical to test.js)
  const tx = new Transaction();
  tx.add({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from(nonce),
  });
  tx.feePayer = walletKeypairForTx.publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(walletKeypairForTx);
  const signed_tx = tx.serialize().toString("base64");

  log("[AUTH] Registering...");
  const registerRes = await axios.post(
    `${SERVER}/agent/register`,
    { wallet: walletAddress, nonce, signed_tx },
    { proxy: false },
  );
  if (!registerRes.data.api_key) throw new Error("Auth failed");
  backendApiKey = registerRes.data.api_key;

  // Register pairs
  await axios.post(
    `${SERVER}/agent/add_pairs`,
    {
      api_key: backendApiKey,
      token_pairs: staticConfig.token_pairs.map((p) => ({
        mint_a: p[0],
        mint_b: p[1],
      })),
    },
    { proxy: false },
  );

  log("[AUTH] OK:", backendApiKey);
  return backendApiKey;
}

/* ===== BACKEND WS STREAM ===== */

let latestWsState = null;
let wsWaiters = [];

function waitForNextWsUpdate() {
  return new Promise((resolve) => {
    const check = () => {
      if (agentState.hasFreshUpdate) {
        agentState.hasFreshUpdate = false;
        resolve();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

function connectToBackendStream() {
  if (backendWs)
    try {
      backendWs.close();
    } catch {}
  const wsUrl =
    staticConfig.agent_server.replace("http", "ws") +
    "/stream?api_key=" +
    backendApiKey;

  log("[WS] Connecting:", wsUrl);
  backendWs = new WebSocket(wsUrl);

  backendWs.on("open", () => {
    log("[WS] Connected");
    broadcast("backend_status", { connected: true });
  });

  backendWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      currentState = data;
      latestWsState = data;

      agentState.latestWalletUpdate = data;
      agentState.hasFreshUpdate = true;
      agentState.livePositions = data.owner_positions_summary || null;
      agentState.matchedPools = data.matched_pools || [];
      agentState.poolsFull = data.matched_pools_full || [];

      log("[WS RAW]", JSON.stringify(data, null, 2));

      await updateBalance(); // now valid
      broadcastCleanState();

      wsWaiters.forEach((r) => r());
      wsWaiters = [];

      stateHistory.push({ timestamp: Date.now(), data });
      if (stateHistory.length > MAX_HISTORY) stateHistory.shift();

      if (agentState.executingPlan) {
        log("[WS] execution active → skip planning");
        return;
      }

      llmFeedData(data);
    } catch (e) {
      log("[WS PARSE ERROR]", e.message);
    }
  });

  backendWs.on("error", (err) => {
    log("[WS ERROR]", err.message);
    broadcast("backend_status", { connected: false, error: err.message });
  });

  backendWs.on("close", () => {
    log("[WS] Closed, reconnecting in 5s");
    broadcast("backend_status", { connected: false });
    setTimeout(connectToBackendStream, 5000);
  });
}

function extractOpportunities(data) {
  return (data.matched_pools || []).map((p) => ({
    id: p.pool_address || p.id,
    pool_address: p.pool_address || p.id,
    token_a: p.mintA?.address || p.token_a,
    token_b: p.mintB?.address || p.token_b,
    symbol_a: p.mintA?.symbol || p.symbol_a || "?",
    symbol_b: p.mintB?.symbol || p.symbol_b || "?",
    tvl: p.tvl,
    price: p.price,
    current_tick: p.current_tick,
    fee_rate: p.fee_rate,
    volume_24h: p.volume_24h,
    timestamp: Date.now(),
  }));
}

/* ===== CAPITAL FLOW ANALYSIS (prevents doom-swapping + SOL drain) ===== */

function analyzeCapitalFlows(plan, walletUpdate) {
  const tokens = walletUpdate.tokens || {};
  const prices = walletUpdate.token_prices || {};
  const pools = walletUpdate.matched_pools || [];
  const positions = walletUpdate.owner_positions_summary || {};

  const SOL_MINT = "So11111111111111111111111111111111111111112";
  const warnings = [];

  // ===== SOL SAFETY CHECK =====
  const solRaw = Number(tokens[SOL_MINT]?.amount_raw || 0);
  const solUi = solRaw / 1e9;
  const solPrice = prices[SOL_MINT]?.usdPrice || 0;

  if (solUi < 0.03) {
    warnings.push(
      `CRITICAL: SOL balance ${solUi.toFixed(4)} below minimum (0.03)`,
    );
    return { safe: false, warnings, adjustedSteps: [] };
  }

  if (solUi < 0.05) {
    warnings.push(
      `WARNING: SOL balance ${solUi.toFixed(4)} is low — reducing budgets`,
    );
  }

  // ===== ORDERING: all decreases before all increases =====
  let seenIncrease = false;
  let needsReorder = false;

  for (const step of plan.steps) {
    if (step.type === "increase_position") seenIncrease = true;
    if (step.type === "decrease_position" && seenIncrease) {
      needsReorder = true;
      break;
    }
  }

  let orderedSteps = [...plan.steps];
  if (needsReorder) {
    warnings.push("Reordering steps: decreases before increases");
    const decreases = orderedSteps.filter(
      (s) => s.type === "decrease_position",
    );
    const increases = orderedSteps.filter(
      (s) => s.type === "increase_position",
    );
    orderedSteps = [...decreases, ...increases];
  }

  // ===== TOKEN FLOW ANALYSIS =====
  const expectedReleases = {};

  for (const step of orderedSteps) {
    if (step.type === "decrease_position") {
      const poolInfo = pools.find(
        (p) => (p.pool_address || p.id) === step.pool,
      );
      if (poolInfo) {
        const mintA = poolInfo.mintA?.address || poolInfo.token_a;
        const mintB = poolInfo.mintB?.address || poolInfo.token_b;
        if (mintA) expectedReleases[mintA] = (expectedReleases[mintA] || 0) + 1;
        if (mintB) expectedReleases[mintB] = (expectedReleases[mintB] || 0) + 1;
      }
    }
  }

  // Check reuse potential
  for (const step of orderedSteps) {
    if (step.type === "increase_position") {
      const poolInfo = pools.find(
        (p) => (p.pool_address || p.id) === step.pool,
      );
      if (poolInfo) {
        const mintA = poolInfo.mintA?.address || poolInfo.token_a;
        const mintB = poolInfo.mintB?.address || poolInfo.token_b;
        if (expectedReleases[mintA] > 0 || expectedReleases[mintB] > 0) {
          log(
            `[FLOW] increase on ${step.pool.slice(0, 12)}... can reuse tokens from decrease`,
          );
        }
      }
    }
  }

  // ===== DOOM-SWAP DETECTION =====
  const increaseNeeds = new Set();
  const decreaseReleases = new Set();

  for (const step of orderedSteps) {
    const poolInfo = pools.find((p) => (p.pool_address || p.id) === step.pool);
    if (!poolInfo) continue;
    const mintA = poolInfo.mintA?.address || poolInfo.token_a;
    const mintB = poolInfo.mintB?.address || poolInfo.token_b;

    if (step.type === "increase_position") {
      if (mintA) increaseNeeds.add(mintA);
      if (mintB) increaseNeeds.add(mintB);
    }
    if (step.type === "decrease_position") {
      if (mintA) decreaseReleases.add(mintA);
      if (mintB) decreaseReleases.add(mintB);
    }
  }

  const reusable = [...increaseNeeds].filter((m) => decreaseReleases.has(m));
  if (reusable.length > 0) {
    log(
      `[FLOW] ${reusable.length} token(s) can be routed directly (no swap needed)`,
    );
  }

  // ===== BUDGET ADJUSTMENT =====
  let budgetMultiplier = 1.0;
  if (solUi < 0.05) {
    budgetMultiplier = 0.5;
    warnings.push(`Reducing all budgets by 50% due to low SOL`);
  }

  const adjustedSteps = orderedSteps.map((step) => {
    if (step.type === "increase_position" && budgetMultiplier < 1.0) {
      return { ...step, budget_usd: step.budget_usd * budgetMultiplier };
    }
    return step;
  });

  return { safe: true, warnings, adjustedSteps };
}

/* ===== LLM AGENT LOGIC ===== */

function loadDecisionLog() {
  try {
    if (fs.existsSync(DECISIONS_FILE))
      decisionLog = JSON.parse(fs.readFileSync(DECISIONS_FILE, "utf-8"));
  } catch {
    decisionLog = [];
  }
}

function persistDecisionLog() {
  try {
    fs.writeFileSync(DECISIONS_FILE, JSON.stringify(decisionLog, null, 2));
  } catch {}
}

function llmStart() {
  if (llmRunning) return false;
  if (!LLM_API_KEY) throw new Error("LLM_API_KEY not set in environment");
  llmRunning = true;
  batchBuffer = [];
  log("[AGENT] Started:", LLM_PROVIDER, LLM_MODEL);
  broadcast("agent_status", llmGetStatus());
  return true;
}

function llmStop() {
  if (!llmRunning) return false;
  llmRunning = false;
  if (batchTimer) {
    clearTimeout(batchTimer);
    batchTimer = null;
  }
  batchBuffer = [];
  log("[AGENT] Stopped");
  broadcast("agent_status", llmGetStatus());
  return true;
}

function llmGetStatus() {
  return {
    running: llmRunning,
    provider: LLM_PROVIDER,
    model: LLM_MODEL,
    batch_buffer_size: batchBuffer.length,
    batch_target: llmConfig.batchSize,
    total_decisions: decisionLog.length,
    recent_decisions: decisionLog.slice(-10),
  };
}

function llmFeedData(data) {
  if (!llmRunning) return;
  batchBuffer.push({
    timestamp: Date.now(),
    matched_pools: data.matched_pools || [],
    raw: {
      ...data,
      normalized_tokens: normalizeForLLM(data),
    },
  });
  broadcast("agent_buffer", {
    size: batchBuffer.length,
    target: llmConfig.batchSize,
  });
  if (batchBuffer.length === 1 && !batchTimer) {
    batchTimer = setTimeout(() => {
      if (batchBuffer.length > 0 && llmRunning) llmFlushBatch();
      batchTimer = null;
    }, llmConfig.batchTimeoutMs);
  }
  if (batchBuffer.length >= llmConfig.batchSize) {
    if (batchTimer) {
      clearTimeout(batchTimer);
      batchTimer = null;
    }
    llmFlushBatch();
  }
}

async function llmFlushBatch() {
  if (!batchBuffer.length) return;

  // 🔴 LOCK: prevent new plans while executing
  if (agentState.executingPlan) {
    log("[FLUSH] execution active → skip");
    return;
  }

  const batch = [...batchBuffer];
  batchBuffer = [];

  log("[AGENT] Processing batch of", batch.length);

  try {
    const decision = await llmQuery(batch);
    if (!decision) return;

    // 🔥 LOCK EXECUTION
    agentState.executingPlan = true;

    await llmExecute(decision);
  } catch (err) {
    log("[AGENT ERROR]", err.message);
    agentState.executingPlan = false;
  }
}

async function llmQuery(batch) {
  const latest = batch[batch.length - 1].raw;

  let skillContext = "";
  try {
    if (fs.existsSync("./SKILL.md")) {
      skillContext = fs.readFileSync("./SKILL.md", "utf-8");
    }
  } catch {}

  const prompt = skillContext;

  log("[AGENT] Querying LLM...");

  let responseText = "";

  if (LLM_PROVIDER === "anthropic") {
    const agent = new HttpsProxyAgent("http://127.0.0.1:2080");

    const res = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: LLM_MODEL,
        max_tokens: llmConfig.maxTokens,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
      },
      {
        headers: {
          "x-api-key": LLM_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        httpsAgent: agent,
        httpAgent: agent,
        proxy: true,
        timeout: 60000,
      },
    );

    responseText = res.data?.content?.map((c) => c.text || "").join("\n") || "";
  }

  // 🔥 CRITICAL LOG
  log("[LLM RAW RESPONSE]", responseText.slice(0, 800));

  try {
    const start = responseText.indexOf("{");
    const end = responseText.lastIndexOf("}");

    if (start === -1 || end === -1) {
      throw new Error("No JSON found in response");
    }

    const jsonStr = responseText.slice(start, end + 1);
    const decision = JSON.parse(jsonStr);

    // 🔥 LOG PARSED
    log("[LLM PARSED]", JSON.stringify(decision, null, 2));

    if (!decision.steps || !Array.isArray(decision.steps)) {
      throw new Error("Invalid decision format");
    }

    // ===== BROADCAST REASONING TO UI =====
    if (decision.reasoning && Array.isArray(decision.reasoning)) {
      decision.reasoning.forEach((r, i) => {
        const entry = {
          time: iso(),
          phase: "decision",
          message: r,
          pool_id: decision.steps?.[0]?.pool || null,
          action: decision.steps?.length
            ? decision.steps[0].type === "increase_position"
              ? "add_liq"
              : decision.steps[0].type === "decrease_position"
                ? "remove_liq"
                : "hold"
            : "hold",
        };
        decisionLog.push(entry);
        broadcast("reasoning", entry);
      });
      persistDecisionLog();
    }

    // Broadcast full decision summary
    broadcast("decision_made", {
      time: iso(),
      steps: decision.steps,
      reasoning: decision.reasoning,
    });

    return decision;
  } catch (err) {
    log("[AGENT PARSE ERROR]", err.message);
    broadcast("reasoning", {
      time: iso(),
      phase: "error",
      message: `Parse error: ${err.message}`,
    });
    return null;
  }
}
/* ===== PLAN EXECUTOR (mirrors test.js executePlan) ===== */

async function llmExecute(decision) {
  log(
    "[EXECUTOR v2] Starting optimized execution with balance:",
    JSON.stringify(agentState.balance),
  );
  const inspection = inspectAndNormalizePlan(
    decision,
    agentState.latestWalletUpdate?.matched_pools || [],
  );
  // --- DEBUG LOG ---
  log("[PLAN RAW]", JSON.stringify(decision, null, 2));
  log("[PLAN NORMALIZED]", JSON.stringify(inspection.normalized, null, 2));
  if (!inspection.valid) {
    log("[PLAN INVALID]", inspection.errors);
    agentState.executingPlan = false;
    return;
  }

  if (!inspection.normalized.steps.length) {
    log("[PLAN EMPTY] No steps returned — forcing fallback");

    inspection.normalized.steps.push({
      type: "increase_position",
      pool: agentState.latestWalletUpdate?.matched_pools?.[0]?.id,
      budget_usd: Math.max(3, agentState.balance.total_usd * 0.8),
      range_pct: 0.2,
    });
  }
  if (!inspection.valid) {
    log("[PLAN INVALID]", inspection.errors);

    broadcast("plan_invalid", {
      errors: inspection.errors,
      raw: decision,
    });

    agentState.executingPlan = false;
    return;
  }

  const plan = inspection.normalized;

  if (!plan.steps || !plan.steps.length) {
    log("[AGENT] No steps — HOLD");
    broadcast("action", {
      type: "HOLD",
      time: iso(),
      reasoning: "No steps needed",
    });
    agentState.executingPlan = false;
    return;
  }

  // ==================== CAPITAL FLOW ANALYSIS ====================
  const walletUpdate = agentState.latestWalletUpdate;
  if (!walletUpdate) {
    log("[EXECUTOR v2] No wallet state available");
    agentState.executingPlan = false;
    return;
  }

  const flowAnalysis = analyzeCapitalFlows(plan, walletUpdate);

  for (const w of flowAnalysis.warnings) {
    log("[FLOW WARNING]", w);
    broadcast("flow_warning", { message: w });
  }

  if (!flowAnalysis.safe) {
    log("[EXECUTOR v2] Plan not safe — aborting");
    broadcast("plan_error", {
      error: "Capital flow analysis failed",
      warnings: flowAnalysis.warnings,
    });
    agentState.executingPlan = false;
    return;
  }

  // Use reordered + adjusted steps
  const optimizedPlan = {
    ...plan,
    steps: flowAnalysis.adjustedSteps,
  };

  if (planRunning) {
    log("[AGENT] Plan already running, skipping");
    agentState.executingPlan = false;
    return;
  }

  planRunning = true;
  currentPlan = optimizedPlan;
  currentStepIndex = 0;
  executionLog = [];

  broadcast("plan_start", {
    steps: optimizedPlan.steps.length,
    reasoning: decision.reasoning,
    optimized: true,
    warnings: flowAnalysis.warnings,
    ts: iso(),
  });

  // Broadcast each step as an action
  optimizedPlan.steps.forEach((step, i) => {
    broadcast("action", {
      time: iso(),
      type:
        step.type === "increase_position"
          ? "ADD_LIQ"
          : step.type === "decrease_position"
            ? "REMOVE_LIQ"
            : "HOLD",
      pool: step.pool,
      amount: step.budget_usd || null,
      range_pct: step.range_pct || null,
      fraction: step.fraction || null,
      reasoning: decision.reasoning?.[i] || `Step ${i}: ${step.type}`,
    });
  });

  // ==================== TRY OPTIMIZED ENDPOINT ====================
  try {
    const SOL_MINT = "So11111111111111111111111111111111111111112";

    const solPrice = walletUpdate?.token_prices?.[SOL_MINT]?.usdPrice || 0;

    const enrichedWalletUpdate = {
      ...walletUpdate,
      wallet_pubkey: walletAddress,
      tokens: {
        ...(walletUpdate.tokens || {}),
        [SOL_MINT]: {
          amount_raw: Math.floor(agentState.balance.sol * 1e9).toString(),
        },
      },
      token_prices: {
        ...(walletUpdate.token_prices || {}),
        [SOL_MINT]: {
          usdPrice: solPrice,
        },
      },
    };

    // Try the optimized endpoint first (all steps at once, no per-step swaps)
    let useOptimized = true;
    let results = null;

    try {
      const resp = await axios.post(
        `${staticConfig.agent_server}/agent/execute_optimized`,
        {
          api_key: backendApiKey,
          plan: optimizedPlan,
          wallet_update: enrichedWalletUpdate,
          slippage: 0.05,
        },
        { proxy: false, timeout: 120000 },
      );

      results = resp.data;

      if (results.error) {
        throw new Error(results.error);
      }

      log(
        "[EXECUTOR v2] Using optimized endpoint — got",
        Array.isArray(results) ? results.length : 0,
        "step results",
      );
    } catch (optimizedErr) {
      if (optimizedErr.response?.status === 404) {
        log(
          "[EXECUTOR v2] Optimized endpoint not available — falling back to per-step",
        );
        useOptimized = false;
      } else {
        throw optimizedErr;
      }
    }

    if (useOptimized && Array.isArray(results)) {
      // ==================== OPTIMIZED PATH: all results at once ====================
      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        if (result.error) {
          log("[EXEC-OPT] step", i, "error:", result.error);
          executionLog.push({
            ts: iso(),
            phase: "error",
            step: i,
            description: result.error,
            status: "failed",
          });
          continue;
        }

        broadcast("step_update", {
          step: i,
          total: results.length,
          description: result.description,
          phase: result.phase,
        });

        const sigs = [];
        for (let j = 0; j < (result.txs || []).length; j++) {
          broadcast("step_update", {
            step: i,
            total: results.length,
            description: `Signing TX ${j + 1}/${result.txs.length}...`,
            phase: "signing",
          });

          const sig = await sendAnyTx(result.txs[j]);
          sigs.push(sig);

          recordTx(sig, result.phase || "unknown", null, 0);
        }

        executionLog.push({
          ts: iso(),
          phase: result.phase,
          step: i,
          description: result.description,
          status: "confirmed",
          sigs,
        });

        broadcast("step_update", {
          step: i,
          total: results.length,
          description: `Phase ${result.phase} confirmed (${sigs.length} txs)`,
          phase: "confirmed",
          sigs,
        });

        // Track positions
        const step = optimizedPlan.steps[i];
        if (
          step?.type === "increase_position" &&
          result.phase === "add_liquidity" &&
          sigs.length > 0
        ) {
          const pos = {
            id: uuidv4(),
            pool_id: step.pool,
            budget_usd: step.budget_usd,
            range_pct: step.range_pct,
            opened_at: iso(),
            status: "active",
            sigs,
          };
          agentState.positions.push(pos);
          agentState.statistics.positions_opened++;
          agentState.statistics.total_deployed += step.budget_usd || 0;
          broadcast("position_opened", pos);
        }

        if (step?.type === "decrease_position" && step.fraction >= 1.0) {
          const existing = agentState.positions.find(
            (p) => p.pool_id === step.pool && p.status === "active",
          );
          if (existing) {
            existing.status = "closed";
            existing.closed_at = iso();
            agentState.statistics.positions_closed++;
            broadcast("position_closed", existing);
          }
        }

        // Wait for chain state between steps
        if (!result.done && result.txs?.length > 0) {
          broadcast("step_update", {
            step: i,
            total: results.length,
            description: "Waiting for chain state update...",
            phase: "waiting",
          });
          await waitForNextWsUpdate();
        }
      }

      log("[EXECUTOR v2] Optimized execution complete");
    } else {
      // ==================== FALLBACK: per-step execution ====================
      log("[EXECUTOR v2] Falling back to per-step execution");

      let stepIndex = 0;

      for (let iter = 0; iter < 20; iter++) {
        const step = optimizedPlan.steps[stepIndex];

        const freshWalletUpdate = agentState.latestWalletUpdate;
        if (!freshWalletUpdate) {
          throw new Error("Missing live wallet state");
        }

        // Guards
        const backendPositions =
          freshWalletUpdate?.owner_positions_summary?.[step.pool] || [];

        if (step?.type === "increase_position" && backendPositions.length > 0) {
          log("[GUARD] Backend already has position → skipping increase");
          stepIndex++;
          if (stepIndex >= optimizedPlan.steps.length) break;
          continue;
        }

        const alreadyTried = executionLog.some(
          (e) =>
            e.step === stepIndex &&
            e.description.includes(step.pool) &&
            e.status === "confirmed",
        );

        if (step?.type === "increase_position" && alreadyTried) {
          throw new Error("Preventing repeated increase loop on same pool");
        }

        currentStepIndex = stepIndex;

        const execEntry = {
          ts: iso(),
          phase: "executing",
          step: stepIndex,
          description: step
            ? `${step.type} on ${(step.pool || "").slice(0, 12)}...`
            : "unknown",
          status: "pending",
        };

        executionLog.push(execEntry);

        broadcast("step_update", {
          step: stepIndex,
          total: optimizedPlan.steps.length,
          description: execEntry.description,
          phase: "executing",
        });

        // Enrich
        const enrichedForStep = {
          ...freshWalletUpdate,
          wallet_pubkey: walletAddress,
          tokens: {
            ...(freshWalletUpdate.tokens || {}),
            [SOL_MINT]: {
              amount_raw: Math.floor(agentState.balance.sol * 1e9).toString(),
            },
          },
          token_prices: {
            ...(freshWalletUpdate.token_prices || {}),
            [SOL_MINT]: {
              usdPrice: solPrice,
            },
          },
        };

        const resp = await axios.post(
          `${staticConfig.agent_server}/agent/next_step`,
          {
            api_key: backendApiKey,
            plan: optimizedPlan,
            step_index: stepIndex,
            wallet_update: enrichedForStep,
            slippage: 0.05,
          },
          { proxy: false },
        );

        const r = resp.data;

        if (r.error) throw new Error(r.error);

        if (!r.txs?.length) {
          log("[EXEC] No TX → forcing forward", r.phase);
          stepIndex++;
          if (stepIndex >= optimizedPlan.steps.length) break;
          continue;
        }

        const sigs = [];
        for (let i = 0; i < r.txs.length; i++) {
          broadcast("step_update", {
            step: stepIndex,
            total: optimizedPlan.steps.length,
            description: `Signing TX ${i + 1}/${r.txs.length}...`,
            phase: "signing",
          });

          const sig = await sendAnyTx(r.txs[i]);
          sigs.push(sig);

          recordTx(
            sig,
            step?.type || "unknown",
            step?.pool,
            step?.budget_usd || 0,
          );
        }

        execEntry.status = "confirmed";
        execEntry.sigs = sigs;

        broadcast("step_update", {
          step: stepIndex,
          total: optimizedPlan.steps.length,
          description: `Step ${stepIndex} confirmed (${sigs.length} txs)`,
          phase: "confirmed",
          sigs,
        });

        if (
          step?.type === "increase_position" &&
          r.phase === "AddLiquidity" &&
          r.txs.length > 0
        ) {
          const pos = {
            id: uuidv4(),
            pool_id: step.pool,
            budget_usd: step.budget_usd,
            range_pct: step.range_pct,
            opened_at: iso(),
            status: "active",
            sigs,
          };
          agentState.positions.push(pos);
          agentState.statistics.positions_opened++;
          agentState.statistics.total_deployed += step.budget_usd || 0;
          broadcast("position_opened", pos);
        }

        if (step?.type === "decrease_position" && step.fraction >= 1.0) {
          const existing = agentState.positions.find(
            (p) => p.pool_id === step.pool && p.status === "active",
          );
          if (existing) {
            existing.status = "closed";
            existing.closed_at = iso();
            agentState.statistics.positions_closed++;
            broadcast("position_closed", existing);
          }
        }

        if (r.done) break;

        broadcast("step_update", {
          step: stepIndex,
          total: optimizedPlan.steps.length,
          description: "Waiting for chain state update...",
          phase: "waiting",
        });

        await waitForNextWsUpdate();

        log("[EXEC] received fresh WS state");

        stepIndex = r.next_step_index;
      }
    }
  } catch (err) {
    log("[PLAN ERROR]", err.message);
    broadcast("plan_error", { error: err.message, step: currentStepIndex });
    executionLog.push({
      ts: iso(),
      phase: "error",
      step: currentStepIndex,
      description: err.message,
      status: "failed",
    });
  }

  planRunning = false;
  currentPlan = null;
  currentStepIndex = -1;

  // 🔥 UNLOCK
  agentState.executingPlan = false;

  log("[EXEC v2] plan finished → unlocked");

  // 🔥 PROCESS DEFERRED UPDATE
  if (agentState.hasFreshUpdate && agentState.latestWalletUpdate) {
    agentState.hasFreshUpdate = false;

    log("[EXEC v2] processing deferred update");

    llmFeedData(agentState.latestWalletUpdate);
  }
  agentState.last_activity = iso();
  broadcast("plan_complete", {
    ts: iso(),
    steps_executed: executionLog.length,
  });
  broadcastCleanState();
}

/* ===== DIAGNOSTICS ===== */

const diagnostics = {
  solana_rpc: { ok: false, latency_ms: null, error: null, last_check: null },
  wallet: { ok: false, address: null, sol: 0, error: null, last_check: null },
  backend_http: { ok: false, latency_ms: null, error: null, last_check: null },
  backend_ws: { ok: false, error: null, last_check: null },
  llm_api: { ok: false, provider: null, error: null, last_check: null },
  wdk: { ok: false, initialized: false, error: null, last_check: null },
};

async function runDiagnostics() {
  const now = iso();

  try {
    const t = Date.now();
    await connection.getSlot();
    diagnostics.solana_rpc = {
      ok: true,
      latency_ms: Date.now() - t,
      error: null,
      last_check: now,
    };
  } catch (e) {
    diagnostics.solana_rpc = {
      ok: false,
      latency_ms: null,
      error: e.message,
      last_check: now,
    };
  }

  if (solAccount) {
    try {
      const l = await solAccount.getBalance();
      diagnostics.wallet = {
        ok: true,
        address: walletAddress,
        sol: Number(l) / 1e9,
        error: null,
        last_check: now,
      };
    } catch (e) {
      diagnostics.wallet = {
        ok: false,
        address: walletAddress,
        sol: 0,
        error: e.message,
        last_check: now,
      };
    }
  } else {
    diagnostics.wallet = {
      ok: false,
      address: null,
      sol: 0,
      error: "not initialized",
      last_check: now,
    };
  }

  try {
    const t = Date.now();
    await axios.get(staticConfig.agent_server + "/", {
      timeout: 5000,
      proxy: false,
    });
    diagnostics.backend_http = {
      ok: true,
      latency_ms: Date.now() - t,
      error: null,
      last_check: now,
    };
  } catch (e) {
    diagnostics.backend_http = e.response
      ? { ok: true, latency_ms: null, error: null, last_check: now }
      : { ok: false, latency_ms: null, error: e.message, last_check: now };
  }

  diagnostics.backend_ws = {
    ok: backendWs?.readyState === WebSocket.OPEN,
    error: backendWs?.readyState === WebSocket.OPEN ? null : "not connected",
    last_check: now,
  };

  diagnostics.llm_api = {
    ok: !!LLM_API_KEY,
    provider: LLM_PROVIDER,
    error: LLM_API_KEY ? null : "LLM_API_KEY not set",
    last_check: now,
  };

  diagnostics.wdk = {
    ok: wdkInitialized,
    initialized: wdkInitialized,
    error: wdkInitialized
      ? null
      : WDK
        ? "wallet not created"
        : "WDK not installed",
    last_check: now,
  };

  broadcast("diagnostics", diagnostics);
  await updateBalance();
  broadcastCleanState();
}

/* ===== HTTP ENDPOINTS ===== */

// No auth middleware — hackathon demo mode
app.get("/health", (req, res) =>
  res.json({
    agent: walletAddress ? "initialized" : "not_initialized",
    wallet: walletAddress,
    backend_connected: backendWs?.readyState === WebSocket.OPEN,
    llm_agent: llmGetStatus(),
    diagnostics,
    wdk: wdkInitialized,
  }),
);

app.get("/diagnostics", (req, res) => res.json(diagnostics));

// Settings: READ-ONLY. Config comes from env vars only.
app.get("/settings", (req, res) =>
  res.json({
    ...staticConfig,
    llm_api_key: LLM_API_KEY ? "***configured***" : "",
    llm_model: LLM_MODEL,
    readonly: true,
  }),
);

// Block all setting mutations
app.post("/settings", (req, res) =>
  res.status(403).json({
    error:
      "Configuration is managed via environment variables. UI modifications are restricted.",
  }),
);

// Agent start/stop
app.post("/agent/start", (req, res) => {
  try {
    if (!walletAddress)
      return res.status(400).json({ error: "Agent not initialized" });
    const ok = llmStart();
    if (ok) {
      broadcast("agent_started", { provider: LLM_PROVIDER });
      res.json({ status: "started" });
    } else {
      res.status(400).json({ error: "Already running" });
    }
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/agent/stop", (req, res) => {
  res
    .status(403)
    .json({ error: "Agent stop is restricted. The agent runs autonomously." });
});

app.get("/agent/status", (req, res) => res.json(llmGetStatus()));
app.get("/agent/decisions", (req, res) => res.json(decisionLog.slice(-50)));

// Agent create
app.post("/agent/create", async (req, res) => {
  try {
    // ===================== CASE 1: already in memory =====================
    if (walletAddress) {
      return res.json({
        agent_id: agentState.agent_id,
        wallet: walletAddress,
        created_at: agentState.last_activity,
        reused: true,
      });
    }

    // ===================== CASE 2: exists on disk =====================
    const stored = load(DB_FILE);

    if (stored?.seedPhrase) {
      log("[AGENT] Reusing existing wallet from DB...");

      await initWalletFromSeed(stored.seedPhrase);

      agentState.agent_id =
        stored.agent_id || "oc-" + Math.floor(Math.random() * 100000);
      agentState.wallet = walletAddress;
      agentState.last_activity = stored.created_at || iso();

      await authenticateWithBackend();
      connectToBackendStream();

      broadcast("agent_restored", {
        agent_id: agentState.agent_id,
        wallet: walletAddress,
      });

      return res.json({
        agent_id: agentState.agent_id,
        wallet: walletAddress,
        created_at: agentState.last_activity,
        reused: true,
      });
    }

    // ===================== CASE 3: create new =====================
    log("[AGENT] Creating NEW wallet...");

    const wallet = await createWallet();

    agentState.agent_id = "oc-" + Math.floor(Math.random() * 100000);
    agentState.wallet = wallet.address;
    agentState.last_activity = iso();

    // persist
    save(DB_FILE, {
      seedPhrase: wallet.seedPhrase,
      address: wallet.address,
      agent_id: agentState.agent_id,
      created_at: agentState.last_activity,
    });

    await authenticateWithBackend();
    connectToBackendStream();

    broadcast("agent_created", {
      agent_id: agentState.agent_id,
      wallet: wallet.address,
    });

    return res.json({
      agent_id: agentState.agent_id,
      wallet: wallet.address,
      created_at: agentState.last_activity,
      reused: false,
    });
  } catch (err) {
    log("[CREATE ERROR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reconnect
app.post("/agent/reconnect", async (req, res) => {
  res
    .status(403)
    .json({ error: "Backend reconnection is managed automatically." });
});

// State
app.get("/state", async (req, res) => {
  if (!walletAddress) return res.status(404).json({ error: "not created" });
  await updateBalance();
  res.json({
    ...agentState,
    livePositions: agentState.livePositions || null,
    matchedPools: agentState.matchedPools || [],
    poolsFull: agentState.poolsFull || [],
  });
});

// TX log
app.get("/txlog", (req, res) => res.json(txLog.slice(-100)));

// Execution state
app.get("/execution", (req, res) =>
  res.json({
    running: planRunning,
    current_step: currentStepIndex,
    total_steps: currentPlan?.steps?.length || 0,
    log: executionLog.slice(-20),
  }),
);

// BLOCKED: wallet export
app.get("/wallet/export", (req, res) =>
  res.status(403).json({
    error:
      "Private key export is disabled. This agent uses self-custodial WDK wallet management.",
  }),
);

/* ===== DASHBOARD WS ===== */

const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) => {
  log("[DASH] Client connected");
  dashboardClients.push(socket);

  // Send initial state
  if (walletAddress) {
    const { latestWalletUpdate, ...clean } = agentState;
    socket.send(JSON.stringify({ type: "state_update", data: clean }));
  }
  socket.send(JSON.stringify({ type: "agent_status", data: llmGetStatus() }));
  socket.send(
    JSON.stringify({
      type: "backend_status",
      data: { connected: backendWs?.readyState === WebSocket.OPEN },
    }),
  );
  socket.send(JSON.stringify({ type: "diagnostics", data: diagnostics }));
  socket.send(
    JSON.stringify({
      type: "config",
      data: {
        ...staticConfig,
        llm_api_key: LLM_API_KEY ? "***" : "",
        readonly: true,
      },
    }),
  );
  socket.send(JSON.stringify({ type: "txlog", data: txLog.slice(-50) }));
  socket.send(
    JSON.stringify({ type: "decision_history", data: decisionLog.slice(-50) }),
  );
  socket.send(
    JSON.stringify({
      type: "execution",
      data: {
        running: planRunning,
        current_step: currentStepIndex,
        total_steps: currentPlan?.steps?.length || 0,
        log: executionLog.slice(-20),
      },
    }),
  );

  socket.on("close", () => {
    dashboardClients = dashboardClients.filter((x) => x !== socket);
  });
  socket.on("error", () => {});
});

/* ===== INIT ===== */

async function initialize() {
  log("══════════════════════════════════════════");
  log("  OpenClaw — Autonomous CLMM Agent");
  log("  WDK Self-Custodial Wallet Engine");
  log("══════════════════════════════════════════");

  loadDecisionLog();

  // Load existing TX log
  const savedTxLog = load(TX_LOG_FILE, []);
  if (savedTxLog.length) txLog.push(...savedTxLog);

  const stored = load(DB_FILE);
  if (stored?.seedPhrase) {
    log("[INIT] Restoring wallet...");
    try {
      await initWalletFromSeed(stored.seedPhrase);
      agentState.agent_id =
        stored.agent_id || "oc-" + Math.floor(Math.random() * 100000);
      agentState.wallet = walletAddress;
      agentState.last_activity = stored.created_at;
      try {
        await authenticateWithBackend();
        connectToBackendStream();
      } catch (e) {
        log("[INIT] Backend connection deferred:", e.message);
      }
    } catch (e) {
      log("[INIT] Wallet restore failed:", e.message);
    }
  } else {
    log("[INIT] No agent — create via dashboard");
  }

  setInterval(runDiagnostics, 15000);
  runDiagnostics();
  log("[INIT] Ready on port", PORT);

  // Auto-start agent after a short delay to allow WS connection
  setTimeout(() => {
    if (walletAddress && !llmRunning) {
      try {
        llmStart();
        log("[INIT] Agent auto-started");
      } catch (e) {
        log("[INIT] Agent auto-start failed:", e.message);
      }
    }
  }, 3000);
}

const server = app.listen(PORT, () => initialize());
server.on("upgrade", (req, socket, head) => {
  if (req.url === "/ws")
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  else socket.destroy();
});

process.on("SIGINT", () => {
  log("[SHUTDOWN]");
  if (walletManager)
    try {
      walletManager.dispose();
    } catch {}
  if (backendWs)
    try {
      backendWs.close();
    } catch {}
  llmStop();
  server.close(() => process.exit(0));
});

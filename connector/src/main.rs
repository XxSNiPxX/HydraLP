use axum::{
    extract::ws::{Message, WebSocket},
    extract::{Query, State, WebSocketUpgrade},
    routing::{get, post},
    Json, Router,
};
use futures::{SinkExt, StreamExt};
use reqwest::Client;
use solana_sdk::message::compiled_instruction::CompiledInstruction;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use std::{
    collections::{HashMap, HashSet},
    fs,
    sync::Arc,
};

use chrono::Utc;
use tokio::sync::{broadcast, RwLock};
use uuid::Uuid;

// Transaction verification
use solana_sdk::{pubkey::Pubkey, transaction::Transaction};
use std::str::FromStr;

const DB_FILE: &str = "db.json";
const EXECUTOR_BASE: &str = "http://localhost:8080";

fn trace_id() -> String {
    Uuid::new_v4().to_string()
}

fn logx(trace: &str, stage: &str, data: serde_json::Value) {
    println!(
        "{}",
        serde_json::json!({
            "ts": chrono::Utc::now().timestamp_millis(),
            "trace": trace,
            "stage": stage,
            "data": data
        })
    );
}

fn log(event: &str, payload: Value) {
    println!(
        "{}",
        json!({
            "ts": Utc::now().timestamp_millis(),
            "event": event,
            "data": payload
        })
    );
}

/* =============== STRUCTS =============== */

#[derive(Clone, Serialize, Deserialize, Eq, PartialEq, Hash)]
struct TokenPair {
    mint_a: String,
    mint_b: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct Agent {
    agent_id: String,
    wallet: String,
    api_key: String,
    token_pairs: HashSet<TokenPair>,
    registered_at: i64,
}

#[derive(Default, Serialize, Deserialize)]
struct Database {
    agents: HashMap<String, Agent>,
    used_nonces: HashSet<String>,
}

#[derive(Clone)]
struct AppState {
    db: Arc<RwLock<Database>>,
    upstream_tx: broadcast::Sender<Value>,
    http_client: Client,
}

/* =============== REQUEST/RESPONSE TYPES =============== */

#[derive(Deserialize)]
struct AuthReq {
    wallet: String,
    nonce: String,
    signed_tx: String, // base64 serialized transaction
}

#[derive(Serialize)]
struct AuthResp {
    agent_id: String,
    api_key: String,
}

#[derive(Serialize)]
struct NonceResp {
    nonce: String,
}

#[derive(Deserialize)]
struct AddPairsReq {
    api_key: String,
    token_pairs: Vec<TokenPair>,
}

#[derive(Deserialize)]
struct RemovePairsReq {
    api_key: String,
    token_pairs: Vec<TokenPair>,
}

#[derive(Deserialize)]
struct ApiKeyQuery {
    api_key: String,
}

#[derive(Deserialize)]
struct WsQuery {
    api_key: String,
}

/* =============== PLAN / STEP TYPES (mirror executor) =============== */

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type")]
enum Step {
    #[serde(rename = "increase_position")]
    IncreasePosition {
        pool: String,
        budget_usd: f64,
        range_pct: f64,
    },
    #[serde(rename = "decrease_position")]
    DecreasePosition { pool: String, fraction: f64 },
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct Plan {
    steps: Vec<Step>,
}

/// POST /agent/next_step — client-facing request
#[derive(Debug, Serialize, Deserialize)]
struct NextStepReqGateway {
    api_key: String,
    plan: Plan,
    step_index: usize,
    wallet_update: Value,
    slippage: Option<f64>,
}

/// What we forward to the executor (no api_key)
#[derive(Debug, Serialize)]
struct NextStepReqForward {
    plan: Plan,
    step_index: usize,
    wallet_update: Value,
    slippage: Option<f64>,
}

/// POST /agent/execute_optimized — client-facing request (NEW)
#[derive(Debug, Serialize, Deserialize)]
struct ExecuteOptimizedReqGateway {
    api_key: String,
    plan: Plan,
    wallet_update: Value,
    slippage: Option<f64>,
}

/// What we forward to the executor for optimized execution (no api_key)
#[derive(Debug, Serialize)]
struct ExecuteOptimizedReqForward {
    plan: Plan,
    wallet_update: Value,
    slippage: Option<f64>,
}

/* =============== MAIN =============== */

#[tokio::main]
async fn main() {
    let trace = trace_id();

    logx(&trace, "server:start", json!({}));

    let db = if let Ok(data) = fs::read_to_string(DB_FILE) {
        logx(&trace, "server:db_loaded", json!({}));
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        logx(&trace, "server:db_new", json!({}));
        Database::default()
    };

    let (upstream_tx, _) = broadcast::channel(8192);
    let http_client = Client::builder().no_proxy().build().unwrap();

    let state = AppState {
        db: Arc::new(RwLock::new(db)),
        upstream_tx: upstream_tx.clone(),
        http_client,
    };

    tokio::spawn(run_upstream_listener(upstream_tx));

    let app = Router::new()
        .route("/agent/nonce", get(get_nonce))
        .route("/agent/register", post(register))
        .route("/agent/login", post(login))
        .route("/agent/add_pairs", post(add_pairs))
        .route("/agent/remove_pairs", post(remove_pairs))
        .route("/agent/info", get(agent_info))
        .route("/health", get(health))
        .route("/stream", get(ws_handler))
        .route("/agent/next_step", post(next_step))
        .route("/agent/execute_optimized", post(execute_optimized))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:9000")
        .await
        .unwrap();

    logx(
        &trace,
        "server:listening",
        json!({ "addr": "127.0.0.1:9000" }),
    );

    axum::serve(listener, app).await.unwrap();
}

/* =============== NONCE GENERATION =============== */

async fn get_nonce() -> Json<NonceResp> {
    Json(NonceResp {
        nonce: Uuid::new_v4().to_string(),
    })
}

/* =============== TRANSACTION VERIFICATION =============== */

fn verify_tx(signed_tx_b64: &str, expected_wallet: &str, expected_nonce: &str) -> bool {
    let tx_bytes = match base64::decode(signed_tx_b64) {
        Ok(b) => b,
        Err(_) => {
            println!("[verify_tx] base64 decode failed");
            return false;
        }
    };

    let tx: Transaction = match bincode::deserialize(&tx_bytes) {
        Ok(t) => t,
        Err(e) => {
            println!("[verify_tx] bincode deserialize failed: {:?}", e);
            return false;
        }
    };

    if tx.verify().is_err() {
        println!("[verify_tx] signature verification failed");
        return false;
    }

    let signer = match tx.message.account_keys.get(0) {
        Some(k) => k,
        None => {
            println!("[verify_tx] no signer found");
            return false;
        }
    };

    let expected_pubkey = match Pubkey::from_str(expected_wallet) {
        Ok(p) => p,
        Err(_) => {
            println!("[verify_tx] invalid wallet pubkey");
            return false;
        }
    };

    if signer != &expected_pubkey {
        println!(
            "[verify_tx] signer mismatch: got {}, expected {}",
            signer, expected_pubkey
        );
        return false;
    }

    for ix in &tx.message.instructions {
        if let Some(nonce) = extract_memo(ix, &tx) {
            if nonce == expected_nonce {
                println!("[verify_tx] ✓ verification passed");
                return true;
            } else {
                println!(
                    "[verify_tx] nonce mismatch: got {}, expected {}",
                    nonce, expected_nonce
                );
            }
        }
    }

    println!("[verify_tx] no matching memo instruction found");
    false
}

fn extract_memo(ix: &CompiledInstruction, tx: &Transaction) -> Option<String> {
    let program_id = tx.message.account_keys.get(ix.program_id_index as usize)?;

    if program_id.to_string() != "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" {
        return None;
    }

    let data = ix.data.clone();
    String::from_utf8(data).ok()
}

/* =============== AUTH =============== */

async fn register(State(state): State<AppState>, Json(req): Json<AuthReq>) -> Json<AuthResp> {
    let trace = trace_id();

    logx(
        &trace,
        "register:start",
        json!({ "wallet": req.wallet, "nonce": req.nonce }),
    );

    if !verify_tx(&req.signed_tx, &req.wallet, &req.nonce) {
        logx(&trace, "register:tx_invalid", json!({}));
        return Json(AuthResp {
            agent_id: "".into(),
            api_key: "".into(),
        });
    }

    let mut db = state.db.write().await;

    if db.used_nonces.contains(&req.nonce) {
        logx(&trace, "register:nonce_reused", json!({}));
        return Json(AuthResp {
            agent_id: "".into(),
            api_key: "".into(),
        });
    }

    db.used_nonces.insert(req.nonce.clone());

    if let Some(agent) = db.agents.values().find(|a| a.wallet == req.wallet) {
        logx(
            &trace,
            "register:existing",
            json!({ "agent_id": agent.agent_id }),
        );
        save_db(&db);
        return Json(AuthResp {
            agent_id: agent.agent_id.clone(),
            api_key: agent.api_key.clone(),
        });
    }

    let agent_id = Uuid::new_v4().to_string();
    let api_key = Uuid::new_v4().to_string();

    db.agents.insert(
        agent_id.clone(),
        Agent {
            agent_id: agent_id.clone(),
            wallet: req.wallet.clone(),
            api_key: api_key.clone(),
            token_pairs: HashSet::new(),
            registered_at: Utc::now().timestamp_millis(),
        },
    );

    save_db(&db);

    logx(&trace, "register:created", json!({ "agent_id": agent_id }));

    Json(AuthResp { agent_id, api_key })
}

async fn login(State(state): State<AppState>, Json(req): Json<AuthReq>) -> Json<AuthResp> {
    let trace = trace_id();

    logx(&trace, "login:start", json!({ "wallet": req.wallet }));

    if !verify_tx(&req.signed_tx, &req.wallet, &req.nonce) {
        logx(&trace, "login:tx_invalid", json!({}));
        return Json(AuthResp {
            agent_id: "".into(),
            api_key: "".into(),
        });
    }

    let mut db = state.db.write().await;

    if db.used_nonces.contains(&req.nonce) {
        logx(&trace, "login:nonce_reused", json!({}));
        return Json(AuthResp {
            agent_id: "".into(),
            api_key: "".into(),
        });
    }

    db.used_nonces.insert(req.nonce.clone());
    save_db(&db);

    if let Some(agent) = db.agents.values().find(|a| a.wallet == req.wallet) {
        logx(
            &trace,
            "login:success",
            json!({ "agent_id": agent.agent_id }),
        );
        Json(AuthResp {
            agent_id: agent.agent_id.clone(),
            api_key: agent.api_key.clone(),
        })
    } else {
        logx(&trace, "login:not_found", json!({}));
        Json(AuthResp {
            agent_id: "".into(),
            api_key: "".into(),
        })
    }
}

/* =============== TOKEN PAIRS =============== */

async fn add_pairs(
    State(state): State<AppState>,
    Json(req): Json<AddPairsReq>,
) -> Json<&'static str> {
    let trace = trace_id();

    logx(
        &trace,
        "add_pairs:start",
        json!({ "api_key": req.api_key, "pairs": req.token_pairs }),
    );

    let (wallet, new_pairs) = {
        let mut db = state.db.write().await;

        let agent = match db.agents.values_mut().find(|a| a.api_key == req.api_key) {
            Some(a) => a,
            None => {
                logx(&trace, "add_pairs:invalid_api_key", json!({}));
                return Json("invalid_api_key");
            }
        };

        let mut new_pairs = Vec::new();
        for pair in &req.token_pairs {
            if agent.token_pairs.insert(pair.clone()) {
                new_pairs.push(pair.clone());
            }
        }

        let wallet = agent.wallet.clone();
        save_db(&db);
        (wallet, new_pairs)
    };

    if new_pairs.is_empty() {
        logx(&trace, "add_pairs:no_new_pairs", json!({}));
        return Json("ok");
    }

    let notify_pairs: Vec<[String; 2]> = new_pairs
        .iter()
        .map(|p| [p.mint_a.clone(), p.mint_b.clone()])
        .collect();

    let body = json!({
        "public_key": wallet,
        "token_pairs": notify_pairs
    });

    logx(&trace, "add_pairs:forward_request", body.clone());

    let resp = state
        .http_client
        .post(format!("{}/add_wallet", EXECUTOR_BASE))
        .json(&body)
        .send()
        .await;

    match resp {
        Ok(r) => {
            let status = r.status();
            let text = r.text().await.unwrap_or("NO_BODY".into());

            logx(
                &trace,
                "add_pairs:forward_response",
                json!({ "status": status.as_u16(), "body": text }),
            );

            if !status.is_success() {
                return Json("forward_failed");
            }

            Json("ok")
        }
        Err(e) => {
            logx(
                &trace,
                "add_pairs:forward_error",
                json!({ "err": format!("{:?}", e) }),
            );
            Json("forward_failed")
        }
    }
}

async fn remove_pairs(
    State(state): State<AppState>,
    Json(req): Json<RemovePairsReq>,
) -> Json<&'static str> {
    let wallet = {
        let mut db = state.db.write().await;

        let agent = match db.agents.values_mut().find(|a| a.api_key == req.api_key) {
            Some(a) => a,
            None => return Json("invalid_api_key"),
        };

        for pair in &req.token_pairs {
            agent.token_pairs.remove(pair);
        }

        agent.wallet.clone()
    };

    {
        let db = state.db.read().await;
        save_db(&db);
    }

    log("pairs_removed", json!({ "wallet": wallet }));

    Json("ok")
}

/* =============== AGENT INFO =============== */

async fn agent_info(State(state): State<AppState>, Query(q): Query<ApiKeyQuery>) -> Json<Value> {
    let db = state.db.read().await;

    if let Some(agent) = db.agents.values().find(|a| a.api_key == q.api_key) {
        Json(json!({
            "wallet": agent.wallet,
            "agent_id": agent.agent_id,
            "pairs": agent.token_pairs,
            "registered_at": agent.registered_at
        }))
    } else {
        Json(json!({"error":"invalid_api_key"}))
    }
}

/* =============== HEALTH =============== */

async fn health(State(state): State<AppState>) -> Json<Value> {
    let db = state.db.read().await;

    Json(json!({
        "status": "ok",
        "agents": db.agents.len(),
        "timestamp": Utc::now().timestamp_millis()
    }))
}

/* =============== NEXT STEP (per-step, original) =============== */

async fn next_step(
    State(state): State<AppState>,
    Json(req): Json<NextStepReqGateway>,
) -> Json<Value> {
    let trace = trace_id();

    logx(
        &trace,
        "next_step:start",
        json!({
            "step_index": req.step_index,
            "plan_steps": req.plan.steps.len(),
        }),
    );

    // ---- Auth ----
    let agent = {
        let db = state.db.read().await;
        db.agents
            .values()
            .find(|a| a.api_key == req.api_key)
            .cloned()
    };

    let agent = match agent {
        Some(a) => {
            logx(&trace, "next_step:auth_ok", json!({ "wallet": a.wallet }));
            a
        }
        None => {
            logx(&trace, "next_step:auth_fail", json!({}));
            return Json(json!({"error": "invalid_api_key"}));
        }
    };

    // ---- Wallet ownership check ----
    let wallet_pubkey = req.wallet_update["wallet_pubkey"].as_str();

    if wallet_pubkey != Some(agent.wallet.as_str()) {
        logx(&trace, "next_step:wallet_mismatch", json!({}));
        return Json(json!({"error": "wallet_mismatch"}));
    }

    if req.plan.steps.is_empty() {
        logx(&trace, "next_step:empty_plan", json!({}));
        return Json(json!({"error": "plan has no steps"}));
    }

    if req.step_index >= req.plan.steps.len() {
        logx(&trace, "next_step:plan_complete", json!({}));
        return Json(json!({
            "txs": [],
            "done": true,
            "next_step_index": req.step_index,
            "description": "plan complete — all steps executed"
        }));
    }

    // ---- Build forward body (strip api_key) ----
    let forward_body = NextStepReqForward {
        plan: req.plan,
        step_index: req.step_index,
        wallet_update: req.wallet_update,
        slippage: req.slippage,
    };

    logx(
        &trace,
        "next_step:forward",
        json!({ "step_index": forward_body.step_index }),
    );

    // ---- Forward to executor ----
    let resp = match state
        .http_client
        .post(format!("{}/next_step", EXECUTOR_BASE))
        .json(&forward_body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            logx(
                &trace,
                "next_step:forward_error",
                json!({ "error": format!("{:?}", e) }),
            );
            return Json(json!({
                "error": "executor_unreachable",
                "details": format!("{:?}", e)
            }));
        }
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or("NO_BODY".into());

    logx(
        &trace,
        "next_step:forward_response",
        json!({ "status": status.as_u16(), "body_len": text.len() }),
    );

    let json_resp: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            return Json(json!({
                "error": "invalid_executor_response",
                "raw": text
            }));
        }
    };

    if !status.is_success() {
        return Json(json!({
            "error": "executor_error",
            "status": status.as_u16(),
            "upstream": json_resp
        }));
    }

    logx(
        &trace,
        "next_step:success",
        json!({
            "done": json_resp["done"],
            "next_step_index": json_resp["next_step_index"],
            "tx_count": json_resp["txs"].as_array().map(|a| a.len()).unwrap_or(0),
            "phase": json_resp["phase"],
        }),
    );

    Json(json_resp)
}

/* =============== EXECUTE OPTIMIZED (NEW — full plan execution) =============== */

/// Forwards the entire plan to the executor's /execute_optimized endpoint.
/// The executor runs all steps through interpret_step_no_swap (no per-step swaps).
/// Pre-swaps (if any) are handled by server.js before calling this.
async fn execute_optimized(
    State(state): State<AppState>,
    Json(req): Json<ExecuteOptimizedReqGateway>,
) -> Json<Value> {
    let trace = trace_id();

    logx(
        &trace,
        "execute_optimized:start",
        json!({
            "plan_steps": req.plan.steps.len(),
        }),
    );

    // ---- Auth ----
    let agent = {
        let db = state.db.read().await;
        db.agents
            .values()
            .find(|a| a.api_key == req.api_key)
            .cloned()
    };

    let agent = match agent {
        Some(a) => {
            logx(
                &trace,
                "execute_optimized:auth_ok",
                json!({ "wallet": a.wallet }),
            );
            a
        }
        None => {
            logx(&trace, "execute_optimized:auth_fail", json!({}));
            return Json(json!({"error": "invalid_api_key"}));
        }
    };

    // ---- Wallet ownership check ----
    let wallet_pubkey = req.wallet_update["wallet_pubkey"].as_str();

    if wallet_pubkey != Some(agent.wallet.as_str()) {
        logx(&trace, "execute_optimized:wallet_mismatch", json!({}));
        return Json(json!({"error": "wallet_mismatch"}));
    }

    if req.plan.steps.is_empty() {
        logx(&trace, "execute_optimized:empty_plan", json!({}));
        return Json(json!({"error": "plan has no steps"}));
    }

    // ---- Build forward body (strip api_key) ----
    let forward_body = ExecuteOptimizedReqForward {
        plan: req.plan,
        wallet_update: req.wallet_update,
        slippage: req.slippage,
    };

    logx(
        &trace,
        "execute_optimized:forward",
        json!({ "plan_steps": forward_body.plan.steps.len() }),
    );

    // ---- Forward to executor ----
    let resp = match state
        .http_client
        .post(format!("{}/execute_optimized", EXECUTOR_BASE))
        .json(&forward_body)
        .timeout(std::time::Duration::from_secs(120))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            logx(
                &trace,
                "execute_optimized:forward_error",
                json!({ "error": format!("{:?}", e) }),
            );
            return Json(json!({
                "error": "executor_unreachable",
                "details": format!("{:?}", e)
            }));
        }
    };

    let status = resp.status();
    let text = resp.text().await.unwrap_or("NO_BODY".into());

    logx(
        &trace,
        "execute_optimized:forward_response",
        json!({ "status": status.as_u16(), "body_len": text.len() }),
    );

    let json_resp: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => {
            return Json(json!({
                "error": "invalid_executor_response",
                "raw": text
            }));
        }
    };

    if !status.is_success() {
        return Json(json!({
            "error": "executor_error",
            "status": status.as_u16(),
            "upstream": json_resp
        }));
    }

    logx(
        &trace,
        "execute_optimized:success",
        json!({ "result_count": json_resp.as_array().map(|a| a.len()).unwrap_or(0) }),
    );

    Json(json_resp)
}

/* =============== WEBSOCKET =============== */

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> impl axum::response::IntoResponse {
    let trace = trace_id();

    logx(&trace, "ws:upgrade", json!({ "api_key": q.api_key }));

    ws.on_upgrade(move |socket| handle_socket(socket, q.api_key, state, trace))
}

async fn handle_socket(mut socket: WebSocket, api_key: String, state: AppState, trace: String) {
    logx(&trace, "ws:connected", json!({}));

    let agent = {
        let db = state.db.read().await;
        db.agents.values().find(|a| a.api_key == api_key).cloned()
    };

    let agent = match agent {
        Some(a) => {
            logx(
                &trace,
                "ws:auth_ok",
                json!({ "wallet": a.wallet, "pairs": a.token_pairs }),
            );
            a
        }
        None => {
            logx(&trace, "ws:auth_fail", json!({}));
            return;
        }
    };

    let mut rx = state.upstream_tx.subscribe();

    loop {
        tokio::select! {
            upstream = rx.recv() => {
                let msg = match upstream {
                    Ok(v) => v,
                    Err(e) => {
                        logx(&trace, "ws:upstream_error", json!({ "err": format!("{:?}", e) }));
                        return;
                    }
                };

                let msg_wallet = msg["wallet_pubkey"].as_str();

                if msg_wallet != Some(agent.wallet.as_str()) {
                    continue;
                }

                if let Some(pools) = msg["matched_pools"].as_array() {
                    let mut allowed = false;

                    for p in pools {
                        if let (Some(a), Some(b)) = (
                            p["mintA"]["address"].as_str(),
                            p["mintB"]["address"].as_str(),
                        ) {
                            let pair = TokenPair {
                                mint_a: a.to_string(),
                                mint_b: b.to_string(),
                            };

                            if agent.token_pairs.contains(&pair) {
                                allowed = true;
                                break;
                            }
                        }
                    }

                    if !allowed {
                        continue;
                    }
                }

                if socket.send(Message::Text(msg.to_string())).await.is_err() {
                    logx(&trace, "ws:send_failed", json!({}));
                    return;
                }
            }

            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Close(_))) => {
                        logx(&trace, "ws:closed_by_client", json!({}));
                        return;
                    }
                    Some(Err(e)) => {
                        logx(&trace, "ws:error", json!({ "err": format!("{:?}", e) }));
                        return;
                    }
                    None => {
                        logx(&trace, "ws:client_disconnected", json!({}));
                        return;
                    }
                    _ => {}
                }
            }
        }
    }
}

/* =============== UPSTREAM LISTENER =============== */

async fn run_upstream_listener(tx: broadcast::Sender<Value>) {
    let trace = trace_id();
    let url = format!("ws://{}/ws", "localhost:8080");

    loop {
        logx(&trace, "upstream:connecting", json!({ "url": url }));

        match tokio_tungstenite::connect_async(&url).await {
            Ok((ws, _)) => {
                logx(&trace, "upstream:connected", json!({}));

                let (_, mut read) = ws.split();

                while let Some(msg) = read.next().await {
                    match msg {
                        Ok(msg) => {
                            if let Ok(text) = msg.to_text() {
                                match serde_json::from_str::<Value>(text) {
                                    Ok(val) => {
                                        let _ = tx.send(val.clone());
                                    }
                                    Err(e) => {
                                        logx(
                                            &trace,
                                            "upstream:parse_error",
                                            json!({ "err": format!("{:?}", e) }),
                                        );
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            logx(
                                &trace,
                                "upstream:read_error",
                                json!({ "err": format!("{:?}", e) }),
                            );
                            break;
                        }
                    }
                }

                logx(&trace, "upstream:disconnected", json!({}));
            }
            Err(e) => {
                logx(
                    &trace,
                    "upstream:connect_fail",
                    json!({ "err": format!("{:?}", e) }),
                );

                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
        }
    }
}

/* =============== UTILS =============== */

fn save_db(db: &Database) {
    if let Ok(json) = serde_json::to_string_pretty(db) {
        let _ = fs::write(DB_FILE, json);
    }
}

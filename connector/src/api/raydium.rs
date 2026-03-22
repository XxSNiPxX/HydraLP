use anyhow::Result;
use dashmap::DashMap;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;
use tokio::time::sleep;
use tracing::{debug, error, info};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumMint {
    pub address: String,
    pub symbol: Option<String>,
    pub decimals: Option<u8>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumConfig {
    #[serde(rename = "tickSpacing")]
    pub tick_spacing: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaydiumPoolResponseItem {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "mintA")]
    pub mint_a: Option<RaydiumMint>,
    #[serde(rename = "mintB")]
    pub mint_b: Option<RaydiumMint>,
    pub price: Option<f64>,
    pub tvl: Option<f64>,
    pub config: Option<RaydiumConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RaydiumPoolTop {
    data: Vec<RaydiumPoolResponseItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FullPoolState {
    pub id: String,
    pub pool_account: serde_json::Value,
    pub vault_a_amount_raw: Option<serde_json::Value>,
    pub vault_b_amount_raw: Option<serde_json::Value>,
    pub mint_a: Option<String>,
    pub mint_b: Option<String>,
    pub mint_a_decimals: Option<u8>,
    pub mint_b_decimals: Option<u8>,
    pub vault_a_pubkey: Option<String>,
    pub vault_b_pubkey: Option<String>,
    pub program_used: Option<String>,
    pub fee_growth_global_0_x64: Option<String>,
    pub fee_growth_global_1_x64: Option<String>,
    pub protocol_fees_token_0: Option<String>,
    pub protocol_fees_token_1: Option<String>,
    pub sqrt_price_x64: Option<String>,
    pub current_tick: Option<i64>,
    pub liquidity: Option<String>,
    pub tick_arrays: Option<Vec<serde_json::Value>>,
    pub tick_spacing: Option<u16>,
    pub price: Option<f64>,
    pub tvl: Option<f64>,
    pub config: Option<serde_json::Value>,
    pub observation_key: Option<String>,
    pub amm_config: Option<serde_json::Value>,
    pub tickarray_bitmap_extension: Option<serde_json::Value>,
    pub fetched_slot: Option<u64>,
    pub ok: bool,
}

// pub async fn fetch_and_cache_raydium_pools(
//     client: &Client,
//     pools: &Vec<PoolFileEntry>,
//     pool_meta: Arc<RwLock<DashMap<String, RaydiumPoolResponseItem>>>,
// ) -> Result<()> {
//     let chunk_size = 20usize;
//     info!("raydium: fetching metadata for {} pools", pools.len());
//     for chunk in pools.chunks(chunk_size) {
//         let ids = chunk
//             .iter()
//             .map(|p| p.pool_id.clone())
//             .collect::<Vec<_>>()
//             .join(",");
//         let url = format!("https://api-v3.raydium.io/pools/info/ids?ids={}", ids);
//         debug!("raydium url={}", url);

//         let resp = match client.get(&url).send().await {
//             Ok(r) => r,
//             Err(e) => {
//                 error!("raydium: network error when fetching chunk: {:?}", e);
//                 continue;
//             }
//         };

//         let status = resp.status();
//         if !status.is_success() {
//             let body = resp.text().await.unwrap_or_default();
//             error!("raydium: non-success status {} body: {}", status, body);
//             continue;
//         }

//         let top: RaydiumPoolTop = match resp.json().await {
//             Ok(t) => t,
//             Err(e) => {
//                 error!("raydium: json parse error: {:?}", e);
//                 continue;
//             }
//         };

//         for item in top.data.into_iter() {
//             pool_meta
//                 .write()
//                 .await
//                 .insert(item.id.clone(), item.clone());
//         }
//         info!("raydium: cached {} pools (chunk)", chunk.len());
//         sleep(Duration::from_millis(150)).await;
//     }
//     Ok(())
// }

// pub async fn fetch_full_pool_state(
//     client: &Client,
//     pool_id: &str,
// ) -> Result<Option<FullPoolState>> {
//     debug!("fetch_full_pool_state: stub for pool {}", pool_id);

//     if let Ok(endpoint) = std::env::var("CLMM_HTTP_HOOK") {
//         let body = serde_json::json!({ "pool_id": pool_id });

//         let resp = match client.post(&endpoint).json(&body).send().await {
//             Ok(r) => r,
//             Err(e) => {
//                 error!("CLMM_HTTP_HOOK network error: {:?}", e);
//                 return Ok(None);
//             }
//         };

//         let status = resp.status();

//         if !status.is_success() {
//             let txt = resp.text().await.unwrap_or_default();
//             error!("CLMM_HTTP_HOOK non-success: {} body: {}", status, txt);
//             return Ok(None);
//         }

//         match resp.json::<FullPoolState>().await {
//             Ok(full) => return Ok(Some(full)),
//             Err(e) => {
//                 error!("CLMM_HTTP_HOOK parse error: {:?}", e);
//                 return Ok(None);
//             }
//         }
//     }

//     Ok(None)
// }

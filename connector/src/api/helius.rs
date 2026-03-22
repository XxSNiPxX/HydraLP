use anyhow::{Context, Result};
use base64::decode as base64_decode;
use reqwest::{Client, Response};
use serde_json::{json, Value};
use solana_program::pubkey::Pubkey;
use solana_sdk::account::Account as SolanaAccount;
use std::str::FromStr;
use std::time::Duration;
use tokio::time;
use tracing::{debug, error, info, warn};

const HELIUS_RPC_FALLBACK: &str =
    "https://mainnet.helius-rpc.com/?api-key=80733d65-cc4a-45bd-986b-010b03859cc6";

use std::collections::HashMap;

const HELIUS_RPC: &str =
    "https://mainnet.helius-rpc.com/?api-key=80733d65-cc4a-45bd-986b-010b03859cc6";

pub async fn fetch_wallet_balances_batch(
    client: &Client,
    wallets: &[String],
) -> Result<HashMap<String, HashMap<String, Value>>> {
    let mut result = HashMap::new();

    for wallet in wallets {
        let body = json!({
            "jsonrpc":"2.0",
            "id":"1",
            "method":"getTokenAccounts",
            "params":{"owner":wallet}
        });

        let resp: Value = client
            .post(HELIUS_RPC)
            .json(&body)
            .send()
            .await?
            .json()
            .await?;

        let mut tokens = HashMap::new();

        if let Some(arr) = resp["result"]["token_accounts"].as_array() {
            for acc in arr {
                if let Some(mint) = acc.get("mint").and_then(|m| m.as_str()) {
                    tokens.insert(mint.to_string(), acc.clone());
                }
            }
        }

        result.insert(wallet.clone(), tokens);
    }

    Ok(result)
}
pub async fn fetch_wallet_balances(
    client: &Client,
    pubkey: &str,
    helius_rpc_url: Option<&str>,
) -> Result<Value> {
    let rpc_accounts = match call_get_token_accounts_rpc(client, pubkey, helius_rpc_url).await {
        Ok(v) => v,
        Err(e) => {
            warn!("helius rpc fetch failed for {}: {:?}", pubkey, e);
            return Ok(json!({
                "rpc_token_accounts": [],
                "tokens": []
            }));
        }
    };

    let mut normalized_tokens: Vec<Value> = Vec::with_capacity(rpc_accounts.len());
    for acc in rpc_accounts.iter() {
        let mint_opt = acc
            .get("mint")
            .and_then(|m| m.as_str())
            .map(|s| s.to_string());
        let amount_opt = acc.get("amount").or_else(|| acc.get("amount_raw")).cloned();
        let addr_opt = acc
            .get("address")
            .and_then(|a| a.as_str())
            .map(|s| s.to_string());

        if let Some(mint) = mint_opt {
            let mut obj = serde_json::Map::new();
            obj.insert("mint".to_string(), Value::String(mint));
            if let Some(a) = amount_opt.clone() {
                obj.insert("amount_raw".to_string(), a);
            }
            if let Some(addr) = addr_opt {
                obj.insert("tokenAccount".to_string(), Value::String(addr));
            }
            obj.insert(
                "source".to_string(),
                Value::String("rpc:getTokenAccounts".to_string()),
            );
            normalized_tokens.push(Value::Object(obj));
        } else {
            // preserve raw
            let mut raw_obj = serde_json::Map::new();
            raw_obj.insert("raw".to_string(), acc.clone());
            raw_obj.insert(
                "source".to_string(),
                Value::String("rpc:getTokenAccounts:raw".to_string()),
            );
            normalized_tokens.push(Value::Object(raw_obj));
        }
    }

    info!(
        "helius rpc: returning {} normalized tokens for {}",
        normalized_tokens.len(),
        pubkey
    );

    Ok(json!({
        "rpc_token_accounts": rpc_accounts,
        "tokens": normalized_tokens
    }))
}

pub async fn get_multiple_accounts_via_helius(
    client: &Client,
    api_key: &str,
    addrs: &[String],
) -> Result<Vec<Option<SolanaAccount>>> {
    let body = json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"getMultipleAccounts",
        "params":[addrs,{"commitment":"confirmed","encoding":"base64"}]
    });

    let res: Response = client
        .post(HELIUS_RPC_FALLBACK)
        .header("x-api-key", api_key)
        .json(&body)
        .send()
        .await
        .context("helius get_multiple_accounts post failed")?;

    let status = res.status();
    let text = res.text().await.context("reading helius response")?;

    if !status.is_success() {
        anyhow::bail!("Helius returned status {}: {}", status, text);
    }

    let v: Value = serde_json::from_str(&text)?;
    let values = v["result"]["value"].as_array().cloned().unwrap_or_default();

    let mut out = Vec::with_capacity(addrs.len());

    for val in values {
        if val.is_null() {
            out.push(None);
            continue;
        }

        let data_base64 = val["data"][0].as_str().unwrap_or("");
        let decoded = base64_decode(data_base64).unwrap_or_default();

        let lamports = val["lamports"].as_u64().unwrap_or_default();
        let owner = Pubkey::from_str(val["owner"].as_str().unwrap_or_default()).unwrap_or_default();
        let executable = val["executable"].as_bool().unwrap_or(false);
        let rent_epoch = val["rentEpoch"].as_u64().unwrap_or_default();

        out.push(Some(SolanaAccount {
            lamports,
            data: decoded,
            owner,
            executable,
            rent_epoch,
        }));
    }

    Ok(out)
}

pub async fn get_account_via_helius(
    client: &Client,
    api_key: &str,
    account: &str,
) -> Result<Option<(SolanaAccount, u64)>> {
    let body = json!({
        "jsonrpc":"2.0",
        "id":1,
        "method":"getAccountInfo",
        "params":[account,{"commitment":"confirmed","encoding":"base64"}]
    });

    let res: Response = client
        .post(HELIUS_RPC_FALLBACK)
        .header("x-api-key", api_key)
        .json(&body)
        .send()
        .await
        .context("helius post failed")?;

    let status = res.status();
    let text = res.text().await.context("reading helius response")?;

    if !status.is_success() {
        anyhow::bail!("Helius returned status {}: {}", status, text);
    }

    let v: Value = serde_json::from_str(&text)?;

    let value = &v["result"]["value"];

    if value.is_null() {
        return Ok(None);
    }

    let slot = v["result"]["context"]["slot"].as_u64().unwrap_or_default();

    let data_base64 = value["data"][0].as_str().unwrap_or("");
    let decoded = base64_decode(data_base64)?;

    let lamports = value["lamports"].as_u64().unwrap_or_default();
    let owner = Pubkey::from_str(value["owner"].as_str().unwrap_or_default())?;

    let executable = value["executable"].as_bool().unwrap_or(false);
    let rent_epoch = value["rentEpoch"].as_u64().unwrap_or_default();

    Ok(Some((
        SolanaAccount {
            lamports,
            data: decoded,
            owner,
            executable,
            rent_epoch,
        },
        slot,
    )))
}

pub async fn call_get_token_accounts_rpc(
    client: &Client,
    pubkey: &str,
    helius_rpc_url: Option<&str>,
) -> Result<Vec<Value>> {
    let url = helius_rpc_url.unwrap_or(HELIUS_RPC_FALLBACK);

    let body = json!({
        "jsonrpc":"2.0",
        "id":"1",
        "method":"getTokenAccounts",
        "params":{"owner":pubkey}
    });

    let timeout = Duration::from_secs(5);

    let resp: Response = match time::timeout(timeout, client.post(url).json(&body).send()).await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => return Err(anyhow::anyhow!("helius rpc timeout")),
    };

    let status = resp.status();
    let txt = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow::anyhow!("helius rpc non-success"));
    }

    let parsed: Value = serde_json::from_str(&txt)?;

    if let Some(arr) = parsed["result"]["token_accounts"].as_array() {
        return Ok(arr.clone());
    }

    if let Some(arr) = parsed["token_accounts"].as_array() {
        return Ok(arr.clone());
    }

    Ok(Vec::new())
}

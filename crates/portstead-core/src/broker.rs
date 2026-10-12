use crate::{engine::Engine, store::Store};
use anyhow::{ensure, Context, Result};
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{io::Write, sync::Arc};
use tokio_util::sync::CancellationToken;

#[derive(Clone)]
struct BridgeState {
    engine: Arc<Engine>,
    token: String,
    cancel: CancellationToken,
}
#[derive(Deserialize, Serialize)]
pub struct Request {
    pub method: String,
    #[serde(default)]
    pub arguments: Value,
}
#[derive(Serialize, Deserialize)]
struct Runtime {
    port: u16,
    pid: u32,
    generation: uuid::Uuid,
}

async fn dispatch(
    State(state): State<BridgeState>,
    headers: HeaderMap,
    Json(request): Json<Request>,
) -> (StatusCode, Json<Value>) {
    let expected = format!("Bearer {}", state.token);
    if state.cancel.is_cancelled()
        || headers.contains_key("origin")
        || headers.get("authorization").and_then(|h| h.to_str().ok()) != Some(expected.as_str())
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Local agent authentication failed"})),
        );
    }
    match state.engine.agent_call(&request.method, request.arguments) {
        Ok(value) => (StatusCode::OK, Json(json!({"result":value}))),
        Err(error) => (
            StatusCode::BAD_REQUEST,
            Json(json!({"error":format!("{error:#}")})),
        ),
    }
}

pub async fn start(engine: Arc<Engine>) -> Result<u16> {
    if let Some((port, _, _)) = &*engine.bridge.lock().unwrap() {
        return Ok(*port);
    }
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
    let mut bridge = engine.bridge.lock().unwrap();
    if let Some((port, _, _)) = &*bridge {
        return Ok(*port);
    }
    let port = listener.local_addr()?.port();
    let pid = std::process::id();
    let generation = uuid::Uuid::new_v4();
    let credential_key = format!("agent-bridge-{pid}-{generation}");
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    std::fs::create_dir_all(&engine.store.directory)?;
    let mut file = tempfile::NamedTempFile::new_in(&engine.store.directory)?;
    file.write_all(&serde_json::to_vec(&Runtime {
        port,
        pid,
        generation,
    })?)?;
    let credential = keyring::Entry::new("connmanager-agent", &credential_key)?;
    credential
        .set_password(&token)
        .context("Unlock the OS credential store to enable local agents")?;
    if let Err(error) = file.persist(engine.store.directory.join("agent-runtime.json")) {
        let _ = credential.delete_credential();
        return Err(error.into());
    }
    let cancel = CancellationToken::new();
    *bridge = Some((port, cancel.clone(), credential_key.clone()));
    drop(bridge);
    let app = Router::new()
        .route("/agent", post(dispatch))
        .layer(DefaultBodyLimit::max(65536))
        .with_state(BridgeState {
            engine,
            token,
            cancel: cancel.clone(),
        });
    tokio::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(cancel.cancelled_owned())
            .await;
        let _ = keyring::Entry::new("connmanager-agent", &credential_key)
            .and_then(|entry| entry.delete_credential());
    });
    Ok(port)
}

#[derive(Clone)]
pub struct Client {
    url: String,
    token: String,
    client: reqwest::Client,
}
impl Client {
    pub fn new(store: &Store) -> Result<Self> {
        let path = store.directory.join("agent-runtime.json");
        let metadata: Runtime = serde_json::from_slice(
            &std::fs::read(path)
                .context("Open Portstead and enable Agents before connecting an MCP client")?,
        )?;
        ensure!(metadata.port != 0, "Invalid local agent endpoint");
        let token = keyring::Entry::new(
            "connmanager-agent",
            &format!("agent-bridge-{}-{}", metadata.pid, metadata.generation),
        )?
        .get_password()
        .context("Local agent session has ended; enable Agents in the app")?;
        Ok(Self {
            url: format!("http://127.0.0.1:{}/agent", metadata.port),
            token,
            client: reqwest::Client::builder()
                .no_proxy()
                .timeout(std::time::Duration::from_secs(15))
                .build()?,
        })
    }
    pub async fn call(&self, method: &str, arguments: Value) -> Result<Value> {
        let value: Value = self
            .client
            .post(&self.url)
            .bearer_auth(&self.token)
            .json(&Request {
                method: method.into(),
                arguments,
            })
            .send()
            .await
            .context("App's local agent server is unavailable")?
            .json()
            .await?;
        if let Some(error) = value["error"].as_str() {
            anyhow::bail!("{error}");
        }
        Ok(value["result"].clone())
    }
}

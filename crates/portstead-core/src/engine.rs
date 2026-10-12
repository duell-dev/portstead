use crate::{credentials::Credentials, operations::Operations, session::Sessions, store::Store};
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

pub struct Engine {
    pub store: Store,
    pub sessions: Sessions,
    pub operations: Operations,
    pub bridge: Mutex<Option<(u16, CancellationToken, String)>>,
}

impl Engine {
    pub fn new(store: Store) -> Arc<Self> {
        Arc::new(Self {
            sessions: Sessions::new(store.clone()),
            operations: Operations::new(store.clone()),
            store,
            bridge: Mutex::new(None),
        })
    }
    pub fn shutdown(&self) {
        self.sessions.close_all();
        for op in self.operations.list() {
            let _ = self.operations.cancel(&op.id);
        }
        self.stop_agents();
    }
    pub fn stop_agents(&self) {
        if let Some((_, cancel, key)) = self.bridge.lock().unwrap().take() {
            cancel.cancel();
            let _ = keyring::Entry::new("connmanager-agent", &key)
                .and_then(|entry| entry.delete_credential());
        }
        for op in self.operations.list() {
            if op.actor == "agent" {
                let _ = self.operations.cancel(&op.id);
            }
        }
    }
    pub fn agent_call(&self, method: &str, arguments: Value) -> Result<Value> {
        let library = self.store.load()?;
        let allowed = |id: &str| -> Result<_> {
            let c = library.connection(id)?;
            ensure!(
                c.agent_access,
                "Agent access is disabled for this connection"
            );
            Ok(c.clone())
        };
        match method {
            "connections_list" => Ok(
                json!({"library_revision":library.revision,"connections":library.connections.iter().filter(|c| c.agent_access).collect::<Vec<_>>()}),
            ),
            "workspaces_list" => Ok(json!(library
                .workspaces
                .iter()
                .filter(|w| w.panes.iter().all(|p| allowed(&p.connection_id).is_ok()))
                .collect::<Vec<_>>())),
            "command_run" => {
                ensure!(
                    arguments["library_revision"].as_u64() == Some(library.revision),
                    "Profile library changed; call connections_list and verify the target again"
                );
                let id = arguments["connection_id"]
                    .as_str()
                    .context("connection_id is required")?;
                let command = arguments["command"]
                    .as_str()
                    .context("command is required")?;
                let timeout = arguments["timeout_seconds"].as_u64().unwrap_or(60);
                let operation_id = self.operations.start(
                    allowed(id)?,
                    command.into(),
                    timeout,
                    Credentials::default(),
                    true,
                )?;
                Ok(json!({"operation_id": operation_id}))
            }
            "operation_read" | "operation_cancel" => {
                let id = arguments["operation_id"]
                    .as_str()
                    .context("operation_id is required")?;
                let op = self.operations.read(id)?;
                allowed(&op.connection_id)?;
                ensure!(
                    op.actor == "agent",
                    "This operation belongs to the desktop user"
                );
                if method == "operation_cancel" {
                    self.operations.cancel(id)?;
                }
                Ok(json!(self.operations.read(id)?))
            }
            "operations_list" => Ok(json!(self
                .operations
                .list()
                .into_iter()
                .filter(|o| o.actor == "agent" && allowed(&o.connection_id).is_ok())
                .collect::<Vec<_>>())),
            _ => anyhow::bail!("Unknown agent operation"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn agent_catalog_and_execution_honor_saved_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine::new(Store {
            directory: dir.path().into(),
        });
        assert_eq!(
            engine.agent_call("connections_list", json!({})).unwrap()["connections"],
            json!([])
        );
        assert!(engine
            .agent_call(
                "command_run",
                json!({"connection_id":"local","command":"echo denied"})
            )
            .is_err());
        let mut library = engine.store.load().unwrap();
        library.connections[0].agent_access = true;
        engine.store.save(library).unwrap();
        let catalog = engine.agent_call("connections_list", json!({})).unwrap();
        assert_eq!(catalog["connections"].as_array().unwrap().len(), 1);
        assert!(engine
            .agent_call(
                "command_run",
                json!({"connection_id":"local","command":"echo stale","library_revision":0})
            )
            .is_err());
        let op = engine.agent_call("command_run", json!({"connection_id":"local","command":"echo engine-check","library_revision":catalog["library_revision"]})).unwrap();
        let id = op["operation_id"].as_str().unwrap();
        let mut library = engine.store.load().unwrap();
        library.connections[0].agent_access = false;
        engine.store.save(library).unwrap();
        assert!(engine
            .agent_call("operation_read", json!({"operation_id":id}))
            .is_err());
        engine.shutdown();
    }
}

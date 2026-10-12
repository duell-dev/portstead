use crate::{
    credentials::Credentials,
    kubernetes,
    model::{Connection, Target},
    powershell,
    session::shell_program,
    store::Store,
};
use anyhow::{ensure, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Serialize)]
pub struct Operation {
    pub id: String,
    pub connection_id: String,
    pub command: String,
    pub status: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub truncated: bool,
    pub actor: String,
    pub started_at: u64,
    pub connection_name: String,
    pub target: Target,
}

struct Running {
    result: Arc<Mutex<Operation>>,
    cancel: CancellationToken,
}
pub struct Operations {
    items: Mutex<HashMap<String, Running>>,
    store: Store,
}

impl Operations {
    pub fn new(store: Store) -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
            store,
        }
    }
    pub fn start(
        &self,
        connection: Connection,
        command: String,
        timeout: u64,
        credentials: Credentials,
        agent: bool,
    ) -> Result<String> {
        connection.require_local_bindings()?;
        ensure!(
            !agent || connection.agent_access,
            "Agent command execution is disabled for this connection"
        );
        ensure!(
            !command.is_empty() && command.len() <= 8192 && !command.contains('\0'),
            "Invalid command"
        );
        ensure!(
            (1..=300).contains(&timeout),
            "Timeout must be between 1 and 300 seconds"
        );
        ensure!(
            !matches!(connection.target, Target::Rdp { .. }),
            "Use SSH or WinRM for commands; RDP provides desktop access"
        );
        let mut items = self.items.lock().unwrap();
        // Keep completed results bounded while preserving every running operation.
        if items.len() >= 100 {
            items.retain(|_, op| op.result.lock().unwrap().status == "running");
        }
        ensure!(items.len() < 100, "Too many running operations");
        let id = uuid::Uuid::new_v4().to_string();
        let result = Arc::new(Mutex::new(Operation {
            id: id.clone(),
            connection_id: connection.id.clone(),
            command: command.clone(),
            status: "running".into(),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            truncated: false,
            actor: if agent { "agent" } else { "you" }.into(),
            started_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_millis() as u64,
            connection_name: connection.name.clone(),
            target: connection.target.clone(),
        }));
        let cancel = CancellationToken::new();
        items.insert(
            id.clone(),
            Running {
                result: result.clone(),
                cancel: cancel.clone(),
            },
        );
        drop(items);
        let directory = self.store.directory.join("sessions");
        tokio::spawn(async move {
            let execution = execute(&connection, &command, &credentials, &directory, &cancel);
            let finished = tokio::time::timeout(Duration::from_secs(timeout), execution).await;
            let mut op = result.lock().unwrap();
            match finished {
                Ok(Ok((stdout, stderr, code, truncated))) => {
                    op.stdout = stdout;
                    op.stderr = stderr;
                    op.exit_code = code;
                    op.truncated = truncated;
                    op.status = if code == Some(0) {
                        "completed"
                    } else {
                        "failed"
                    }
                    .into();
                }
                Ok(Err(error)) => {
                    op.stderr = format!("{error:#}");
                    op.status = if cancel.is_cancelled() {
                        "cancelled"
                    } else {
                        "failed"
                    }
                    .into();
                }
                Err(_) => {
                    cancel.cancel();
                    op.status = "timed_out".into();
                    op.stderr = "Timed out. The remote outcome may be unknown; the command was not retried.".into();
                }
            }
        });
        Ok(id)
    }
    pub fn read(&self, id: &str) -> Result<Operation> {
        self.items
            .lock()
            .unwrap()
            .get(id)
            .map(|op| op.result.lock().unwrap().clone())
            .ok_or_else(|| anyhow::anyhow!("Operation is no longer retained"))
    }
    pub fn list(&self) -> Vec<Operation> {
        let mut items: Vec<_> = self
            .items
            .lock()
            .unwrap()
            .values()
            .map(|op| {
                let mut result = op.result.lock().unwrap().clone();
                for output in [&mut result.stdout, &mut result.stderr] {
                    if output.len() > 4096 {
                        let mut end = 4096;
                        while !output.is_char_boundary(end) {
                            end -= 1;
                        }
                        output.truncate(end);
                        result.truncated = true;
                    }
                }
                result
            })
            .collect();
        items.sort_by_key(|op| op.started_at);
        items
    }
    pub fn cancel(&self, id: &str) -> Result<()> {
        let items = self.items.lock().unwrap();
        let op = items
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Operation not found"))?;
        op.cancel.cancel();
        Ok(())
    }
}

impl Drop for Operations {
    fn drop(&mut self) {
        for op in self.items.get_mut().unwrap().values() {
            op.cancel.cancel();
        }
    }
}

async fn capture(mut pipe: impl AsyncRead + Unpin) -> Result<(String, bool)> {
    let mut result = Vec::new();
    let mut chunk = [0; 8192];
    let mut truncated = false;
    loop {
        let n = pipe.read(&mut chunk).await?;
        if n == 0 {
            break;
        }
        let remaining = (1024 * 1024usize).saturating_sub(result.len());
        result.extend_from_slice(&chunk[..n.min(remaining)]);
        truncated |= n > remaining;
    }
    Ok((String::from_utf8_lossy(&result).into(), truncated))
}

async fn execute(
    connection: &Connection,
    script: &str,
    credentials: &Credentials,
    directory: &Path,
    cancel: &CancellationToken,
) -> Result<(String, String, Option<i32>, bool)> {
    if matches!(connection.target, Target::Winrm { .. }) {
        let host = Arc::new(psrp_rs::BufferedHost::new());
        let client = powershell::client(connection, credentials)?;
        let mut pool = powershell::connect(&client, connection, host.clone()).await?;
        // shortcut: the SDK buffers PSRP streams; move to a bounded streaming API before allowing large WinRM output.
        let result = psrp_rs::Pipeline::new(script)
            .add_command(psrp_rs::Command::new("Out-String").with_switch("Stream"))
            .run_all_streams_with_cancel(&mut pool, cancel.clone())
            .await?;
        pool.close().await?;
        let mut stdout = result
            .output
            .iter()
            .map(powershell::value_text)
            .collect::<Vec<_>>()
            .join("\n");
        stdout.push_str(&host.lines().join("\n"));
        let mut stderr = result
            .errors
            .iter()
            .map(powershell::value_text)
            .collect::<Vec<_>>()
            .join("\n");
        stderr.push_str(&host.errors().join("\n"));
        let code = if result.errors.is_empty() && result.state == psrp_rs::PipelineState::Completed
        {
            0
        } else {
            1
        };
        let truncated = stdout.len() > 1024 * 1024 || stderr.len() > 1024 * 1024;
        while stdout.len() > 1024 * 1024 {
            stdout.pop();
        }
        while stderr.len() > 1024 * 1024 {
            stderr.pop();
        }
        return Ok((stdout, stderr, Some(code), truncated));
    }
    let mut config = None;
    let mut command = match &connection.target {
        Target::Ssh {
            host,
            username,
            port,
            identity_file,
        } => {
            let mut c = Command::new("ssh");
            c.args(["-o", "BatchMode=yes", "-p", &port.to_string()]);
            if !username.is_empty() {
                c.args(["-l", username]);
            }
            if let Some(key) = identity_file {
                if !key.is_empty() {
                    c.args(["-i", key]);
                }
            }
            c.arg(host).arg(script);
            c
        }
        Target::Local { shell } => local_command(shell_program(shell), script),
        Target::Kubernetes {
            source,
            context,
            namespace,
        } => {
            let snapshot = kubernetes::snapshot(Path::new(source), context, namespace, directory)?;
            let mut c = local_command(shell_program(&None), script);
            c.env("KUBECONFIG", snapshot.path());
            config = Some(snapshot);
            c
        }
        _ => anyhow::bail!("This connection cannot execute commands"),
    };
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let output = async {
        let (status, out, err) = tokio::try_join!(
            async { child.wait().await.map_err(anyhow::Error::from) },
            capture(stdout),
            capture(stderr)
        )?;
        Ok::<_, anyhow::Error>((out.0, err.0, status.code(), out.1 || err.1))
    };
    let result = tokio::select! { result = output => result, _ = cancel.cancelled() => Err(anyhow::anyhow!("Cancelled. Confirm the remote outcome before repeating the command.")) };
    drop(config);
    result
}

fn local_command(shell: String, script: &str) -> Command {
    let mut command = Command::new(&shell);
    if cfg!(windows) {
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ]);
    } else {
        command.args(["-lc", script]);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancels_a_running_local_command_and_bounds_output() {
        let dir = tempfile::tempdir().unwrap();
        let operations = Operations::new(Store {
            directory: dir.path().into(),
        });
        let connection = crate::model::Library::initial().connections.remove(0);
        let script = if cfg!(windows) {
            "Start-Sleep -Seconds 30"
        } else {
            "sleep 30"
        };
        let id = operations
            .start(connection, script.into(), 60, Credentials::default(), false)
            .unwrap();
        operations.cancel(&id).unwrap();
        for _ in 0..50 {
            if operations.read(&id).unwrap().status == "cancelled" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(operations.read(&id).unwrap().status, "cancelled");
        let (mut writer, reader) = tokio::io::duplex(65536);
        let (_, captured) = tokio::join!(
            async {
                use tokio::io::AsyncWriteExt;
                writer
                    .write_all(&vec![b'x'; 1024 * 1024 + 7])
                    .await
                    .unwrap();
                writer.shutdown().await.unwrap();
            },
            capture(reader)
        );
        let (text, truncated) = captured.unwrap();
        assert_eq!(text.len(), 1024 * 1024);
        assert!(truncated);
        operations
            .items
            .lock()
            .unwrap()
            .get(&id)
            .unwrap()
            .result
            .lock()
            .unwrap()
            .stdout = "é".repeat(5000);
        let preview = operations.list().remove(0);
        assert!(preview.truncated);
        assert_eq!(preview.stdout.len(), 4096);
        assert_eq!(operations.read(&id).unwrap().stdout.len(), 10000);
    }
    #[tokio::test]
    async fn enforces_agent_access_and_executes_real_local_command() {
        let dir = tempfile::tempdir().unwrap();
        let operations = Operations::new(Store {
            directory: dir.path().into(),
        });
        let mut connection = crate::model::Library::initial().connections.remove(0);
        assert!(operations
            .start(
                connection.clone(),
                "echo denied".into(),
                10,
                Credentials::default(),
                true
            )
            .is_err());
        connection.agent_access = true;
        let id = operations
            .start(
                connection,
                "echo portstead-operation-check".into(),
                10,
                Credentials::default(),
                true,
            )
            .unwrap();
        for _ in 0..100 {
            let op = operations.read(&id).unwrap();
            if op.status != "running" {
                assert_eq!(op.exit_code, Some(0));
                assert!(op.stdout.contains("portstead-operation-check"));
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("Operation did not finish");
    }
}

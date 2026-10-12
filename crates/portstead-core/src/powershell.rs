use crate::{
    credentials::{self, Credentials},
    model::{Connection, Target},
    session::{Input, Prompt, SharedBuffer},
};
use anyhow::{Context, Result};
use psrp_rs::{
    AuthMethod, Command, Pipeline, PsHost, PsValue, RunspacePool, WinrmClient, WinrmConfig,
    WinrmCredentials, WinrmPsrpTransport,
};
use std::sync::{Arc, Mutex};
use tokio::sync::{mpsc, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

pub type Pool<'a> = RunspacePool<WinrmPsrpTransport<'a>>;

pub fn client(connection: &Connection, credentials: &Credentials) -> Result<WinrmClient> {
    let Target::Winrm {
        username,
        domain,
        port,
        tls,
        auth,
        ..
    } = &connection.target
    else {
        anyhow::bail!("Not a WinRM connection")
    };
    let username = if credentials.username.is_empty() {
        username
    } else {
        &credentials.username
    };
    let domain = if credentials.domain.is_empty() {
        domain
    } else {
        &credentials.domain
    };
    let password = if auth == "kerberos" && credentials.password.is_empty() {
        String::new()
    } else {
        credentials::password(connection, credentials)?
    };
    let (username, domain) = credentials::identity(username, domain)?;
    Ok(WinrmClient::new(
        WinrmConfig {
            port: *port,
            use_tls: *tls,
            auth_method: if auth == "kerberos" {
                AuthMethod::Kerberos
            } else {
                AuthMethod::Ntlm
            },
            accept_invalid_certs: false,
            ..Default::default()
        },
        WinrmCredentials::new(&username, &password, &domain),
    )?)
}

pub async fn connect<'a>(
    client: &'a WinrmClient,
    connection: &Connection,
    host: Arc<dyn PsHost>,
) -> Result<Pool<'a>> {
    let Target::Winrm { host: server, .. } = &connection.target else {
        anyhow::bail!("Not a WinRM connection")
    };
    let (id, fragments) = Pool::build_creation_fragments(1, 1)?;
    let transport = WinrmPsrpTransport::open(client, server, &fragments)
        .await
        .context("WinRM connection or authentication failed")?;
    Pool::open_from_transport_with_host(transport, id, 1, 1, host)
        .await
        .context("PowerShell runspace could not open")
}

struct TerminalHost {
    output: SharedBuffer,
    input: Arc<AsyncMutex<mpsc::Receiver<String>>>,
    stop: CancellationToken,
    cancel: Arc<Mutex<CancellationToken>>,
}

#[async_trait::async_trait]
impl PsHost for TerminalHost {
    async fn write_line(&self, text: &str) {
        self.output
            .lock()
            .unwrap()
            .push(format!("{text}\r\n").as_bytes());
    }
    async fn write(&self, text: &str) {
        self.output.lock().unwrap().push(text.as_bytes());
    }
    async fn write_error_line(&self, text: &str) {
        self.write_line(text).await;
    }
    async fn write_warning_line(&self, text: &str) {
        self.write_line(text).await;
    }
    async fn write_verbose_line(&self, text: &str) {
        self.write_line(text).await;
    }
    async fn read_line(&self) -> psrp_rs::Result<String> {
        self.read_prompt("PowerShell input", false).await
    }
    async fn read_line_as_secure_string(&self) -> psrp_rs::Result<String> {
        self.read_prompt("Secure PowerShell input", true).await
    }
    async fn prompt_for_choice(
        &self,
        caption: &str,
        message: &str,
        choices: &[(String, String)],
        default: i32,
    ) -> psrp_rs::Result<i32> {
        let labels: Vec<_> = choices
            .iter()
            .enumerate()
            .map(|(i, (label, _))| format!("{i}: {label}"))
            .collect();
        let answer = self
            .read_prompt(
                &format!(
                    "{caption}\n{message}\n{} (default {default})",
                    labels.join(" · ")
                ),
                false,
            )
            .await?;
        let index = if answer.trim().is_empty() {
            default
        } else {
            answer
                .trim()
                .parse()
                .map_err(|_| psrp_rs::PsrpError::Protocol("Enter a choice number".into()))?
        };
        if index < 0 || index as usize >= choices.len() {
            return Err(psrp_rs::PsrpError::Protocol(
                "Choice is out of range".into(),
            ));
        }
        Ok(index)
    }
}

impl TerminalHost {
    async fn read_prompt(&self, label: &str, secret: bool) -> psrp_rs::Result<String> {
        self.output.lock().unwrap().prompt = Some(Prompt {
            label: label.into(),
            secret,
        });
        let cancel = self.cancel.lock().unwrap().clone();
        let result = tokio::select! {
            _ = self.stop.cancelled() => Err(psrp_rs::PsrpError::Protocol("Session closed".into())),
            _ = cancel.cancelled() => Err(psrp_rs::PsrpError::Protocol("Command interrupted".into())),
            answer = async { self.input.lock().await.recv().await } => answer.ok_or_else(|| psrp_rs::PsrpError::Protocol("Input closed".into())),
        };
        self.output.lock().unwrap().prompt = None;
        result
    }
}

pub fn value_text(value: &PsValue) -> String {
    match value {
        PsValue::String(text) => text.clone(),
        PsValue::Null => String::new(),
        PsValue::SecureString(_) => "[secure value]".into(),
        _ => format!("{value:?}"),
    }
}

pub fn open(
    connection: &Connection,
    credentials: Credentials,
    entry: String,
    output: SharedBuffer,
    stop: CancellationToken,
) -> Result<Input> {
    let (sender, receiver) = mpsc::channel(32);
    let receiver = Arc::new(AsyncMutex::new(receiver));
    let cancel = Arc::new(Mutex::new(CancellationToken::new()));
    let connection = connection.clone();
    let operation_cancel = cancel.clone();
    std::thread::spawn(move || {
        let run = async {
            let host = Arc::new(TerminalHost {
                output: output.clone(),
                input: receiver.clone(),
                stop: stop.clone(),
                cancel: operation_cancel.clone(),
            });
            let client = client(&connection, &credentials)?;
            let mut pool = tokio::select! { pool = connect(&client, &connection, host) => pool?, _ = stop.cancelled() => return Ok(()) };
            output.lock().unwrap().status = "running".into();
            let mut entry = if entry.is_empty() { None } else { Some(entry) };
            loop {
                output.lock().unwrap().push(b"\r\nPS> ");
                let command = if let Some(entry) = entry.take() {
                    entry
                } else {
                    tokio::select! {
                        _ = stop.cancelled() => break,
                        command = async { receiver.lock().await.recv().await } => match command { Some(c) => c, None => break },
                    }
                };
                let token = CancellationToken::new();
                *operation_cancel.lock().unwrap() = token.clone();
                let result = tokio::select! {
                    // shortcut: the SDK collects pipeline streams; add bounded streaming before supporting noisy WinRM jobs.
                    result = Pipeline::new(command).add_command(Command::new("Out-String").with_switch("Stream")).run_all_streams_with_cancel(&mut pool, token.clone()) => result,
                    _ = stop.cancelled() => { token.cancel(); break; }
                };
                match result {
                    Ok(streams) => {
                        let mut b = output.lock().unwrap();
                        for value in streams.output {
                            b.push(format!("{}\r\n", value_text(&value)).as_bytes());
                        }
                        for value in streams.errors {
                            b.push(format!("Error: {}\r\n", value_text(&value)).as_bytes());
                        }
                    }
                    Err(e) => output.lock().unwrap().push(format!("{e}\r\n").as_bytes()),
                }
            }
            pool.close().await?;
            Ok::<(), anyhow::Error>(())
        };
        match tokio::runtime::Runtime::new()
            .and_then(|rt| rt.block_on(run).map_err(std::io::Error::other))
        {
            Ok(_) => output.lock().unwrap().status = "exited".into(),
            Err(e) => output.lock().unwrap().fail(&e.into()),
        }
    });
    Ok(Input::Powershell { sender, cancel })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_unblocks_a_secure_host_prompt() {
        let (_sender, receiver) = mpsc::channel(1);
        let cancel = CancellationToken::new();
        let output = Arc::new(Mutex::new(crate::session::Buffer::new()));
        let host = TerminalHost {
            output: output.clone(),
            input: Arc::new(AsyncMutex::new(receiver)),
            stop: CancellationToken::new(),
            cancel: Arc::new(Mutex::new(cancel.clone())),
        };
        let answer = tokio::spawn(async move { host.read_line_as_secure_string().await });
        tokio::task::yield_now().await;
        assert!(output.lock().unwrap().prompt.as_ref().unwrap().secret);
        cancel.cancel();
        assert!(
            tokio::time::timeout(std::time::Duration::from_secs(1), answer)
                .await
                .unwrap()
                .unwrap()
                .is_err()
        );
        assert!(output.lock().unwrap().prompt.is_none());
    }
}

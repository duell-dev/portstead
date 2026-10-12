use crate::{
    credentials::Credentials,
    kubernetes,
    model::{Connection, Target},
    store::Store,
};
use anyhow::{ensure, Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
};
use tokio_util::sync::CancellationToken;

const OUTPUT_LIMIT: usize = 1024 * 1024;

#[derive(Serialize, Clone)]
pub struct Update {
    pub data: Vec<u8>,
    pub status: String,
    pub error: Option<String>,
    pub dropped_bytes: usize,
    pub prompt: Option<Prompt>,
}

#[derive(Serialize, Clone)]
pub struct Prompt {
    pub label: String,
    pub secret: bool,
}

pub struct Buffer {
    bytes: VecDeque<u8>,
    pub status: String,
    pub error: Option<String>,
    dropped: usize,
    pub prompt: Option<Prompt>,
}

impl Buffer {
    pub fn new() -> Self {
        Self {
            bytes: VecDeque::new(),
            status: "starting".into(),
            error: None,
            dropped: 0,
            prompt: None,
        }
    }
    pub fn push(&mut self, bytes: &[u8]) {
        let overflow = (self.bytes.len() + bytes.len()).saturating_sub(OUTPUT_LIMIT);
        let old = overflow.min(self.bytes.len());
        self.bytes.drain(..old);
        self.dropped += overflow;
        self.bytes.extend(bytes.iter().skip(overflow - old));
    }
    pub fn fail(&mut self, error: &anyhow::Error) {
        self.status = "failed".into();
        self.error = Some(format!("{error:#}"));
    }
    fn drain(&mut self) -> Update {
        Update {
            data: self.bytes.drain(..).collect(),
            status: self.status.clone(),
            error: self.error.clone(),
            dropped_bytes: std::mem::take(&mut self.dropped),
            prompt: self.prompt.clone(),
        }
    }
}

pub type SharedBuffer = Arc<Mutex<Buffer>>;

impl Default for Buffer {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Pty {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    _config: Option<tempfile::NamedTempFile>,
}

pub enum Input {
    Pty(Mutex<Pty>),
    Powershell {
        sender: tokio::sync::mpsc::Sender<String>,
        cancel: Arc<Mutex<CancellationToken>>,
    },
    Rdp(std::sync::mpsc::SyncSender<crate::rdp::RdpInput>),
}

pub struct Session {
    pub buffer: SharedBuffer,
    pub input: Input,
    pub stop: CancellationToken,
    pub frame: Arc<Mutex<Option<crate::rdp::Frame>>>,
}

pub struct Sessions {
    items: Mutex<HashMap<String, Arc<Session>>>,
    pub store: Store,
}

#[derive(Deserialize)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
}

pub fn shell_program(shell: &Option<String>) -> String {
    shell.clone().unwrap_or_else(|| {
        if cfg!(windows) {
            "powershell.exe".into()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
        }
    })
}

fn pty_command(
    connection: &Connection,
    entry: &str,
    directory: &Path,
) -> Result<(CommandBuilder, Option<tempfile::NamedTempFile>)> {
    let mut snapshot = None;
    let mut command = match &connection.target {
        Target::Local { shell } => {
            let program = shell_program(shell);
            let mut c = CommandBuilder::new(&program);
            if !entry.is_empty() {
                if cfg!(windows) {
                    c.args(["-NoLogo", "-NoExit", "-Command", entry]);
                } else {
                    c.args(["-lc", &format!("{entry}\nexec \"$SHELL\" -l")]);
                }
            }
            c
        }
        Target::Ssh {
            host,
            username,
            port,
            identity_file,
        } => {
            let mut c = CommandBuilder::new("ssh");
            c.args(["-tt", "-p", &port.to_string()]);
            if !username.is_empty() {
                c.args(["-l", username]);
            }
            if let Some(path) = identity_file {
                if !path.is_empty() {
                    c.args(["-i", path]);
                }
            }
            c.arg(host);
            if !entry.is_empty() {
                c.arg(format!("{entry}\nexec \"${{SHELL:-/bin/sh}}\" -l"));
            }
            c
        }
        Target::Kubernetes {
            source,
            context,
            namespace,
        } => {
            let config = kubernetes::snapshot(Path::new(source), context, namespace, directory)?;
            let mut c = CommandBuilder::new(shell_program(&None));
            c.env("KUBECONFIG", config.path());
            if !entry.is_empty() {
                if cfg!(windows) {
                    c.args(["-NoLogo", "-NoExit", "-Command", entry]);
                } else {
                    c.args(["-lc", &format!("{entry}\nexec \"$SHELL\" -l")]);
                }
            }
            snapshot = Some(config);
            c
        }
        _ => anyhow::bail!("This connection does not use a pseudoterminal"),
    };
    command.env("TERM", "xterm-256color");
    Ok((command, snapshot))
}

impl Sessions {
    pub fn new(store: Store) -> Self {
        Self {
            items: Mutex::new(HashMap::new()),
            store,
        }
    }

    pub fn open(
        &self,
        connection: Connection,
        entry: String,
        credentials: Credentials,
        size: Size,
    ) -> Result<String> {
        connection.require_local_bindings()?;
        ensure!(
            entry.len() <= 8192 && !entry.contains('\0'),
            "Invalid entry command"
        );
        ensure!(
            (1..=500).contains(&size.cols) && (1..=200).contains(&size.rows),
            "Invalid terminal size"
        );
        ensure!(
            self.items.lock().unwrap().len() < 40,
            "Close a session before opening more"
        );
        let buffer = Arc::new(Mutex::new(Buffer::new()));
        let frame = Arc::new(Mutex::new(None));
        let stop = CancellationToken::new();
        let input = match connection.target {
            Target::Winrm { .. } => crate::powershell::open(
                &connection,
                credentials,
                entry,
                buffer.clone(),
                stop.clone(),
            )?,
            Target::Rdp { .. } => {
                ensure!(entry.is_empty(), "RDP does not accept entry commands");
                crate::rdp::open(
                    &connection,
                    credentials,
                    buffer.clone(),
                    frame.clone(),
                    stop.clone(),
                )?
            }
            _ => {
                let (command, config) =
                    pty_command(&connection, &entry, &self.store.directory.join("sessions"))?;
                let pair = portable_pty::native_pty_system().openpty(PtySize {
                    rows: size.rows,
                    cols: size.cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })?;
                let child =
                    Arc::new(Mutex::new(pair.slave.spawn_command(command).context(
                        "Cannot launch shell; check that its executable is installed",
                    )?));
                drop(pair.slave);
                let mut reader = pair.master.try_clone_reader()?;
                let writer = pair.master.take_writer()?;
                buffer.lock().unwrap().status = "running".into();
                let output = buffer.clone();
                thread::spawn(move || {
                    let mut bytes = [0; 8192];
                    loop {
                        match reader.read(&mut bytes) {
                            Ok(0) => break,
                            Ok(n) => output.lock().unwrap().push(&bytes[..n]),
                            Err(_) => break,
                        }
                    }
                    let mut b = output.lock().unwrap();
                    if b.status != "failed" {
                        b.status = "exited".into();
                    }
                });
                Input::Pty(Mutex::new(Pty {
                    master: pair.master,
                    writer,
                    child,
                    _config: config,
                }))
            }
        };
        let id = uuid::Uuid::new_v4().to_string();
        self.items.lock().unwrap().insert(
            id.clone(),
            Arc::new(Session {
                buffer,
                input,
                stop,
                frame,
            }),
        );
        Ok(id)
    }

    pub fn get(&self, id: &str) -> Result<Arc<Session>> {
        self.items
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("Session has ended")
    }
    pub fn poll(&self, id: &str) -> Result<Update> {
        Ok(self.get(id)?.buffer.lock().unwrap().drain())
    }
    pub fn write(&self, id: &str, data: Vec<u8>) -> Result<()> {
        ensure!(data.len() <= 65536, "Input chunk exceeds 64 KiB");
        let session = self.get(id)?;
        match &session.input {
            Input::Pty(pty) => {
                let mut pty = pty.lock().unwrap();
                pty.writer.write_all(&data)?;
                pty.writer.flush()?;
            }
            Input::Powershell { sender, cancel } => {
                if data == [3] {
                    cancel.lock().unwrap().cancel();
                } else {
                    sender
                        .try_send(
                            String::from_utf8(data).context("PowerShell input must be UTF-8")?,
                        )
                        .context("PowerShell input queue is full")?;
                }
            }
            Input::Rdp(_) => anyhow::bail!("Use remote desktop input for this session"),
        }
        Ok(())
    }
    pub fn resize(&self, id: &str, size: Size) -> Result<()> {
        ensure!(
            (1..=500).contains(&size.cols) && (1..=200).contains(&size.rows),
            "Invalid terminal size"
        );
        if let Input::Pty(pty) = &self.get(id)?.input {
            pty.lock().unwrap().master.resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        }
        Ok(())
    }
    pub fn close(&self, id: &str) -> Result<()> {
        if let Some(session) = self.items.lock().unwrap().remove(id) {
            session.stop.cancel();
            match &session.input {
                Input::Pty(pty) => {
                    pty.lock().unwrap().child.lock().unwrap().kill()?;
                }
                Input::Powershell { cancel, .. } => cancel.lock().unwrap().cancel(),
                Input::Rdp(_) => {}
            }
        }
        Ok(())
    }
    pub fn close_all(&self) {
        let ids: Vec<_> = self.items.lock().unwrap().keys().cloned().collect();
        for id in ids {
            let _ = self.close(&id);
        }
    }
}

impl Drop for Sessions {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_is_bounded_and_reports_loss() {
        let mut b = Buffer::new();
        b.push(&vec![b'x'; OUTPUT_LIMIT + 11]);
        let update = b.drain();
        assert_eq!(update.data.len(), OUTPUT_LIMIT);
        assert_eq!(update.dropped_bytes, 11);
        assert_eq!(b.drain().dropped_bytes, 0);
    }
    #[test]
    fn real_local_pty_accepts_input_and_closes() {
        let dir = tempfile::tempdir().unwrap();
        let sessions = Sessions::new(Store {
            directory: dir.path().into(),
        });
        let id = sessions
            .open(
                crate::model::Library::initial().connections.remove(0),
                String::new(),
                Credentials::default(),
                Size { cols: 80, rows: 24 },
            )
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut output = String::new();
        let mut sent = false;
        while std::time::Instant::now() < deadline {
            let update = String::from_utf8_lossy(&sessions.poll(&id).unwrap().data).into_owned();
            if update.contains("\u{1b}[6n") {
                sessions.write(&id, b"\x1b[1;1R".to_vec()).unwrap();
            }
            output.push_str(&update);
            if !sent && (output.contains("PS ") || !cfg!(windows)) {
                let command = if cfg!(windows) {
                    "Write-Output ('portstead-pty-' + (19 + 23))\r"
                } else {
                    "echo portstead-pty-$((19 + 23))\r"
                };
                sessions.write(&id, command.as_bytes().to_vec()).unwrap();
                sent = true;
            }
            if output.contains("portstead-pty-42") {
                break;
            }
            thread::sleep(std::time::Duration::from_millis(50));
        }
        sessions.close(&id).unwrap();
        assert!(output.contains("portstead-pty-42"), "{output}");
        assert!(sessions.get(&id).is_err());
    }
}

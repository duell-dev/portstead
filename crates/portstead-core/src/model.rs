use anyhow::{bail, ensure, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Library {
    pub version: u32,
    #[serde(default)]
    pub revision: u64,
    pub connections: Vec<Connection>,
    pub workspaces: Vec<Workspace>,
    #[serde(default)]
    pub groups: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default)]
    pub agent_access: bool,
    pub target: Target,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "protocol", rename_all = "snake_case", deny_unknown_fields)]
pub enum Target {
    Local {
        #[serde(default)]
        shell: Option<String>,
    },
    Ssh {
        host: String,
        #[serde(default)]
        username: String,
        #[serde(default = "ssh_port")]
        port: u16,
        #[serde(default)]
        identity_file: Option<String>,
    },
    Winrm {
        host: String,
        #[serde(default)]
        username: String,
        #[serde(default)]
        domain: String,
        #[serde(default = "winrm_port")]
        port: u16,
        #[serde(default = "yes")]
        tls: bool,
        #[serde(default = "ntlm")]
        auth: String,
    },
    Rdp {
        host: String,
        #[serde(default)]
        username: String,
        #[serde(default)]
        domain: String,
        #[serde(default = "rdp_port")]
        port: u16,
        #[serde(default)]
        certificate_sha256: Option<String>,
    },
    Kubernetes {
        source: String,
        context: String,
        #[serde(default)]
        namespace: String,
    },
    Web {
        url: String,
    },
}

fn ssh_port() -> u16 {
    22
}
fn winrm_port() -> u16 {
    5986
}
fn rdp_port() -> u16 {
    3389
}
fn yes() -> bool {
    true
}
fn ntlm() -> String {
    "ntlm".into()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub panes: Vec<Pane>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Pane {
    pub connection_id: String,
    pub title: String,
    #[serde(default)]
    pub entry_command: String,
}

pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with('-')
        && !host.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_group(path: &str) -> bool {
    path.len() <= 2048
        && !path.chars().any(char::is_control)
        && (path.is_empty()
            || (path.split('/').count() <= 16
                && path
                    .split('/')
                    .all(|part| !part.trim().is_empty() && part.trim().len() <= 200)))
}

pub fn management_url(value: &str) -> Result<reqwest::Url> {
    ensure!(
        value.len() <= 2048 && !value.chars().any(char::is_control),
        "Invalid management URL"
    );
    let url = reqwest::Url::parse(value)?;
    ensure!(
        matches!(url.scheme(), "http" | "https") && url.host_str().is_some(),
        "Management pages need an HTTP or HTTPS URL"
    );
    ensure!(
        url.username().is_empty() && url.password().is_none(),
        "Enter credentials on the management page, not in its saved URL"
    );
    Ok(url)
}

impl Connection {
    pub fn require_local_bindings(&self) -> Result<()> {
        let path = match &self.target {
            Target::Local { shell } => shell.as_deref(),
            Target::Ssh { identity_file, .. } => identity_file.as_deref(),
            Target::Kubernetes { source, .. } => Some(source.as_str()),
            _ => None,
        };
        ensure!(!path.is_some_and(|p| p.starts_with("local://")), "Choose the matching local file or shell in this connection's settings on this device before connecting");
        Ok(())
    }
}

impl Library {
    pub fn initial() -> Self {
        Self {
            version: 1,
            revision: 0,
            groups: Vec::new(),
            connections: vec![Connection {
                id: "local".into(),
                name: "Local shell".into(),
                group: "This device".into(),
                agent_access: false,
                target: Target::Local { shell: None },
            }],
            workspaces: vec![Workspace {
                id: "local-workspace".into(),
                name: "Local workspace".into(),
                group: "This device".into(),
                panes: vec![Pane {
                    connection_id: "local".into(),
                    title: "Shell".into(),
                    entry_command: String::new(),
                }],
            }],
        }
    }

    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.version == 1,
            "Unsupported profile version {}",
            self.version
        );
        ensure!(
            self.connections.len() <= 1000
                && self.workspaces.len() <= 200
                && self.groups.len() <= 1000,
            "Profile library is too large"
        );
        let mut groups = HashSet::new();
        for path in &self.groups {
            ensure!(
                !path.is_empty() && valid_group(path),
                "Invalid folder path (maximum 16 levels)"
            );
            let key = path.split('/').map(str::trim).collect::<Vec<_>>().join("/");
            ensure!(groups.insert(key), "Duplicate folder path");
        }
        let mut ids = HashSet::new();
        for c in &self.connections {
            ensure!(
                valid_id(&c.id) && ids.insert(&c.id),
                "Invalid or duplicate connection ID"
            );
            ensure!(
                !c.name.trim().is_empty() && c.name.len() <= 200,
                "Connection name is required (maximum 200 characters)"
            );
            ensure!(valid_group(&c.group), "Invalid connection folder path");
            match &c.target {
                Target::Local { shell } => {
                    if let Some(s) = shell {
                        ensure!(
                            !s.trim().is_empty() && !s.contains('\0'),
                            "Invalid shell executable"
                        );
                    }
                }
                Target::Ssh {
                    host,
                    port,
                    username,
                    identity_file,
                } => {
                    ensure!(valid_host(host) && *port > 0, "Invalid SSH host or port");
                    ensure!(
                        !username.contains(['\0', '\n', '\r']),
                        "Invalid SSH username"
                    );
                    if let Some(path) = identity_file {
                        ensure!(!path.contains('\0'), "Invalid identity path");
                    }
                }
                Target::Rdp {
                    host,
                    port,
                    certificate_sha256,
                    ..
                } => {
                    ensure!(valid_host(host) && *port > 0, "Invalid host or port");
                    if let Some(pin) = certificate_sha256 {
                        ensure!(
                            pin.len() == 64 && pin.bytes().all(|b| b.is_ascii_hexdigit()),
                            "Certificate fingerprint must be 64 hexadecimal characters"
                        );
                    }
                }
                Target::Winrm {
                    host, port, auth, ..
                } => {
                    ensure!(valid_host(host) && *port > 0, "Invalid host or port");
                    ensure!(
                        auth == "ntlm" || auth == "kerberos",
                        "Unsupported WinRM authentication method"
                    );
                }
                Target::Kubernetes {
                    source,
                    context,
                    namespace,
                } => {
                    ensure!(
                        !source.is_empty() && !context.is_empty() && !source.contains('\0'),
                        "Kubeconfig source and context are required"
                    );
                    ensure!(
                        !namespace.contains(['\0', '\n', '\r']),
                        "Invalid Kubernetes namespace"
                    );
                }
                Target::Web { url } => {
                    management_url(url)?;
                    ensure!(
                        !c.agent_access,
                        "Management pages do not support agent shell commands"
                    );
                }
            }
        }
        let mut workspace_ids = HashSet::new();
        for w in &self.workspaces {
            ensure!(
                valid_id(&w.id) && workspace_ids.insert(&w.id),
                "Invalid or duplicate workspace ID"
            );
            ensure!(
                !w.name.trim().is_empty() && w.name.len() <= 200,
                "Workspace name is required"
            );
            ensure!(valid_group(&w.group), "Invalid workspace folder path");
            // shortcut: layouts support up to four panes; add a split tree when larger layouts are needed.
            ensure!(
                (1..=4).contains(&w.panes.len()),
                "A workspace needs one to four panes"
            );
            for p in &w.panes {
                ensure!(
                    ids.contains(&p.connection_id),
                    "Workspace references an unknown connection: {}",
                    p.connection_id
                );
                ensure!(
                    p.entry_command.len() <= 8192 && !p.entry_command.contains('\0'),
                    "Entry command is too long or contains a null byte"
                );
                if matches!(
                    self.connection(&p.connection_id)?.target,
                    Target::Rdp { .. } | Target::Web { .. }
                ) && !p.entry_command.is_empty()
                {
                    bail!("RDP and management pages do not accept shell entry commands");
                }
            }
        }
        Ok(())
    }

    pub fn connection(&self, id: &str) -> Result<&Connection> {
        self.connections
            .iter()
            .find(|c| c.id == id)
            .ok_or_else(|| anyhow::anyhow!("Connection not found"))
    }

    pub fn checked_connection(&self, id: &str, expected: &Target) -> Result<&Connection> {
        let connection = self.connection(id)?;
        ensure!(
            &connection.target == expected,
            "Connection changed. Close this pane and reopen it before executing on the new target."
        );
        Ok(connection)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_profiles_load_and_nested_empty_folders_round_trip() {
        let mut json = serde_json::to_value(Library::initial()).unwrap();
        json.as_object_mut().unwrap().remove("groups");
        json["workspaces"][0]
            .as_object_mut()
            .unwrap()
            .remove("group");
        let mut library: Library = serde_json::from_value(json).unwrap();
        assert!(library.groups.is_empty());
        assert!(library.workspaces[0].group.is_empty());
        library
            .groups
            .push("Company / Budapest / Production".into());
        library.connections[0].group = library.groups[0].clone();
        library.validate().unwrap();
        let saved: Library =
            serde_json::from_str(&serde_json::to_string(&library).unwrap()).unwrap();
        assert_eq!(saved.groups, library.groups);
        library.groups.push("Company/Budapest/Production".into());
        assert!(library.validate().is_err());
        library.groups = vec!["Company / / Production".into()];
        assert!(library.validate().is_err());
    }

    #[test]
    fn management_pages_reject_credentials_scripts_and_shell_commands() {
        for url in [
            "http://192.0.2.1",
            "https://moxa.example.invalid:8443/settings",
        ] {
            management_url(url).unwrap();
        }
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost",
            "https://admin:secret@example.invalid",
            "https://admin@example.invalid",
            "https://example.invalid\n/path",
        ] {
            assert!(management_url(url).is_err(), "{url}");
        }
        let mut library = Library::initial();
        library.connections[0].target = Target::Web {
            url: "http://192.0.2.1".into(),
        };
        library.validate().unwrap();
        library.connections[0].agent_access = true;
        assert!(library.validate().is_err());
        library.connections[0].agent_access = false;
        library.workspaces[0].panes[0].entry_command = "echo forbidden".into();
        assert!(library.validate().is_err());
    }
    #[test]
    fn validates_targets_and_references() {
        let mut library = Library::initial();
        library.validate().unwrap();
        library.workspaces[0].panes[0].connection_id = "missing".into();
        assert!(library.validate().is_err());
        assert!(!valid_host("-oProxyCommand=evil"));
        assert!(!valid_host("host\ncommand"));
        assert!(valid_host("server.internal"));
        assert!(valid_host("::1"));
    }
    #[test]
    fn rejects_secrets_and_unknown_versions_in_portable_profiles() {
        let mut json = serde_json::to_value(Library::initial()).unwrap();
        json["connections"][0]["password"] = "not-permitted".into();
        assert!(serde_json::from_value::<Library>(json).is_err());
        let mut library = Library::initial();
        library.version = 2;
        assert!(library.validate().is_err());
    }

    #[test]
    fn refuses_a_stale_target() {
        let mut library = Library::initial();
        let old = library.connections[0].target.clone();
        library.checked_connection("local", &old).unwrap();
        library.connections[0].target = Target::Local {
            shell: Some("different-shell".into()),
        };
        assert!(library.checked_connection("local", &old).is_err());
    }

    #[test]
    fn public_example_is_valid_and_grants_no_agent_access() {
        let library: Library =
            serde_json::from_str(include_str!("../../../examples/workspaces.json")).unwrap();
        library.validate().unwrap();
        assert!(library
            .connections
            .iter()
            .all(|connection| !connection.agent_access));
    }
}

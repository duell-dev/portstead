use crate::model::{Connection, Target};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use serde_yaml_ng::Value;
use std::{fs, io::Write, path::Path};

#[derive(Serialize)]
pub struct KubeImport {
    pub connections: Vec<Connection>,
    pub warnings: Vec<String>,
}

fn read(path: &Path) -> Result<Value> {
    ensure!(
        fs::metadata(path)?.len() <= 4 * 1024 * 1024,
        "Kubeconfig exceeds 4 MiB"
    );
    serde_yaml_ng::from_slice(&fs::read(path)?).context("Cannot parse kubeconfig")
}

pub fn inspect(path: &Path) -> Result<KubeImport> {
    let absolute = fs::canonicalize(path).context("Cannot find kubeconfig source")?;
    let config = read(&absolute)?;
    let contexts = config["contexts"]
        .as_sequence()
        .context("Kubeconfig has no contexts")?;
    let connections = contexts
        .iter()
        .map(|c| -> Result<_> {
            let name = c["name"].as_str().context("Context has no name")?;
            Ok(Connection {
                id: uuid::Uuid::new_v4().to_string(),
                name: name.into(),
                group: "Kubernetes".into(),
                agent_access: false,
                target: Target::Kubernetes {
                    source: absolute.to_string_lossy().into(),
                    context: name.into(),
                    namespace: c["context"]["namespace"]
                        .as_str()
                        .unwrap_or("default")
                        .into(),
                },
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let mut warnings = Vec::new();
    if let Some(users) = config["users"].as_sequence() {
        for u in users {
            if let Some(command) = u["user"]["exec"]["command"].as_str() {
                warnings.push(format!("Authentication runs {command}. Review this source and ensure the tool is available before connecting."));
            }
        }
    }
    Ok(KubeImport {
        connections,
        warnings,
    })
}

pub fn snapshot(
    source: &Path,
    context: &str,
    namespace: &str,
    directory: &Path,
) -> Result<tempfile::NamedTempFile> {
    let source = fs::canonicalize(source)?;
    let parent = source.parent().context("Kubeconfig has no parent")?;
    let mut config = read(&source)?;
    let contexts = config["contexts"]
        .as_sequence_mut()
        .context("Kubeconfig has no contexts")?;
    let selected = contexts
        .iter_mut()
        .find(|c| c["name"].as_str() == Some(context))
        .context("Context no longer exists in this source")?;
    if !namespace.is_empty() {
        selected["context"]["namespace"] = Value::String(namespace.into());
    }
    config["current-context"] = Value::String(context.into());
    for (collection, object, fields) in [
        ("clusters", "cluster", vec!["certificate-authority"]),
        ("users", "user", vec!["client-certificate", "client-key"]),
    ] {
        if let Some(entries) = config[collection].as_sequence_mut() {
            for entry in entries {
                for field in &fields {
                    if let Some(path) = entry[object][*field].as_str() {
                        if Path::new(path).is_relative() {
                            entry[object][*field] =
                                Value::String(parent.join(path).to_string_lossy().into());
                        }
                    }
                }
                if object == "user" {
                    if let Some(command) = entry[object]["exec"]["command"].as_str() {
                        if Path::new(command).is_relative()
                            && (command.contains('/') || command.contains('\\'))
                        {
                            entry[object]["exec"]["command"] =
                                Value::String(parent.join(command).to_string_lossy().into());
                        }
                    }
                }
            }
        }
    }
    fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(serde_yaml_ng::to_string(&config)?.as_bytes())?;
    Ok(file)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn isolates_contexts_preserves_paths_and_never_changes_source() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("config");
        let original = "current-context: staging\nclusters:\n- name: cluster\n  cluster:\n    certificate-authority: ca.pem\nusers:\n- name: user\n  user:\n    exec:\n      command: ./login\ncontexts:\n- name: production\n  context:\n    namespace: old\n- name: staging\n  context: {}\n";
        fs::write(&source, original).unwrap();
        let imported = inspect(&source).unwrap();
        assert_eq!(imported.connections.len(), 2);
        assert_eq!(imported.warnings.len(), 1);
        let first = snapshot(&source, "production", "payments", dir.path()).unwrap();
        let second = snapshot(&source, "staging", "testing", dir.path()).unwrap();
        let a = read(first.path()).unwrap();
        let b = read(second.path()).unwrap();
        assert_eq!(a["current-context"].as_str(), Some("production"));
        assert_eq!(b["current-context"].as_str(), Some("staging"));
        assert!(Path::new(
            a["clusters"][0]["cluster"]["certificate-authority"]
                .as_str()
                .unwrap()
        )
        .is_absolute());
        assert!(
            Path::new(a["users"][0]["user"]["exec"]["command"].as_str().unwrap()).is_absolute()
        );
        assert_eq!(fs::read_to_string(&source).unwrap(), original);
    }
}

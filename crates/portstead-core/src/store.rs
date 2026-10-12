use crate::model::{Library, Target};
use anyhow::{ensure, Context, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct Store {
    pub directory: PathBuf,
}

impl Store {
    pub fn default_location() -> Result<Self> {
        // Preserve the prototype's storage location and environment alias across the rename.
        let directory = std::env::var_os("PORTSTEAD_HOME")
            .or_else(|| std::env::var_os("CONNMANAGER_HOME"))
            .map(PathBuf::from)
            .or_else(|| dirs::config_dir().map(|d| d.join("connmanager")))
            .context("Cannot find the profile directory")?;
        Ok(Self { directory })
    }

    pub fn load(&self) -> Result<Library> {
        let path = self.directory.join("library.json");
        if !path.exists() {
            return Ok(Library::initial());
        }
        let mut library = Self::read(&path)?;
        let bindings = self.bindings()?;
        for connection in &mut library.connections {
            if let Some(path) = local_path(&mut connection.target) {
                if let Some(bound) = bindings.get(path) {
                    *path = bound.clone();
                }
            }
        }
        library.validate()?;
        Ok(library)
    }

    pub fn read(path: &Path) -> Result<Library> {
        ensure!(
            fs::metadata(path)?.len() <= 4 * 1024 * 1024,
            "Profile file exceeds 4 MiB"
        );
        let library: Library =
            serde_json::from_slice(&fs::read(path)?).context("Invalid profile file")?;
        library.validate()?;
        Ok(library)
    }

    pub fn save(&self, mut library: Library) -> Result<Library> {
        library.validate()?;
        fs::create_dir_all(&self.directory)?;
        let _lock = self.lock()?;
        ensure!(
            library.revision == self.load()?.revision,
            "Profiles changed in another window. Reload before saving."
        );
        library.revision = library
            .revision
            .checked_add(1)
            .context("Profile revision is exhausted")?;
        let portable = self.portable(library.clone())?;
        let path = self.directory.join("library.json");
        if path.exists() {
            Self::write(
                &self.directory.join("library.backup.json"),
                &Self::read(&path)?,
            )?;
        }
        Self::write(&path, &portable)?;
        self.load()
    }

    fn lock(&self) -> Result<fs::File> {
        fs::create_dir_all(&self.directory)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.directory.join("library.lock"))?;
        file.lock()?;
        Ok(file)
    }

    fn bindings(&self) -> Result<HashMap<String, String>> {
        let path = self.directory.join("bindings.json");
        if !path.exists() {
            return Ok(HashMap::new());
        }
        ensure!(
            fs::metadata(&path)?.len() <= 4 * 1024 * 1024,
            "Local bindings file exceeds 4 MiB"
        );
        let bindings: HashMap<String, String> =
            serde_json::from_slice(&fs::read(path)?).context("Invalid local bindings file")?;
        ensure!(
            bindings
                .iter()
                .all(|(key, value)| key.starts_with("local://")
                    && !value.contains('\0')
                    && !value.starts_with("local://")),
            "Invalid local file binding"
        );
        Ok(bindings)
    }

    fn portable(&self, mut library: Library) -> Result<Library> {
        let mut bindings = self.bindings()?;
        for connection in &mut library.connections {
            if let Some(path) = local_path(&mut connection.target) {
                if path.starts_with("local://") {
                    continue;
                }
                let reference = bindings
                    .iter()
                    .find(|(_, value)| *value == path)
                    .map(|(key, _)| key.clone())
                    .unwrap_or_else(|| format!("local://{}", uuid::Uuid::new_v4()));
                bindings.insert(reference.clone(), path.clone());
                *path = reference;
            }
        }
        // Old bindings remain usable by the backup library if a later save fails.
        ensure!(
            serde_json::to_vec(&bindings)?.len() <= 4 * 1024 * 1024,
            "Local bindings file exceeds 4 MiB"
        );
        write_json(&self.directory.join("bindings.json"), &bindings)?;
        Ok(library)
    }

    pub fn export(&self, path: &Path) -> Result<()> {
        let _lock = self.lock()?;
        ensure!(path.is_absolute(), "Select an absolute export path");
        let parent = path
            .parent()
            .context("Select an export directory")?
            .canonicalize()
            .context("Select an existing export directory")?;
        ensure!(
            !parent.starts_with(self.directory.canonicalize()?),
            "Export outside the app's configuration directory to preserve its managed files"
        );
        Self::write(path, &self.portable(self.load()?)?)
    }

    pub fn write(path: &Path, library: &Library) -> Result<()> {
        library.validate()?;
        write_json(path, library)
    }
}

fn local_path(target: &mut Target) -> Option<&mut String> {
    match target {
        Target::Local { shell } => shell.as_mut(),
        Target::Ssh { identity_file, .. } => identity_file.as_mut(),
        Target::Kubernetes { source, .. } => Some(source),
        _ => None,
    }
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .context("Select an absolute profile path")?;
    fs::create_dir_all(parent)?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.write_all(b"\n")?;
    file.as_file().sync_all()?;
    file.persist(path)
        .map_err(|e| e.error)
        .context("Could not replace the profile file")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saves_atomically_and_rejects_stale_edits() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store {
            directory: dir.path().into(),
        };
        let original = store.load().unwrap();
        let mut saved = store.save(original.clone()).unwrap();
        assert_eq!(saved.revision, 1);
        assert!(store.save(original).is_err());
        saved.workspaces[0].name = "New layout".into();
        store.save(saved).unwrap();
        assert_eq!(store.load().unwrap().workspaces[0].name, "New layout");
        assert_eq!(
            Store::read(&dir.path().join("library.backup.json"))
                .unwrap()
                .revision,
            1
        );
    }

    #[test]
    fn exports_portable_references_and_rebinds_on_another_machine() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let export_directory = tempfile::tempdir().unwrap();
        let source = Store {
            directory: first.path().into(),
        };
        let destination = Store {
            directory: second.path().into(),
        };
        let mut library = Library::initial();
        library.connections[0].target = Target::Kubernetes {
            source: "C:/private/kubeconfig".into(),
            context: "development".into(),
            namespace: "apps".into(),
        };
        source.save(library).unwrap();
        assert!(source.export(&first.path().join("bindings.json")).is_err());
        let exported = export_directory.path().join("export.json");
        source.export(&exported).unwrap();
        let raw = fs::read_to_string(&exported).unwrap();
        assert!(!raw.contains("C:/private"));
        assert!(raw.contains("local://"));
        let mut imported = Store::read(&exported).unwrap();
        imported.revision = 0;
        let mut imported = destination.save(imported).unwrap();
        assert!(imported.connections[0].require_local_bindings().is_err());
        if let Target::Kubernetes { source, .. } = &mut imported.connections[0].target {
            *source = "/home/user/.kube/config".into();
        }
        destination.save(imported).unwrap();
        let rebound = destination.load().unwrap();
        rebound.connections[0].require_local_bindings().unwrap();
        assert!(
            matches!(&rebound.connections[0].target, Target::Kubernetes { source, .. } if source == "/home/user/.kube/config")
        );
        assert!(
            matches!(&source.load().unwrap().connections[0].target, Target::Kubernetes { source, .. } if source == "C:/private/kubeconfig")
        );
    }
}

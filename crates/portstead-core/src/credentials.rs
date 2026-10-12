use crate::model::Connection;
use anyhow::{ensure, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Credentials {
    pub username: String,
    pub domain: String,
    pub password: String,
    pub remember: bool,
}

pub fn entry(connection: &Connection) -> Result<keyring::Entry> {
    let binding = serde_json::to_vec(&connection.target)?;
    let key = format!("{}-{:x}", connection.id, Sha256::digest(binding));
    Ok(keyring::Entry::new("connmanager", &key)?)
}

pub fn password(connection: &Connection, supplied: &Credentials) -> Result<String> {
    let entry = entry(connection).context("Credential store is unavailable")?;
    if !supplied.password.is_empty() {
        if supplied.remember {
            entry
                .set_password(&supplied.password)
                .context("Could not save credential in the operating-system store")?;
        }
        return Ok(supplied.password.clone());
    }
    entry
        .get_password()
        .context("Enter a password in the app or save this connection's credential on this device")
}

pub fn forget(connection: &Connection) -> Result<()> {
    match entry(connection)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn identity(username: &str, domain: &str) -> Result<(String, String)> {
    if let Some((prefix, name)) = username.split_once('\\') {
        ensure!(
            !prefix.is_empty() && !name.is_empty() && !name.contains('\\'),
            "Invalid domain-qualified username"
        );
        ensure!(
            domain.is_empty() || domain.eq_ignore_ascii_case(prefix),
            "The username and domain fields disagree"
        );
        Ok((name.into(), prefix.into()))
    } else {
        Ok((username.into(), domain.into()))
    }
}

fn identity_matches(saved: &str, username: &str, domain: &str) -> bool {
    if username.is_empty() {
        return domain.is_empty()
            || saved
                .split_once('\\')
                .is_some_and(|(prefix, _)| prefix.eq_ignore_ascii_case(domain))
            || saved
                .rsplit_once('@')
                .is_some_and(|(_, realm)| realm.eq_ignore_ascii_case(domain));
    }
    let expected = if domain.is_empty() || username.contains(['\\', '@']) {
        username.to_owned()
    } else {
        format!("{domain}\\{username}")
    };
    saved.eq_ignore_ascii_case(&expected)
}

pub fn saved_rdp_for(host: &str, username: &str, domain: &str) -> Option<(String, String)> {
    saved_rdp(host).filter(|(saved, _)| identity_matches(saved, username, domain))
}

#[cfg(windows)]
fn saved_rdp(host: &str) -> Option<(String, String)> {
    use windows_sys::Win32::Security::Credentials::{
        CredFree, CredReadW, CREDENTIALW, CRED_TYPE_GENERIC,
    };
    let target: Vec<u16> = format!("TERMSRV/{host}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut credential: *mut CREDENTIALW = std::ptr::null_mut();
    // Windows owns this allocation; read only the credential for the requested RDP host.
    unsafe {
        if CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut credential) == 0
            || credential.is_null()
        {
            return None;
        }
        let c = &*credential;
        let mut len = 0;
        if !c.UserName.is_null() {
            while *c.UserName.add(len) != 0 {
                len += 1;
            }
        }
        let username = if len == 0 {
            String::new()
        } else {
            String::from_utf16_lossy(std::slice::from_raw_parts(c.UserName, len))
        };
        let bytes = if c.CredentialBlob.is_null() {
            &[][..]
        } else {
            std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize)
        };
        let units: Vec<u16> = bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .collect();
        let password = String::from_utf16_lossy(&units)
            .trim_end_matches('\0')
            .to_owned();
        CredFree(credential.cast());
        if password.is_empty() {
            None
        } else {
            Some((username, password))
        }
    }
}

#[cfg(not(windows))]
fn saved_rdp(_: &str) -> Option<(String, String)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_saved_password_is_only_reused_for_the_matching_identity() {
        assert!(identity_matches("DOMAIN\\alice", "alice", "domain"));
        assert!(identity_matches("DOMAIN\\alice", "DOMAIN\\Alice", ""));
        assert!(identity_matches("DOMAIN\\alice", "", ""));
        assert!(identity_matches("DOMAIN\\alice", "", "DOMAIN"));
        assert!(!identity_matches("DOMAIN\\alice", "", "OTHER"));
        assert!(!identity_matches("DOMAIN\\alice", "bob", "DOMAIN"));
        assert!(!identity_matches("DOMAIN\\alice", "alice", "OTHER"));
        assert!(!identity_matches("DOMAIN\\alice", "alice", ""));
        assert_eq!(
            identity("DOMAIN\\alice", "domain").unwrap(),
            ("alice".into(), "DOMAIN".into())
        );
        assert!(identity("DOMAIN\\alice", "OTHER").is_err());
    }
}

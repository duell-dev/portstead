//! Bounded, read-only SNMP inventory. LLDP advertisements are observations, never scan targets.
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use snmp2::{v3, AsyncSession, Oid, Value};
use std::{
    collections::{BTreeMap, HashSet},
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{task::JoinSet, time::timeout};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

const SYSTEM: &[u64] = &[1, 3, 6, 1, 2, 1, 1];
const IF_TABLE: &[u64] = &[1, 3, 6, 1, 2, 1, 2, 2, 1];
const LLDP_LOCAL: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 3];
const LLDP_LOCAL_PORTS: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 3, 7, 1];
const LLDP_REMOTE: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 4, 1, 1];
const LLDP_ADDRESSES: &[u64] = &[1, 0, 8802, 1, 1, 2, 1, 4, 2, 1];
const MAX_TARGETS: usize = 256;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "version", rename_all = "snake_case", deny_unknown_fields)]
pub enum SnmpCredentials {
    V2c {
        community: String,
    },
    V3 {
        username: String,
        auth_protocol: String,
        auth_password: String,
        privacy_password: String,
        #[serde(default)]
        context: String,
    },
}
impl Drop for SnmpCredentials {
    fn drop(&mut self) {
        match self {
            Self::V2c { community } => community.zeroize(),
            Self::V3 {
                auth_password,
                privacy_password,
                ..
            } => {
                auth_password.zeroize();
                privacy_password.zeroize();
            }
        }
    }
}
impl SnmpCredentials {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::V2c { community } => ensure!(
                !community.is_empty() && community.len() <= 1024,
                "A community string is required (maximum 1024 bytes)"
            ),
            Self::V3 {
                username,
                auth_protocol,
                auth_password,
                privacy_password,
                context,
            } => {
                ensure!(
                    !username.is_empty() && username.len() <= 64 && context.len() <= 255,
                    "Invalid SNMPv3 username or context"
                );
                ensure!(
                    matches!(auth_protocol.as_str(), "sha1" | "sha256"),
                    "Choose SHA-1 or SHA-256 authentication"
                );
                ensure!(
                    (8..=1024).contains(&auth_password.len())
                        && (8..=1024).contains(&privacy_password.len()),
                    "SNMPv3 authentication and privacy passwords need 8–1024 bytes"
                );
            }
        }
        Ok(())
    }
}

fn profile_entry(name: &str) -> Result<keyring::Entry> {
    ensure!(
        !name.trim().is_empty() && name.len() <= 96 && !name.chars().any(char::is_control),
        "Choose a credential profile name (maximum 96 bytes)"
    );
    keyring::Entry::new("portstead-snmp", name.trim())
        .context("Cannot access the OS credential store")
}
pub fn save_credentials(name: &str, credentials: &SnmpCredentials) -> Result<()> {
    credentials.validate()?;
    let raw = zeroize::Zeroizing::new(serde_json::to_string(credentials)?);
    profile_entry(name)?
        .set_password(&raw)
        .context("Cannot save the SNMP credential profile")
}
pub fn load_credentials(name: &str) -> Result<SnmpCredentials> {
    let raw = zeroize::Zeroizing::new(
        profile_entry(name)?
            .get_password()
            .context("SNMP credential profile was not found in the OS credential store")?,
    );
    let credentials: SnmpCredentials =
        serde_json::from_str(&raw).context("Invalid saved SNMP credentials")?;
    credentials.validate()?;
    Ok(credentials)
}
pub fn forget_credentials(name: &str) -> Result<()> {
    match profile_entry(name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => bail!("Cannot forget the SNMP credential profile"),
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DeviceInterface {
    pub index: u64,
    pub name: String,
    pub admin_status: i64,
    pub oper_status: i64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LldpNeighbor {
    pub local_port: String,
    pub chassis_id: String,
    #[serde(default)]
    pub chassis_subtype: u8,
    pub remote_port: String,
    pub name: String,
    pub description: String,
    pub addresses: Vec<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: String,
    pub host: String,
    pub address: String,
    pub snmp_port: u16,
    pub sys_object_id: String,
    #[serde(default)]
    pub chassis_id: String,
    #[serde(default)]
    pub chassis_subtype: u8,
    pub description: String,
    pub location: String,
    pub contact: String,
    pub uptime_ticks: u32,
    pub observed_at: u64,
    pub interfaces: Vec<DeviceInterface>,
    pub neighbors: Vec<LldpNeighbor>,
    pub warnings: Vec<String>,
}
impl Device {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            crate::model::valid_host(&self.host)
                && self.address.parse::<IpAddr>().is_ok()
                && self.snmp_port > 0,
            "Invalid device address or SNMP port"
        );
        ensure!(
            self.interfaces.len() <= 128
                && self.neighbors.len() <= 128
                && self.warnings.len() <= 16,
            "Device inventory is too large"
        );
        let text_ok = |value: &str| value.len() <= 1024 && !value.contains('\0');
        ensure!(
            [
                &self.sys_object_id,
                &self.chassis_id,
                &self.description,
                &self.location,
                &self.contact
            ]
            .iter()
            .all(|s| text_ok(s)),
            "Device metadata is too long"
        );
        ensure!(self.chassis_subtype <= 7, "Invalid chassis ID subtype");
        ensure!(
            self.interfaces.iter().all(|i| text_ok(&i.name)),
            "Invalid interface name"
        );
        ensure!(
            self.neighbors.iter().all(|n| [
                &n.local_port,
                &n.chassis_id,
                &n.remote_port,
                &n.name,
                &n.description
            ]
            .iter()
            .all(|s| text_ok(s))
                && n.chassis_subtype <= 7
                && n.addresses.len() <= 16
                && n.addresses.iter().all(|a| a.parse::<IpAddr>().is_ok())),
            "Invalid LLDP neighbor"
        );
        ensure!(
            self.warnings.iter().all(|s| text_ok(s)),
            "Invalid inventory warning"
        );
        Ok(())
    }
}
#[derive(Serialize)]
pub struct DiscoveryFailure {
    pub host: String,
    pub error: String,
}
#[derive(Default, Serialize)]
pub struct DiscoveryResult {
    pub devices: Vec<Device>,
    pub failures: Vec<DiscoveryFailure>,
    pub cancelled: bool,
}

/// Expand only user-entered seeds. IPv4 ranges are /24 or smaller; IPv6 is single-address only.
pub fn targets(input: &[String]) -> Result<Vec<String>> {
    ensure!(
        !input.is_empty() && input.len() <= MAX_TARGETS,
        "Enter up to 256 hosts or addresses"
    );
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    for value in input {
        let value = value.trim();
        let expanded = if let Some((address, prefix)) = value.split_once('/') {
            let ip: Ipv4Addr = address
                .parse()
                .context("CIDR discovery requires an IPv4 address")?;
            let prefix: u32 = prefix.parse().context("Invalid CIDR prefix")?;
            ensure!(
                (24..=32).contains(&prefix),
                "Choose an IPv4 range from /24 to /32 (maximum 256 addresses)"
            );
            let count = 1u32 << (32 - prefix);
            let base = u32::from(ip) & (u32::MAX << (32 - prefix));
            (0..count)
                .filter(|offset| prefix >= 31 || (*offset != 0 && *offset != count - 1))
                .map(|offset| Ipv4Addr::from(base + offset).to_string())
                .collect::<Vec<_>>()
        } else {
            let value = value.trim_start_matches('[').trim_end_matches(']');
            ensure!(
                crate::model::valid_host(value) && !value.contains(['/', '@', '\\']),
                "Enter hostnames or IP addresses, without URLs or ports"
            );
            ensure!(
                !value.contains(':') || value.parse::<IpAddr>().is_ok(),
                "Enter the SNMP port separately"
            );
            vec![value.to_ascii_lowercase()]
        };
        for host in expanded {
            if seen.insert(host.clone()) {
                result.push(host);
            }
        }
        ensure!(
            result.len() <= MAX_TARGETS,
            "Discovery is limited to 256 addresses per run"
        );
    }
    ensure!(!result.is_empty(), "No target addresses");
    Ok(result)
}

pub async fn discover(
    input: Vec<String>,
    port: u16,
    credentials: SnmpCredentials,
    cancel: CancellationToken,
) -> Result<DiscoveryResult> {
    credentials.validate()?;
    ensure!(port > 0, "SNMP port is required");
    let seeds = targets(&input)?;
    let mut queue = seeds.into_iter();
    let mut running = JoinSet::new();
    let mut result = DiscoveryResult::default();
    if cancel.is_cancelled() {
        result.cancelled = true;
        return Ok(result);
    }
    let deadline = tokio::time::sleep(Duration::from_secs(90));
    tokio::pin!(deadline);
    loop {
        while running.len() < 8 {
            let Some(host) = queue.next() else {
                break;
            };
            let credentials = credentials.clone();
            running.spawn(async move {
                let outcome =
                    timeout(Duration::from_secs(15), inspect(&host, port, &credentials)).await;
                let outcome = match outcome {
                    Ok(value) => value,
                    Err(_) => Err(anyhow::anyhow!(
                        "Device discovery reached its 15-second limit"
                    )),
                };
                (host, outcome)
            });
        }
        if running.is_empty() {
            break;
        }
        tokio::select! {
            _ = cancel.cancelled() => { result.cancelled = true; break; },
            _ = &mut deadline => { result.cancelled = true; break; },
            item = running.join_next() => {
                if let Some(Ok((host, outcome))) = item {
                    match outcome { Ok(device) => result.devices.push(device), Err(error) => result.failures.push(DiscoveryFailure { host, error: error.to_string() }) }
                }
            }
        }
    }
    running.abort_all();
    result.devices.sort_by(|a, b| a.host.cmp(&b.host));
    result.failures.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(result)
}

#[derive(Clone, Debug)]
enum Atom {
    Bytes(Vec<u8>),
    Number(i64),
    Text(String),
}
type Row = (Vec<u64>, Atom);
fn clean(raw: &[u8]) -> String {
    let mut result = String::new();
    for c in String::from_utf8_lossy(raw)
        .chars()
        .filter(|c| !c.is_control())
    {
        if result.len() + c.len_utf8() > 1024 {
            break;
        }
        result.push(c);
    }
    result
}
fn text(atom: &Atom) -> String {
    match atom {
        Atom::Bytes(b) => clean(b),
        Atom::Text(s) => s.clone(),
        Atom::Number(n) => n.to_string(),
    }
}
fn identifier(atom: &Atom, hex: bool) -> String {
    match atom {
        Atom::Bytes(b) if hex => b
            .iter()
            .map(|v| format!("{v:02x}"))
            .collect::<Vec<_>>()
            .join(":"),
        _ => text(atom),
    }
}
fn number(atom: &Atom) -> i64 {
    match atom {
        Atom::Number(n) => *n,
        _ => 0,
    }
}
fn rows(pdu: snmp2::Pdu<'_>) -> Result<Vec<Row>> {
    ensure!(
        pdu.error_status == 0,
        "SNMP agent rejected the read request"
    );
    let mut rows = Vec::new();
    for (oid, value) in pdu.varbinds.take(64) {
        let Some(parts) = oid.iter() else {
            bail!("Invalid SNMP object identifier");
        };
        let parts: Vec<_> = parts.collect();
        ensure!(parts.len() <= 128, "SNMP object identifier is too long");
        let atom = match value {
            Value::OctetString(b) => Atom::Bytes(b[..b.len().min(1024)].to_vec()),
            Value::ObjectIdentifier(o) => Atom::Text(o.to_id_string()),
            Value::Integer(n) => Atom::Number(n),
            Value::Timeticks(n) | Value::Unsigned32(n) | Value::Counter32(n) => {
                Atom::Number(n.into())
            }
            Value::NoSuchObject | Value::NoSuchInstance | Value::EndOfMibView => continue,
            _ => continue,
        };
        rows.push((parts, atom));
    }
    Ok(rows)
}
async fn get(session: &mut AsyncSession, oids: &[Oid<'_>]) -> Result<Vec<Row>> {
    for _ in 0..3 {
        match timeout(
            Duration::from_secs(2),
            session.get_many(&oids.iter().collect::<Vec<_>>()),
        )
        .await
        {
            Ok(Ok(pdu)) => return rows(pdu),
            Ok(Err(snmp2::Error::AuthUpdated)) => continue,
            Ok(Err(_)) => {
                bail!("SNMP read failed; check credentials, version and device access settings")
            }
            Err(_) => bail!("SNMP request timed out; check reachability and credentials"),
        }
    }
    bail!("SNMPv3 engine state could not be synchronized")
}
async fn walk(session: &mut AsyncSession, root: &[u64], limit: usize) -> Result<Vec<Row>> {
    let mut cursor = root.to_vec();
    let mut result = Vec::new();
    let mut updates = 0;
    loop {
        let oid = Oid::from(&cursor).map_err(|_| anyhow::anyhow!("Invalid SNMP table cursor"))?;
        let batch = match timeout(Duration::from_secs(2), session.getbulk(&[&oid], 0, 20)).await {
            Ok(Ok(pdu)) => rows(pdu)?,
            Ok(Err(snmp2::Error::AuthUpdated)) if updates < 2 => {
                updates += 1;
                continue;
            }
            Ok(Err(_)) => bail!("SNMP table is unavailable or access was denied"),
            Err(_) => bail!("SNMP table request timed out"),
        };
        if batch.is_empty() {
            return Ok(result);
        }
        for row in batch {
            if !row.0.starts_with(root) {
                return Ok(result);
            }
            ensure!(
                row.0 > cursor,
                "SNMP agent returned a non-increasing table index"
            );
            cursor.clone_from(&row.0);
            result.push(row);
            ensure!(
                result.len() < limit,
                "SNMP table exceeded the discovery limit"
            );
        }
    }
}

async fn inspect(host: &str, port: u16, credentials: &SnmpCredentials) -> Result<Device> {
    let address: SocketAddr = tokio::net::lookup_host((host, port))
        .await
        .context("Cannot resolve this host")?
        .next()
        .context("Host has no address")?;
    let mut session = match credentials {
        SnmpCredentials::V2c { community } => {
            AsyncSession::new_v2c(address, community.as_bytes(), 1)
                .await
                .context("Cannot open SNMP socket")?
        }
        SnmpCredentials::V3 {
            username,
            auth_protocol,
            auth_password,
            privacy_password,
            context,
        } => {
            let security = v3::Security::new(username.as_bytes(), auth_password.as_bytes())
                .with_auth_protocol(if auth_protocol == "sha256" {
                    v3::AuthProtocol::Sha256
                } else {
                    v3::AuthProtocol::Sha1
                })
                .with_auth(v3::Auth::AuthPriv {
                    cipher: v3::Cipher::Aes128,
                    privacy_password: privacy_password.as_bytes().to_vec(),
                })
                .with_context_name(context);
            let mut session = AsyncSession::new_v3(address, 1, security)
                .await
                .context("Cannot open SNMP socket")?;
            timeout(Duration::from_secs(2), session.init())
                .await
                .context("SNMPv3 engine discovery timed out")?
                .map_err(|_| anyhow::anyhow!("SNMPv3 engine discovery failed"))?;
            session
        }
    };
    let oids = [1, 2, 3, 4, 5, 6]
        .iter()
        .map(|column| {
            let mut parts = SYSTEM.to_vec();
            parts.extend([*column, 0]);
            Oid::from(&parts)
        })
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| anyhow::anyhow!("Invalid system OID"))?;
    let values = get(&mut session, &oids).await?;
    ensure!(
        !values.is_empty(),
        "The agent exposes no supported system information"
    );
    let mut device = Device {
        id: uuid::Uuid::new_v4().to_string(),
        name: host.into(),
        host: host.into(),
        address: address.ip().to_string(),
        snmp_port: port,
        observed_at: SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs(),
        ..Device::default()
    };
    for (oid, atom) in values {
        if oid.len() != SYSTEM.len() + 2 || !oid.starts_with(SYSTEM) {
            continue;
        }
        match oid[SYSTEM.len()] {
            1 => device.description = text(&atom),
            2 => device.sys_object_id = text(&atom),
            3 => device.uptime_ticks = number(&atom).max(0) as u32,
            4 => device.contact = text(&atom),
            5 => {
                let name = text(&atom);
                if !name.trim().is_empty() {
                    device.name = name;
                }
            }
            6 => device.location = text(&atom),
            _ => {}
        }
    }
    while device.name.len() > 200 {
        device.name.pop();
    }
    let mut interfaces = BTreeMap::<u64, DeviceInterface>::new();
    for column in [2, 7, 8] {
        let mut root = IF_TABLE.to_vec();
        root.push(column);
        match walk(&mut session, &root, 129).await {
            Ok(rows) => {
                for (oid, atom) in rows {
                    if oid.len() != root.len() + 1 {
                        continue;
                    }
                    let index = oid[root.len()];
                    if !interfaces.contains_key(&index) && interfaces.len() >= 128 {
                        continue;
                    }
                    let interface = interfaces.entry(index).or_insert_with(|| DeviceInterface {
                        index,
                        ..DeviceInterface::default()
                    });
                    match column {
                        2 => interface.name = text(&atom),
                        7 => interface.admin_status = number(&atom),
                        8 => interface.oper_status = number(&atom),
                        _ => {}
                    }
                }
            }
            Err(error) => device.warnings.push(format!("Interfaces: {error}")),
        }
    }
    device.interfaces = interfaces.into_values().collect();
    // Keep this separate: switches without LLDP must still return system inventory.
    let local_parts = [1, 2].map(|column| {
        let mut oid = LLDP_LOCAL.to_vec();
        oid.extend([column, 0]);
        oid
    });
    let local_oids = local_parts
        .each_ref()
        .map(|oid| Oid::from(oid).expect("Static LLDP OID"));
    match get(&mut session, &local_oids).await {
        Ok(rows) => {
            device.chassis_subtype = rows.iter()
                .find(|(oid, _)| oid == &local_parts[0])
                .map(|(_, atom)| match number(atom) { value @ 1..=7 => value as u8, _ => 0 }).unwrap_or(0);
            if let Some((_, atom)) = rows.iter().find(|(oid, _)| oid == &local_parts[1]) {
                device.chassis_id = identifier(atom, matches!(device.chassis_subtype, 4 | 5));
            }
        }
        Err(_) => device.warnings.push("Local LLDP chassis identity is unavailable; topology matching may need management addresses".into()),
    }
    let remote = walk(&mut session, LLDP_REMOTE, 2049).await;
    match remote {
        Ok(rows) if !rows.is_empty() => {
            let local = walk(&mut session, LLDP_LOCAL_PORTS, 1025).await;
            let addresses = walk(&mut session, LLDP_ADDRESSES, 2049).await;
            if local.is_err() {
                device
                    .warnings
                    .push("LLDP local port names are unavailable".into());
            }
            if addresses.is_err() {
                device
                    .warnings
                    .push("LLDP management addresses are unavailable".into());
            }
            device.neighbors = neighbors(
                &rows,
                &local.unwrap_or_default(),
                &addresses.unwrap_or_default(),
            );
        }
        Ok(_) => device.warnings.push(
            "No LLDP neighbors exposed; LLDP may be disabled, unsupported or have no neighbors"
                .into(),
        ),
        Err(error) => device.warnings.push(format!("LLDP: {error}")),
    }
    device.validate()?;
    Ok(device)
}

fn neighbors(remote: &[Row], local: &[Row], addresses: &[Row]) -> Vec<LldpNeighbor> {
    // lldpRemLocalPortNum is an LLDP port index, not necessarily an IF-MIB ifIndex.
    let mut ports = BTreeMap::new();
    for (oid, atom) in local {
        if oid.len() == LLDP_LOCAL_PORTS.len() + 2 && oid[LLDP_LOCAL_PORTS.len()] == 3 {
            let index = oid[LLDP_LOCAL_PORTS.len() + 1];
            let mac = local.iter().any(|(other, atom)| {
                other.len() == oid.len()
                    && other[LLDP_LOCAL_PORTS.len()..] == [2, index]
                    && number(atom) == 3
            });
            ports.insert(index, identifier(atom, mac));
        }
    }
    let mut entries = BTreeMap::<Vec<u64>, BTreeMap<u64, Atom>>::new();
    for (oid, atom) in remote {
        if oid.len() != LLDP_REMOTE.len() + 4 {
            continue;
        }
        let key = oid[LLDP_REMOTE.len() + 1..].to_vec();
        if !entries.contains_key(&key) && entries.len() >= 128 {
            continue;
        }
        entries
            .entry(key)
            .or_default()
            .insert(oid[LLDP_REMOTE.len()], atom.clone());
    }
    entries
        .into_iter()
        .map(|(key, columns)| {
            let mut neighbor = LldpNeighbor {
                local_port: ports
                    .get(&key[1])
                    .cloned()
                    .unwrap_or_else(|| format!("LLDP port {}", key[1])),
                ..LldpNeighbor::default()
            };
            neighbor.chassis_subtype = columns
                .get(&4)
                .map(|atom| match number(atom) {
                    value @ 1..=7 => value as u8,
                    _ => 0,
                })
                .unwrap_or(0);
            if let Some(atom) = columns.get(&5) {
                neighbor.chassis_id = identifier(atom, matches!(neighbor.chassis_subtype, 4 | 5));
            }
            if let Some(atom) = columns.get(&7) {
                neighbor.remote_port =
                    identifier(atom, columns.get(&6).is_some_and(|v| number(v) == 3));
            }
            if let Some(atom) = columns.get(&9) {
                neighbor.name = text(atom);
            }
            if let Some(atom) = columns.get(&10) {
                neighbor.description = text(atom);
            }
            for (oid, _) in addresses {
                let suffix = &oid[LLDP_ADDRESSES.len().min(oid.len())..];
                if suffix.len() < 6 || suffix[1..4] != key || neighbor.addresses.len() >= 16 {
                    continue;
                }
                let family = suffix[4];
                let length = suffix[5] as usize;
                if suffix.len() != 6 + length || suffix[6..].iter().any(|b| *b > 255) {
                    continue;
                }
                let bytes = suffix[6..].iter().map(|b| *b as u8).collect::<Vec<_>>();
                let address = match (family, length) {
                    (1, 4) => Some(IpAddr::V4(Ipv4Addr::from(
                        <[u8; 4]>::try_from(bytes.as_slice()).unwrap(),
                    ))),
                    (2, 16) => Some(IpAddr::V6(std::net::Ipv6Addr::from(
                        <[u8; 16]>::try_from(bytes.as_slice()).unwrap(),
                    ))),
                    _ => None,
                };
                if let Some(address) = address {
                    let address = address.to_string();
                    if !neighbor.addresses.contains(&address) {
                        neighbor.addresses.push(address);
                    }
                }
            }
            neighbor
        })
        .collect()
}

#[cfg(test)]
#[path = "discovery_tests.rs"]
mod wire_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_explicit_targets_and_rejects_urls() {
        assert_eq!(
            targets(&[
                "192.0.2.0/30".into(),
                "192.0.2.1".into(),
                "HOST.example.invalid".into()
            ])
            .unwrap(),
            ["192.0.2.1", "192.0.2.2", "host.example.invalid"]
        );
        for invalid in [
            "10.0.0.0/8",
            "https://example.invalid",
            "host:161",
            "-option",
            "user@host",
        ] {
            assert!(targets(&[invalid.into()]).is_err(), "{invalid}");
        }
        assert_eq!(targets(&["[2001:db8::1]".into()]).unwrap(), ["2001:db8::1"]);
        assert_eq!(targets(&["192.0.2.1/32".into()]).unwrap(), ["192.0.2.1"]);
    }
    #[test]
    fn lldp_joins_composite_indices_and_keeps_ports_separate_from_ifindex() {
        let row = |root: &[u64], suffix: &[u64], atom| {
            let mut oid = root.to_vec();
            oid.extend(suffix);
            (oid, atom)
        };
        let mut remote = vec![
            row(LLDP_REMOTE, &[4, 17, 42, 1], Atom::Number(4)),
            row(
                LLDP_REMOTE,
                &[5, 17, 42, 1],
                Atom::Bytes(vec![0, 1, 2, 3, 4, 5]),
            ),
            row(
                LLDP_REMOTE,
                &[9, 17, 42, 1],
                Atom::Bytes(b"neighbor".to_vec()),
            ),
        ];
        let local = vec![row(
            LLDP_LOCAL_PORTS,
            &[3, 42],
            Atom::Bytes(b"ethernet7".to_vec()),
        )];
        let addresses = vec![row(
            LLDP_ADDRESSES,
            &[3, 17, 42, 1, 1, 4, 192, 0, 2, 3],
            Atom::Number(9),
        )];
        let result = neighbors(&remote, &local, &addresses);
        assert_eq!(result[0].local_port, "ethernet7");
        assert_eq!(result[0].chassis_id, "00:01:02:03:04:05");
        assert_eq!(result[0].addresses, ["192.0.2.3"]);
        assert_eq!(result[0].name, "neighbor");
        remote[0].1 = Atom::Number(5);
        remote[1].1 = Atom::Bytes(vec![1, 192, 0, 2, 8]);
        let result = neighbors(&remote, &local, &addresses);
        assert_eq!(result[0].chassis_subtype, 5);
        assert_eq!(result[0].chassis_id, "01:c0:00:02:08");
        let local_mac = vec![
            row(LLDP_LOCAL_PORTS, &[2, 42], Atom::Number(3)),
            row(
                LLDP_LOCAL_PORTS,
                &[3, 42],
                Atom::Bytes(vec![0, 1, 2, 3, 4, 5]),
            ),
        ];
        assert_eq!(
            neighbors(&remote, &local_mac, &addresses)[0].local_port,
            "00:01:02:03:04:05"
        );
    }
    #[tokio::test]
    async fn cancellation_stops_unresponsive_requests() {
        let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move {
            discover(
                vec!["127.0.0.1".into()],
                socket.local_addr().unwrap().port(),
                SnmpCredentials::V2c {
                    community: "fixture-only".into(),
                },
                token,
            )
            .await
        });
        cancel.cancel();
        let result = timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(result.cancelled);
    }
}

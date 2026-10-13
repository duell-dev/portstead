//! Local UDP fixtures exercise the wire adapter without touching a real network device.
use super::*;
use snmp2::{MessageType, Pdu, Varbinds};

fn ber(tag: u8, bytes: &[u8]) -> Vec<u8> {
    let mut result = vec![tag];
    if bytes.len() < 128 {
        result.push(bytes.len() as u8);
    } else {
        result.extend([0x82, (bytes.len() >> 8) as u8, bytes.len() as u8]);
    }
    result.extend(bytes);
    result
}
fn bindings(items: &[(Vec<u64>, Atom)]) -> Vec<u8> {
    items
        .iter()
        .flat_map(|(oid, atom)| {
            let mut bytes = ber(6, Oid::from(oid).unwrap().as_bytes());
            bytes.extend(match atom {
                Atom::Bytes(bytes) => ber(4, bytes),
                Atom::Text(text) => ber(4, text.as_bytes()),
                Atom::Number(number) => ber(2, &number.to_be_bytes()),
            });
            ber(0x30, &bytes)
        })
        .collect()
}
fn fixture_rows() -> Vec<Row> {
    let row = |root: &[u64], suffix: &[u64], atom| {
        let mut oid = root.to_vec();
        oid.extend(suffix);
        (oid, atom)
    };
    let mut result = vec![
        row(SYSTEM, &[1, 0], Atom::Bytes(b"Fixture switch".to_vec())),
        row(SYSTEM, &[2, 0], Atom::Text("1.3.6.1.4.1.8691".into())),
        row(SYSTEM, &[3, 0], Atom::Number(12345)),
        row(SYSTEM, &[4, 0], Atom::Bytes(b"Fixture contact".to_vec())),
        row(SYSTEM, &[5, 0], Atom::Bytes(b"fixture-switch".to_vec())),
        row(SYSTEM, &[6, 0], Atom::Bytes(b"Fixture lab".to_vec())),
        row(IF_TABLE, &[2, 7], Atom::Bytes(b"Ethernet7".to_vec())),
        row(IF_TABLE, &[7, 7], Atom::Number(1)),
        row(IF_TABLE, &[8, 7], Atom::Number(2)),
        row(LLDP_LOCAL_PORTS, &[3, 42], Atom::Bytes(b"Port7".to_vec())),
        row(LLDP_REMOTE, &[4, 20, 42, 1], Atom::Number(4)),
        row(
            LLDP_REMOTE,
            &[5, 20, 42, 1],
            Atom::Bytes(vec![0, 1, 2, 3, 4, 5]),
        ),
        row(
            LLDP_REMOTE,
            &[7, 20, 42, 1],
            Atom::Bytes(b"remote-port".to_vec()),
        ),
        row(
            LLDP_REMOTE,
            &[9, 20, 42, 1],
            Atom::Bytes(b"neighbor-device".to_vec()),
        ),
        row(
            LLDP_ADDRESSES,
            &[3, 20, 42, 1, 1, 4, 192, 0, 2, 8],
            Atom::Number(1),
        ),
    ];
    result.sort_by(|a, b| a.0.cmp(&b.0));
    result
}
fn security(auth: v3::AuthProtocol) -> v3::Security {
    v3::Security::new(b"fixture-user", b"fixture-auth-password")
        .with_auth_protocol(auth)
        .with_auth(v3::Auth::AuthPriv {
            cipher: v3::Cipher::Aes128,
            privacy_password: b"fixture-privacy-password".to_vec(),
        })
        .with_engine_id(&[0x80, 0, 0x13, 0x70, 1, 2, 3, 4])
        .unwrap()
        .with_engine_boots_and_time(1, 1)
}
async fn fixture(version: &str, malformed: bool) -> (u16, tokio::task::JoinHandle<()>) {
    let socket = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let port = socket.local_addr().unwrap().port();
    let version = version.to_string();
    let task = tokio::spawn(async move {
        let mut bytes = vec![0; 65507];
        let rows = fixture_rows();
        let mut first = true;
        let mut auth = security(if version == "sha256" {
            v3::AuthProtocol::Sha256
        } else {
            v3::AuthProtocol::Sha1
        });
        let mut discovery = v3::Security::new(b"", b"")
            .with_auth(v3::Auth::NoAuthNoPriv)
            .with_engine_id(&[0x80, 0, 0x13, 0x70, 1, 2, 3, 4])
            .unwrap()
            .with_engine_boots_and_time(0, 0);
        loop {
            let (length, peer) = socket.recv_from(&mut bytes).await.unwrap();
            let initial = version != "v2c" && first;
            first = false;
            let signing = if initial {
                discovery.clone().with_engine_boots_and_time(1, 1)
            } else {
                auth.clone()
            };
            let mut request = if version == "v2c" {
                Pdu::from_bytes(&bytes[..length]).unwrap()
            } else {
                match Pdu::from_bytes_with_security(
                    &bytes[..length],
                    Some(if initial { &mut discovery } else { &mut auth }),
                ) {
                    Ok(pdu) => pdu,
                    Err(error) => {
                        if initial {
                            panic!("Fixture could not decode discovery: {error}");
                        }
                        continue;
                    }
                }
            };
            assert!(
                matches!(
                    request.message_type,
                    MessageType::GetRequest | MessageType::GetBulkRequest
                ),
                "Discovery must never send SNMP SET"
            );
            let requested = request
                .varbinds
                .clone()
                .map(|(oid, _)| oid.iter().unwrap().collect::<Vec<_>>())
                .collect::<Vec<_>>();
            let response = if initial {
                vec![]
            } else if request.message_type == MessageType::GetRequest {
                rows.iter()
                    .filter(|row| requested.contains(&row.0))
                    .cloned()
                    .collect::<Vec<_>>()
            } else if malformed {
                vec![(
                    requested[0].clone(),
                    Atom::Bytes(b"invalid cursor".to_vec()),
                )]
            } else {
                rows.iter()
                    .filter(|row| row.0 > requested[0])
                    .take(20)
                    .cloned()
                    .collect::<Vec<_>>()
            };
            let encoded = bindings(&response);
            request.message_type = if initial {
                MessageType::Report
            } else {
                MessageType::Response
            };
            request.error_status = 0;
            request.error_index = 0;
            request.varbinds = Varbinds::from_bytes(&encoded);
            let encoded = if version == "v2c" {
                request.to_bytes().unwrap()
            } else {
                request.to_bytes_with_security(Some(&signing)).unwrap()
            };
            socket.send_to(&encoded, peer).await.unwrap();
        }
    });
    (port, task)
}
#[tokio::test]
async fn reads_real_udp_inventory_and_lldp_in_v2c_and_authenticated_encrypted_v3() {
    for version in ["v2c", "sha1", "sha256"] {
        let (port, server) = fixture(version, false).await;
        let credentials = if version == "v2c" {
            SnmpCredentials::V2c {
                community: "fixture-only".into(),
            }
        } else {
            SnmpCredentials::V3 {
                username: "fixture-user".into(),
                auth_protocol: version.into(),
                auth_password: "fixture-auth-password".into(),
                privacy_password: "fixture-privacy-password".into(),
                context: String::new(),
            }
        };
        let result = discover(
            vec!["127.0.0.1".into()],
            port,
            credentials,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        server.abort();
        assert!(
            result.failures.is_empty(),
            "{version}: {}",
            serde_json::to_string(&result.failures).unwrap()
        );
        let device = &result.devices[0];
        assert_eq!(device.name, "fixture-switch");
        assert_eq!(device.interfaces[0].index, 7);
        assert_eq!(device.interfaces[0].oper_status, 2);
        assert_eq!(device.neighbors[0].local_port, "Port7");
        assert_eq!(device.neighbors[0].addresses, ["192.0.2.8"]);
        assert_eq!(device.neighbors[0].name, "neighbor-device");
        assert!(!serde_json::to_string(&device)
            .unwrap()
            .contains("fixture-auth-password"));
    }
}
#[tokio::test]
async fn rejects_non_increasing_walks_and_retains_system_information() {
    let (port, server) = fixture("v2c", true).await;
    let result = discover(
        vec!["127.0.0.1".into()],
        port,
        SnmpCredentials::V2c {
            community: "fixture-only".into(),
        },
        CancellationToken::new(),
    )
    .await
    .unwrap();
    server.abort();
    assert_eq!(result.devices.len(), 1);
    assert!(result.devices[0]
        .warnings
        .iter()
        .any(|w| w.contains("non-increasing")));
    assert!(result.devices[0].neighbors.is_empty());
}
#[tokio::test]
async fn rejects_wrong_v3_credentials_without_downgrading() {
    let (port, server) = fixture("sha256", false).await;
    let result = discover(
        vec!["127.0.0.1".into()],
        port,
        SnmpCredentials::V3 {
            username: "fixture-user".into(),
            auth_protocol: "sha256".into(),
            auth_password: "wrong-password".into(),
            privacy_password: "fixture-privacy-password".into(),
            context: String::new(),
        },
        CancellationToken::new(),
    )
    .await
    .unwrap();
    server.abort();
    assert!(result.devices.is_empty());
    assert_eq!(result.failures.len(), 1);
    assert!(!result.failures[0].error.contains("wrong-password"));
}

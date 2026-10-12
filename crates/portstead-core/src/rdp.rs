use crate::{
    credentials::{self, Credentials},
    model::{Connection, Target},
    session::{Input, SharedBuffer},
};
use anyhow::{ensure, Context, Result};
use ironrdp::{
    connector,
    graphics::image_processing::PixelFormat,
    pdu::{
        gcc::KeyboardType,
        input::{
            fast_path::{FastPathInputEvent, KeyboardFlags},
            mouse::{MousePdu, PointerFlags},
        },
        rdp::{
            capability_sets::MajorPlatformType,
            client_info::{CompressionType, PerformanceFlags, TimezoneInfo},
        },
    },
    session::{image::DecodedImage, ActiveStageBuilder, ActiveStageOutput},
};
use rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    DigitallySignedStruct, SignatureScheme,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::ErrorKind,
    net::{TcpStream, ToSocketAddrs},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

pub struct Frame {
    pub width: u16,
    pub height: u16,
    pub sequence: u64,
    pub rgba: Vec<u8>,
}

impl Frame {
    pub fn bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(12 + self.rgba.len());
        bytes.extend(self.sequence.to_le_bytes());
        bytes.extend(self.width.to_le_bytes());
        bytes.extend(self.height.to_le_bytes());
        bytes.extend(&self.rgba);
        bytes
    }
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum RdpInput {
    Key {
        code: u8,
        down: bool,
        #[serde(default)]
        extended: bool,
    },
    Text {
        text: String,
    },
    Mouse {
        x: u16,
        y: u16,
        #[serde(default)]
        button: u8,
        #[serde(default)]
        down: bool,
        #[serde(default)]
        wheel: i16,
    },
}

impl RdpInput {
    fn events(self) -> Result<Vec<FastPathInputEvent>> {
        Ok(match self {
            Self::Key {
                code,
                down,
                extended,
            } => {
                let mut flags = KeyboardFlags::empty();
                if !down {
                    flags |= KeyboardFlags::RELEASE;
                }
                if extended {
                    flags |= KeyboardFlags::EXTENDED;
                }
                vec![FastPathInputEvent::KeyboardEvent(flags, code)]
            }
            Self::Text { text } => {
                ensure!(text.len() <= 384, "Text input is too large");
                text.encode_utf16()
                    .flat_map(|code| {
                        [
                            FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::empty(), code),
                            FastPathInputEvent::UnicodeKeyboardEvent(KeyboardFlags::RELEASE, code),
                        ]
                    })
                    .collect()
            }
            Self::Mouse {
                x,
                y,
                button,
                down,
                wheel,
            } => {
                ensure!(
                    button <= 3 && (-120..=120).contains(&wheel),
                    "Invalid mouse input"
                );
                let mut flags = if wheel != 0 {
                    PointerFlags::VERTICAL_WHEEL
                } else {
                    match button {
                        1 => PointerFlags::LEFT_BUTTON,
                        2 => PointerFlags::RIGHT_BUTTON,
                        3 => PointerFlags::MIDDLE_BUTTON_OR_WHEEL,
                        _ => PointerFlags::MOVE,
                    }
                };
                if down {
                    flags |= PointerFlags::DOWN;
                }
                vec![FastPathInputEvent::MouseEvent(MousePdu {
                    flags,
                    x_position: x,
                    y_position: y,
                    number_of_wheel_rotation_units: wheel,
                })]
            }
        })
    }
}

#[derive(Debug)]
struct Verifier {
    strict: Arc<rustls::client::WebPkiServerVerifier>,
    pin: Option<String>,
    observed: Arc<Mutex<Option<String>>>,
}

fn fingerprint(cert: &[u8]) -> String {
    format!("{:x}", Sha256::digest(cert))
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        name: &ServerName<'_>,
        ocsp: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let hash = fingerprint(end.as_ref());
        *self.observed.lock().unwrap() = Some(hash.clone());
        if let Some(pin) = &self.pin {
            if pin.eq_ignore_ascii_case(&hash) {
                return Ok(ServerCertVerified::assertion());
            }
            return Err(rustls::Error::General(
                "The server certificate differs from this connection's trusted fingerprint".into(),
            ));
        }
        self.strict
            .verify_server_cert(end, intermediates, name, ocsp, now)
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.strict.verify_tls12_signature(message, cert, signature)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        self.strict.verify_tls13_signature(message, cert, signature)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.strict.supported_verify_schemes()
    }
}

type Stream = rustls::StreamOwned<rustls::ClientConnection, TcpStream>;

fn configuration(username: String, password: String, domain: String) -> connector::Config {
    connector::Config {
        credentials: connector::Credentials::UsernamePassword { username, password },
        domain: if domain.is_empty() {
            None
        } else {
            Some(domain)
        },
        enable_tls: false,
        enable_credssp: true,
        keyboard_type: KeyboardType::IbmEnhanced,
        keyboard_subtype: 0,
        keyboard_layout: 0x0409,
        keyboard_functional_keys_count: 12,
        ime_file_name: String::new(),
        dig_product_id: String::new(),
        desktop_size: connector::DesktopSize {
            width: 1280,
            height: 800,
        },
        bitmap: None,
        client_build: 0,
        client_name: "portstead".into(),
        client_dir: String::new(),
        platform: if cfg!(windows) {
            MajorPlatformType::WINDOWS
        } else {
            MajorPlatformType::UNIX
        },
        enable_server_pointer: true,
        request_data: None,
        autologon: false,
        enable_audio_playback: false,
        compression_type: Some(CompressionType::Rdp6),
        pointer_software_rendering: true,
        multitransport_flags: None,
        performance_flags: PerformanceFlags::default(),
        desktop_scale_factor: 0,
        hardware_id: None,
        license_cache: None,
        timezone_info: TimezoneInfo::default(),
        alternate_shell: String::new(),
        work_dir: String::new(),
    }
}

fn begin(
    host: &str,
    port: u16,
    config: connector::Config,
    pin: Option<String>,
) -> Result<(
    ironrdp_blocking::Upgraded,
    connector::ClientConnector,
    ironrdp_blocking::Framed<Stream>,
    Vec<u8>,
)> {
    let address = (host, port)
        .to_socket_addrs()?
        .next()
        .context("Host has no address")?;
    let tcp = TcpStream::connect_timeout(&address, Duration::from_secs(8))
        .context("RDP port is unreachable")?;
    tcp.set_read_timeout(Some(Duration::from_secs(10)))?;
    tcp.set_write_timeout(Some(Duration::from_secs(10)))?;
    let local = tcp.local_addr()?;
    let mut framed = ironrdp_blocking::Framed::new(tcp);
    let mut connector = connector::ClientConnector::new(config, local);
    let upgrade = ironrdp_blocking::connect_begin(&mut framed, &mut connector)
        .context("RDP security negotiation failed")?;
    let tcp = framed.into_inner_no_leftover();
    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let strict = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build()?;
    let observed = Arc::new(Mutex::new(None));
    let mut tls = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Verifier {
            strict,
            pin,
            observed: observed.clone(),
        }))
        .with_no_client_auth();
    tls.resumption = rustls::client::Resumption::disabled();
    let client =
        rustls::ClientConnection::new(Arc::new(tls), ServerName::try_from(host.to_owned())?)?;
    let mut stream = rustls::StreamOwned::new(client, tcp);
    while stream.conn.is_handshaking() {
        if let Err(e) = stream.conn.complete_io(&mut stream.sock) {
            let hash = observed
                .lock()
                .unwrap()
                .clone()
                .unwrap_or_else(|| "unavailable".into());
            anyhow::bail!("Server certificate verification failed: {e}. Presented SHA-256: {hash}. Verify it independently before adding a fingerprint to this connection.");
        }
    }
    use x509_cert::der::Decode;
    let cert = stream
        .conn
        .peer_certificates()
        .and_then(|c| c.first())
        .context("Server supplied no certificate")?;
    let cert = x509_cert::Certificate::from_der(cert.as_ref())?;
    let public_key = cert
        .tbs_certificate
        .subject_public_key_info
        .subject_public_key
        .as_bytes()
        .context("Certificate has no public key")?
        .to_vec();
    let upgraded = ironrdp_blocking::mark_as_upgraded(upgrade, &mut connector);
    Ok((
        upgraded,
        connector,
        ironrdp_blocking::Framed::new(stream),
        public_key,
    ))
}

#[derive(Serialize)]
pub struct Probe {
    pub verified: bool,
    pub detail: String,
}

pub fn probe(host: &str, port: u16) -> Probe {
    match begin(
        host,
        port,
        configuration(String::new(), String::new(), String::new()),
        None,
    ) {
        Ok(_) => Probe {
            verified: true,
            detail:
                "RDP security negotiation and certificate verification passed; no login attempted"
                    .into(),
        },
        Err(e) => Probe {
            verified: false,
            detail: format!("{e:#}"),
        },
    }
}

pub fn open(
    connection: &Connection,
    supplied: Credentials,
    output: SharedBuffer,
    frame: Arc<Mutex<Option<Frame>>>,
    stop: CancellationToken,
) -> Result<Input> {
    let Target::Rdp {
        host,
        username,
        domain,
        ..
    } = &connection.target
    else {
        anyhow::bail!("Not an RDP connection")
    };
    let mut username = if supplied.username.is_empty() {
        username.clone()
    } else {
        supplied.username.clone()
    };
    let domain = if supplied.domain.is_empty() {
        domain.clone()
    } else {
        supplied.domain.clone()
    };
    let password = match credentials::password(connection, &supplied) {
        Ok(password) => password,
        Err(error) => {
            if let Some((saved_user, password)) =
                credentials::saved_rdp_for(host, &username, &domain)
            {
                if username.is_empty() {
                    username = saved_user;
                }
                password
            } else {
                return Err(error);
            }
        }
    };
    let (username, domain) = credentials::identity(&username, &domain)?;
    ensure!(!username.is_empty(), "Enter an RDP username");
    let config = configuration(username, password, domain);
    let target = connection.target.clone();
    let (sender, receiver) = mpsc::sync_channel(128);
    std::thread::spawn(move || {
        if let Err(e) = run(target, config, output.clone(), frame, stop, receiver) {
            output.lock().unwrap().fail(&e);
        } else {
            output.lock().unwrap().status = "exited".into();
        }
    });
    Ok(Input::Rdp(sender))
}

fn run(
    target: Target,
    config: connector::Config,
    output: SharedBuffer,
    frame: Arc<Mutex<Option<Frame>>>,
    stop: CancellationToken,
    input: Receiver<RdpInput>,
) -> Result<()> {
    let Target::Rdp {
        host,
        port,
        certificate_sha256: pin,
        ..
    } = target
    else {
        anyhow::bail!("Not an RDP connection");
    };
    let (upgraded, connector, mut framed, public_key) = begin(&host, port, config, pin)?;
    let mut network = sspi::network_client::reqwest_network_client::ReqwestNetworkClient;
    let result = ironrdp_blocking::connect_finalize(
        upgraded,
        connector,
        &mut framed,
        &mut network,
        host.into(),
        public_key,
        None,
    )?;
    framed
        .get_inner_mut()
        .0
        .sock
        .set_read_timeout(Some(Duration::from_millis(60)))?;
    let mut image = DecodedImage::new(
        PixelFormat::RgbA32,
        result.desktop_size.width,
        result.desktop_size.height,
    );
    let mut active = ActiveStageBuilder {
        static_channels: result.static_channels,
        user_channel_id: result.user_channel_id,
        io_channel_id: result.io_channel_id,
        message_channel_id: result.message_channel_id,
        share_id: result.share_id,
        compression_type: result.compression_type,
        enable_server_pointer: result.enable_server_pointer,
        pointer_software_rendering: result.pointer_software_rendering,
    }
    .build();
    output.lock().unwrap().status = "running".into();
    let mut sequence = 0;
    while !stop.is_cancelled() {
        let mut updates = Vec::new();
        for event in input.try_iter().take(32) {
            updates.extend(active.process_fastpath_input(&mut image, &event.events()?)?);
        }
        match framed.read_pdu() {
            Ok((action, payload)) => updates.extend(active.process(&mut image, action, &payload)?),
            Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {}
            Err(e) => return Err(e.into()),
        }
        let mut changed = false;
        for update in updates {
            match update {
                ActiveStageOutput::ResponseFrame(bytes) => framed.write_all(&bytes)?,
                ActiveStageOutput::GraphicsUpdate(_) => changed = true,
                ActiveStageOutput::Terminate(_) => return Ok(()),
                ActiveStageOutput::DeactivateAll => {
                    anyhow::bail!("Server changed display capabilities; reconnect this session")
                }
                _ => {}
            }
        }
        if changed {
            sequence += 1;
            // shortcut: bounded full-frame snapshots; switch to dirty rectangles if profiling shows frame delivery is limiting.
            *frame.lock().unwrap() = Some(Frame {
                width: image.width(),
                height: image.height(),
                sequence,
                rgba: image.data().to_vec(),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_has_a_binary_header_and_inputs_are_bounded() {
        let frame = Frame {
            width: 1,
            height: 1,
            sequence: 7,
            rgba: vec![1, 2, 3, 255],
        };
        assert_eq!(frame.bytes().len(), 16);
        assert_eq!(&frame.bytes()[..8], &7u64.to_le_bytes());
        assert!(RdpInput::Text {
            text: "x".repeat(385)
        }
        .events()
        .is_err());
        assert!(RdpInput::Mouse {
            x: 0,
            y: 0,
            button: 9,
            down: false,
            wheel: 0
        }
        .events()
        .is_err());
        assert_eq!(
            RdpInput::Text { text: "ő".into() }.events().unwrap().len(),
            2
        );
        assert_eq!(
            fingerprint(b"hello"),
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
        );
    }
}

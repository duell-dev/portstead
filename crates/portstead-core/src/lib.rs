pub mod broker;
pub mod credentials;
pub mod engine;
pub mod kubernetes;
pub mod mcp;
pub mod model;
pub mod operations;
pub mod powershell;
pub mod rdp;
pub mod session;
pub mod store;
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

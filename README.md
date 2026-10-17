# Portstead

**A home for your connections.**

A desktop home for the connections you use together. Save a workspace of up to four panes, assign each pane a connection and entry command, and open the whole setup again with one action.

This is an early working prototype built with Rust, Tauri 2, TypeScript and xterm.js. Windows and Linux have passed clean CI builds and automated tests. Windows has also been exercised locally; Linux still needs validation on a working desktop. See [the development status](docs/development-status.md) for the checks and remaining limits. The earlier [research](docs/connection-manager-research.md) explains the protocol choices.

## What is implemented

- Nested folders with global and focused radial maps, a matching folder tree, breadcrumbs, search, pan/zoom, and folder rename/move. A focused folder shows all descendants. Connections and saved workspaces share the hierarchy.
- HTTP/HTTPS management-page profiles for devices such as Moxa gateways. Pages open in private Portstead windows, can be assigned to workspaces, and have no access to app commands or stored credentials.
- Read-only SNMPv2c/SNMPv3 discovery with device inventory, interface status, LLDP neighbors, a review-and-merge step, and reusable credentials in the OS credential store.
- An LLDP topology view with port labels, reciprocal/one-sided evidence, rings and parallel links, unresolved neighbors, folder filtering, neighborhood focus and a dated link table.
- Saved one-to-four-pane workspaces, with individual connection targets, pane titles and entry commands.
- Local and SSH terminals backed by real pseudoterminals. SSH uses the system OpenSSH client, including its existing config, host verification and agent support.
- Kubernetes context import and independent session kubeconfig snapshots. Different panes can have different contexts and namespaces without changing the source kubeconfig.
- A persistent WinRM PowerShell runspace adapter, with NTLM or system Kerberos authentication, command entry and host prompts.
- An embedded IronRDP framebuffer with keyboard and mouse input. RDP stays inside the application; certificates are verified before authentication.
- Portable JSON profile export/import. Local file paths are stored separately; passwords use the operating system credential store.
- A local MCP server that routes agent commands through the active desktop engine. Execution activity identifies the saved target, shows results and provides cancellation. Agent access starts disabled and is granted per connection.
- Light/dark themes, searchable connections and workspaces, backup on save and conflict detection between windows.

The RDP and WinRM adapters compile, but successful authenticated remote sessions still need live validation. They should be treated as experimental.

## Build and run

Install Rust through rustup, Node.js 24, and pnpm 11.25.0. The repository pins Rust 1.99.0. Install the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

On Windows, use the MSVC toolchain, Visual Studio C++ build tools with a Windows SDK, CMake, and the WebView2 runtime. Put CMake on PATH. On Debian/Ubuntu, install the desktop and protocol build dependencies:

```sh
sudo apt-get update
sudo apt-get install build-essential pkg-config cmake clang libssl-dev \
  libdbus-1-dev libkrb5-dev libgtk-3-dev libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev librsvg2-dev libxdo-dev patchelf
```

Then run:

```sh
git clone https://github.com/duell-dev/portstead.git
cd portstead
pnpm install --frozen-lockfile
pnpm tauri dev
```

To build a standalone executable with the frontend embedded:

```sh
pnpm build
cargo build -p portstead --features custom-protocol --locked
```

The executable is `target/debug/portstead.exe` on Windows or `target/debug/portstead` on Linux. Add `--release` to the Cargo build for a release executable. Installer packaging and code signing are not configured yet.

`ssh` must be installed for SSH connections; `kubectl` and your cluster's authentication tools must be installed for Kubernetes commands. Windows defaults to Windows PowerShell; Linux defaults to `$SHELL` or Bash. Custom Windows shells currently need to accept PowerShell-style startup/command arguments.

## First workspace

The app starts at **Connection map**. Choose the included local workspace in the sidebar to use its terminal. Add connections using **Folders & connections +**. Use **Workspaces +** or **Edit layout** to assign up to four panes. Entry commands execute when you explicitly open a pane or workspace; nothing connects automatically at startup.

Use **New folder** to build your hierarchy, or enter a folder path such as `Company / Budapest / Production` in connection or workspace settings. Click a folder in the map or tree to make it the viewing root. **Focused map** includes all nested folders, connections and workspaces; **Global map** shows the whole library. Breadcrumbs return to ancestors. Search filters the tree and map. Drag the map to pan, scroll or use the zoom buttons, and use **Fit to view** to see its extent. Keyboard users can select nodes with Enter/Space and use the tree; the map surface also supports arrow keys, +/- and Home. **Edit folder** renames or moves an entire branch, preserving its targets and agent grants. Deletion is limited to empty folders.

Choose **HTTP / HTTPS management page** for device web interfaces and enter the full URL. Login happens on the device page. The page opens in a separate Portstead window, including when opened from a saved workspace; it is not embedded inside the terminal grid. Navigation stays on the saved URL's origin, new-window popups are blocked, and normal HTTPS certificate checks remain enabled. Cross-origin SSO and certificate exceptions are not supported. Real device firmware and HTTP-authentication dialogs still require live testing. Management pages do not accept entry commands or MCP shell execution. Opening a terminal connection directly from the map creates or reuses a one-pane layout with no entry command.

For Kubernetes, use **Import kubeconfig**, review the contexts and any executable authentication warnings, then add imported contexts to a workspace. The app copies the source into a private session snapshot and sets that child's `KUBECONFIG`. It preserves relative certificate/key paths by resolving them against the source file. It does not run `kubectl config use-context` against your original file. The prototype does not provide a Kubernetes resource browser.

For WinRM, choose HTTPS with NTLM for a username/password connection, or Kerberos for your current Windows identity or an existing Linux ticket. The remote machine must already expose the intended WinRM endpoint. The app does not change server settings. The PowerShell pane accepts commands in the input below the terminal; it is not a full PSReadLine console.

For RDP, normal certificate validation is the default. **Check server certificate** performs negotiation without a login. If a server uses a private/self-signed certificate, obtain its SHA-256 fingerprint through a trusted channel before saving that fingerprint in the connection. There is no global certificate bypass. On Windows the app can reuse a saved `TERMSRV/<host>` credential for the matching identity, or you can enter and optionally remember a password in the app.

## Discover network devices

Choose **Discover devices** in the sidebar. Enter hostnames, individual IPv4/IPv6 addresses, or IPv4 CIDR ranges from `/24` to `/32`, one per line. Set the SNMP port and credentials. SNMPv3 uses authenticated, encrypted requests with SHA-256 or SHA-1 and AES-128; v2c accepts a community string for older devices. Use a read-only account/community. Devices must already expose SNMP and, for neighbor details, an LLDP MIB accessible to that identity. The app does not enable services or change device configuration.

To reuse credentials, enter a profile name and select **Remember credentials**. On later runs, select **Use saved profile** and enter that name. Secrets are stored in the OS credential store under `portstead-snmp`; they are not saved in profile JSON or returned to the UI when reused. There is no MCP credential-retrieval tool. As with other local credentials, the OS account remains the security boundary. **Forget saved profile** removes the named credential.

Review responding devices, names, interfaces, warnings and LLDP neighbors before choosing **Add selected devices**. Select a destination folder. Optionally create HTTP, HTTPS or SSH connections; these are your choices, not automatically verified services. Discovery merges into the current library. Existing device records refresh by management IP and SNMP port while retaining their ID, name, folder and saved host. Existing connections, workspaces and agent grants are preserved; newly created connections have agent access disabled. If another window has changed the library, save conflict detection still applies.

Device records appear in the folder tree and both radial hierarchy views. Select one for matching saved management connections, or open **Device details** to inspect ports/neighbors, change its name/folder, or remove its inventory record. Removing the record does not delete connections. Connection matching uses saved hostnames and the observed management IP; it does not resolve arbitrary DNS aliases. Inventory and LLDP data are dated observations, not live reachability indicators. Hierarchy lines continue to mean folder membership, not physical wiring.

Each run is limited to 256 explicit addresses, eight concurrent requests, a 90-second total runtime, and 15 seconds per device. Requests have two-second timeouts; interface and neighbor tables are bounded. **Stop discovery** keeps completed results for review; closing the dialog cancels the run. Advertised neighbors are never queried automatically. Only GET/GETBULK requests are used. There is no background polling, SNMP SET, trap listener, recursive discovery, vendor-specific MIB browser or discovery MCP tool yet. Device deduplication does not model overlapping management IPs in separate networks. Real hardware interoperability remains to be validated.

Optional `devices` records travel with JSON exports, including observed names, addresses, ports and topology details. Old JSON libraries without this field still load. Libraries containing inventory require this updated app on the receiving machine; older versions reject the added field. The whole library remains limited to 4 MiB.

## View network topology

After **Add selected devices**, choose **Topology** in the sidebar. This view derives links from saved LLDP observations; it does not move devices between folders or open connections automatically. Refresh discovery and add its results again to update observations. New scans collect each switch's own LLDP chassis identity. Older saved inventory still loads; rescanning improves matching where neighbors do not advertise management addresses.

Neighbors match a unique saved management IP first, then a unique chassis identity with its LLDP subtype. Device names never establish links. Ambiguous identities and neighbors outside the inventory stay visible as dashed-outline nodes, with an explanation in their details. Each unresolved advertisement remains separate rather than assuming two similar sightings identify the same device. This cannot resolve overlapping address spaces without separate inventories.

Solid links have matching reports from both endpoints for the same port pair. Dashed links have one report. Parallel port pairs, rings and self-loops remain visible. Select a device or link for port labels, matching evidence, observation times and available saved connections. **Device details** opens its inventory record. Reports with different or missing port identifiers stay separate; reciprocal evidence does not prove a link is available now.

Filter by folder or search to narrow the graph; adjacent devices outside the filter remain visible to show boundary links. **Focus** shows a device and its direct neighbors. Use pan/zoom, **Fit to view**, Enter/Space for selection, and arrow keys/+/-/Home on the map surface. The circular layout expresses connectivity, not physical location or distance. Above 150 nodes or 300 links, use the paginated link table to choose a device and focus its neighborhood. View settings are temporary; the saved inventory travels with exported profiles.

## Move profiles between machines

Use **Export** on the source machine and **Import** on the destination. Import replaces the library after confirmation, retains a backup, closes open sessions and turns imported agent grants off.

An export includes hosts, usernames, context names, namespaces, layouts and commands. It contains neither passwords nor the contents of SSH keys or kubeconfigs. Machine paths become opaque `local://…` references. On the destination, open connection settings and use **Choose local file** to bind each reference to the appropriate local file or shell; enter credentials on that device. SSH configuration and keys remain managed by OpenSSH.

Profiles are readable JSON. Hosts, usernames and commands are still private information; review an export before sharing it publicly. Commands should not contain embedded secrets. Review imported entry commands and kubeconfig authentication plugins before connecting.

The config directory remains the OS config directory plus `connmanager` to preserve existing prototype profiles. Set `PORTSTEAD_HOME` to use another directory; the legacy `CONNMANAGER_HOME` variable remains supported when `PORTSTEAD_HOME` is unset. OS credential service names and the Tauri app identifier also remain unchanged so existing credentials and window preferences are retained. Its files are:

- `library.json`: portable connection definitions and layouts.
- `library.backup.json`: the previous library.
- `bindings.json`: local file/shell bindings; do not sync or publish this file.
- `sessions/`: temporary session kubeconfig snapshots, which can contain authentication data. Normal session closure removes them; a crash may leave a snapshot to remove manually.
- `agent-runtime.json`: loopback server metadata; its authentication token is kept in the OS credential store.

The config directory, including temporary files, should be accessible only to your own account. Local bindings are retained for backup recovery; automatic pruning is not implemented.

## Connect an MCP client

Enable **Allow agents to execute commands** on selected connections. Click **Agents off** to start the local bridge, then copy the generated MCP client configuration. It uses the `portstead` server name, points at the same executable with `--mcp` and includes the correct `PORTSTEAD_HOME`. Keep the app running. Existing MCP client configurations should be updated to use the renamed executable.

Available tools:

| Tool | Use |
| --- | --- |
| `connections_list` | Discover permitted connections and the current `library_revision`. |
| `workspaces_list` | Discover layouts whose connections are all permitted. |
| `command_run` | Execute on an explicit connection ID and revision; returns an operation ID. |
| `operation_read` | Read an agent operation's retained result. |
| `operation_cancel` | Request cancellation of an agent operation. |
| `operations_list` | List agent operations with output previews. |

Editing a library invalidates stale agent execution requests. New commands require a fresh catalog revision. Agents cannot retrieve stored passwords or read/cancel the desktop user's operations. All MCP clients for the current OS account share the selected grants and agent operation history; per-agent identities and permissions are not implemented. Commands run with the connection account's privileges. This is an access grant, not a sandbox.

Turning agents off stops new requests and requests cancellation of active agent commands. Cancellation or timeout cannot prove that a remote change was rolled back; an unknown outcome is never automatically retried. SSH agent commands use batch authentication, so interactive password/host-key prompts must first be resolved through a human SSH connection.

For a headless engine, run `portstead --serve-agents` with an existing profile directory; stop it with Ctrl+C. It does not open the GUI. `portstead --rdp-probe <host>` checks RDP negotiation and certificate trust without authenticating.

## Check changes

```sh
pnpm build
pnpm test
cargo fmt --all --check
cargo clippy --workspace --all-targets --features custom-protocol --locked -- -D warnings
cargo test -p portstead-core --locked
```

The real MCP integration test needs an unlocked OS credential store and runs only when explicitly requested:

```sh
cargo test -p portstead-core --test mcp --locked -- --ignored
```

For browser UI checks, build the frontend, install Playwright Chromium with `pnpm exec playwright install chromium`, then run `pnpm test:ui`. The script starts its own preview server, mocks IPC and makes no connections. On Windows, `UI_BROWSER_CHANNEL=msedge` uses an installed Edge instead.

After building the embedded debug executable, `pnpm test:native` tests the actual Windows WebView2 app, four local PTYs, command execution and stdio MCP through the desktop engine. It uses a separate ignored `.local/` profile directory and temporarily enables loopback WebView2 debugging. It never connects to a remote machine.

## Contributing

Keep protocol behavior in `crates/portstead-core`, native commands in `src-tauri`, and presentation in `src`. Change all affected IPC callers and tests together. Use explicit target identity checks for execution, validate imported data, preserve save backups and keep credentials out of exported profiles and logs. See [CONTRIBUTING.md](CONTRIBUTING.md) for the next acceptance gates.

MIT licensed. Third-party dependencies retain their own licenses.

# Portstead development status — 12 October 2026

This is the first implementation, not a production release. The executable embeds the frontend and can run independently of Vite. The application and MCP use the same Rust engine.

The app is named **Portstead**. The executable, UI and MCP identity use that name; prototype profile/credential storage locations remain unchanged. `PORTSTEAD_HOME` is the preferred directory override, with `CONNMANAGER_HOME` retained for compatibility.

The source is published at [duell-dev/portstead](https://github.com/duell-dev/portstead). GitHub Actions checks the frontend, Rust engine and desktop build on Windows and Ubuntu.

## Verified locally

| Check | Evidence |
| --- | --- |
| Windows desktop build | Rust MSVC build with `custom-protocol`, embedded frontend and WebView2. |
| Native desktop behavior | Four real local PowerShell PTYs, four different saved entry commands, typed terminal input, command results, saved layout, and clean session closure through the actual frontend/native IPC. |
| MCP in the running desktop | Real stdio handshake and six discovered tools; a local command through the active desktop engine; visible agent activity; result retrieval and cancellation. |
| MCP local bridge | An independent integration test checks bearer authentication, catalog grants, real command execution, permission revocation and credential-token cleanup. |
| Profile portability | Exported local paths become references; import on another store refuses connection until rebound; rebinding preserves the source machine's paths. |
| File saves | Validation, stale-revision rejection, atomic replacement and previous-library backup. |
| Kubernetes files | Independent context/namespace snapshots, relative certificate/key resolution, unchanged original source. Uses a fixture, not live clusters. |
| Frontend behavior | TypeScript build, frame/escaping tests, and browser smoke checks for layouts, entry commands, connection editing, output escaping, themes, agent configuration and minimum window dimensions. Browser IPC is mocked. |
| Native adapters | SSH, WinRM and embedded RDP code compile. |
| RDP negotiation | The authorized test host responded; the untrusted issuer stopped TLS validation before authentication. No credential was sent and no remote desktop session was opened. |

The local suite currently includes 15 Rust unit tests, three frontend unit tests, the explicit real MCP integration test, and the browser/native smoke scripts. Re-run the README checks after changes; this document is a dated record.

## Verified in CI

The [initial CI workflow](https://github.com/duell-dev/portstead/actions/runs/38288202233) passed on Windows 2025 and Ubuntu 24.04. Both jobs passed the frontend build, three frontend unit tests, browser smoke test, Rust formatting and Clippy checks, 15 Rust unit tests, and the full Tauri desktop build. CI does not launch the native GUI or run authenticated remote sessions. The MCP keyring integration test is excluded from unattended CI and remains explicitly verified on Windows locally.

## Still to validate

- **Linux desktop.** The clean build and automated tests passed in CI. Launching the actual desktop, interactive local PTYs, credential storage and real Kubernetes context isolation still require a working Linux desktop.
- **Authenticated RDP.** The user chose to defer testing until certificate trust is independently established. Rendering, NLA, desktop input and reconnect behavior remain unproven against a live server.
- **WinRM authentication and remote runspaces.** Domain/local NTLM, Windows identity and Linux Kerberos tickets require live targets. Secure-prompt cancellation is unit tested; a remote host has not yet been used.
- **SSH and real Kubernetes clusters.** Actual host-key, agent, jump-host, exec-auth and network-disconnect cases need non-production acceptance tests.

## Current implementation limits

- Layouts contain one to four panes, using fixed grids. No arbitrary split tree, drag-to-resize, detached windows or tmux persistence yet.
- RDP uses a 1280×800 initial desktop and full RGBA frame snapshots. Clipboard, audio, drive sharing, dynamic size changes, session reactivation and automatic reconnection are not implemented. Stop may wait for the current bounded network read during negotiation.
- WinRM provides a persistent command runspace and basic host prompts. It has no tab completion/PSReadLine editor, general credential dialogs or reconnect recovery. Most pipeline output appears at completion. The current PSRP SDK collects stream records in memory before the app bounds the retained result; noisy WinRM jobs can use excessive memory. Bounded streaming is a release gate, not a solved problem.
- Local/SSH command operations return output when the command finishes. Retained raw stdout/stderr are capped at 1 MiB per stream; activity/list previews are capped at 4 KiB per stream. A remote timeout/cancellation may leave the remote outcome unknown. There are no automatic retries.
- Agent clients share grants and retained agent history within the OS account. There is no per-agent isolation or remote MCP listener.
- Custom Windows shell startup commands assume PowerShell-compatible arguments. Use the default Windows PowerShell or `pwsh` for this prototype.
- Imports replace a library, preserve one backup and reset agent grants. There is no merge editor, synchronization service or encrypted profile bundle.
- Normal closure removes kubeconfig snapshots. Crash cleanup and private-directory ACL hardening still need work before release. Binding history is retained for backup recovery and is not pruned.
- Installer packages, signing, updater, telemetry, a hosted service and plugins are not configured.

## Next work

Exercise the Linux desktop and conduct the RDP/WinRM acceptance tests in CONTRIBUTING.md. Fix protocol failures and introduce bounded PSRP streaming before spending time on extra protocol types or release packaging. Keep the profile/credential separation and explicit target checks as core behavior.

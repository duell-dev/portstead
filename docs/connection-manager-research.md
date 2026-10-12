# Connection Manager Feasibility and Product Research

Research date: 11 October 2026.

A portable desktop connection manager with saved terminal layouts, embedded RDP, WinRM PowerShell sessions, Kubernetes contexts, and a local MCP server is a credible project. Existing projects supply the major protocol components. The strongest proposed direction is a Rust session engine with a Tauri desktop interface and a TypeScript terminal surface. Embedded RDP rendering and interactive WinRM behavior must pass interoperability checks before this becomes a committed stack.

The product opportunity is to make complete working environments easy to create, reopen, move, and share. Rust is a reasonable implementation candidate, but responsiveness also depends on rendering, output buffering, and communication between the engine and interface. There are no measured performance results for this application yet.

## Established requirements

- Windows and Linux from the first release, with a modern desktop interface.
- SSH access to Debian and Ubuntu machines.
- Saved layouts of three or four terminals, each with a predetermined target and entry command.
- PowerShell remoting through WinRM to dedicated Windows machines, using both domain and local credentials.
- RDP rendered inside application tabs or panes.
- Several Kubernetes clusters and kubeconfig sources, with predictable context selection.
- Portable connection and workspace definitions, with straightforward setup on another machine.
- An integrated MCP server for agents.
- Public development on GitHub and usable releases for colleagues and friends.

## Feasibility by capability

These assessments combine documented capabilities with engineering judgment. A library advertising a feature does not establish that the finished application supports every server policy, operating system, or authentication setup.

| Capability | Practical route | Main condition |
| --- | --- | --- |
| SSH terminals | System OpenSSH through a local PTY; consider a native SSH library for structured operations | Preserve existing config, agents, host verification, and jump-host behavior |
| Local terminals and layouts | Rust PTY backend with xterm.js frontend and a saved split tree | Verify resizing, Unicode, input methods, accessibility, and output buffering |
| Embedded RDP | Evaluate IronRDP first, with FreeRDP as an alternative | Decode and render inside our pane; validate authentication, keyboard, clipboard, and resize |
| WinRM command execution | Rust WinRM and PSRP candidates or a packaged Python PSRP adapter | Test domain and local authentication on both client operating systems |
| Interactive WinRM PowerShell | Persistent PSRP runspace with a host implementation | Prompts, completion, interruption, streams, and session state require additional work |
| Multiple Kubernetes contexts | Explicit configuration for managed operations and independent session defaults | Preserve credentials, relative paths, and authentication plugins |
| MCP access | Official Rust MCP SDK over local stdio | Explicit targets, execution tracking, cancellation, and connection access settings |
| Portable profiles | Versioned definitions with credential and tool references | Separate portable configuration from secrets and machine-specific paths |

The terminal building blocks already exist: [xterm.js](https://github.com/xtermjs/xterm.js) supplies terminal emulation, while [portable-pty](https://docs.rs/portable-pty/latest/portable_pty/) exposes operating-system pseudoterminals in Rust. The application still supplies processes, transport, and session lifecycle.

For SSH, OpenSSH documents jump hosts, identity references, forwarding, and configuration rules. Using it initially can preserve a user's established configuration. [OpenSSH configuration manual](https://man.openbsd.org/ssh_config)

## Embedded RDP choices

**IronRDP is the first candidate for a Rust engine.** Its project documents native Windows and Linux clients, TLS, NLA, clipboard channels, display resizing, and modular protocol components. These are useful building blocks; selecting the relevant crates and integrating rendering remain application work. Advanced codecs, redirection, and authentication combinations need separate acceptance checks. [IronRDP project](https://github.com/Devolutions/IronRDP)

Its web component and WebAssembly bindings are another possible rendering route. That route still needs a suitable transport bridge and credential boundary. A working browser client does not establish that it can be placed unchanged inside a Tauri pane. [IronRDP web client](https://github.com/Devolutions/IronRDP/tree/master/web-client)

**FreeRDP is an alternative with an existing protocol library and clients.** A Rust application would need native-library integration, callbacks, packaging, and an appropriate rendering surface. Compare it against IronRDP using the same server and interaction scenarios. [FreeRDP project and API documentation](https://github.com/FreeRDP/FreeRDP)

Use protocol-level rendering within the application's layout. An approach that reparents another client's operating-system window introduces platform-specific behavior and needs separate treatment on Windows, X11, and Wayland.

**Apache Guacamole is useful if a shared browser gateway becomes a product requirement.** Its architecture adds a web application and the guacd proxy, which connects to remote systems. That is a different deployment shape from a desktop app installed on a colleague's laptop. It could support a later server edition, but it is not the preferred baseline here. [Guacamole architecture](https://guacamole.apache.org/doc/gug/guacamole-architecture.html)

RDP acceptance should include NLA with domain and local accounts, valid and invalid server certificates, Hungarian and US keyboard layouts, clipboard direction, display resize, DPI scaling, reconnect, and two concurrently visible sessions. RemoteApp, audio, smart cards, multiple monitors, and file redirection should be promised only after explicit testing.

## WinRM and PowerShell choices

WinRM transports remote operations. PowerShell Remoting Protocol, or PSRP, provides PowerShell runspaces, pipelines, object serialization, and host interactions. A tool that launches powershell.exe remotely for each command does not by itself provide persistent variables, imported modules, location, or a complete interactive PowerShell experience.

Microsoft documents that its PowerShell WSMan remoting client is unsupported on non-Windows platforms. Linux support therefore needs an alternative implementation; installing pwsh alone does not settle the requirement. [Microsoft WSMan support](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/wsman-remoting-in-powershell?view=powershell-7.5)

There are now Rust candidates worth investigating. [winrm-rs](https://docs.rs/winrm-rs/latest/winrm_rs/) documents NTLM, Kerberos, certificate authentication, asynchronous execution, and shell reuse. Its Kerberos route requires a feature and system Kerberos setup. Domain username/password support and reuse of the current Windows logon identity are distinct acceptance cases.

[psrp-rs](https://docs.rs/psrp-rs/latest/psrp_rs/) documents typed output, separate PowerShell streams, persistent runspace pools, and pipelines. Its published scope still places input streaming and reconnect/disconnect on the roadmap. The [PSRP host interface](https://docs.rs/psrp-rs/latest/psrp_rs/host/trait.PsHost.html) provides callbacks that default to rejection unless implemented. Prompts therefore need application behavior, including cancellation and secure input handling.

CredSSP needs particular care when evaluating these Rust candidates. The winrm-rs [crate overview](https://docs.rs/winrm-rs/latest/winrm_rs/) describes experimental support, while its [authentication enum documentation](https://docs.rs/winrm-rs/latest/winrm_rs/enum.AuthMethod.html) describes an unimplemented path. Pin and inspect the selected release, then test it against the required hosts; do not make a release promise from either description alone.

[pypsrp](https://github.com/jborean93/pypsrp) is an alternative that documents WinRM, persistent PowerShell runspaces, interactive host support, and NTLM, Kerberos, and CredSSP authentication. Linux Kerberos support brings additional system dependencies. A packaged adapter is a reasonable fallback if the Rust candidates fail the required scenarios. It avoids making a new protocol implementation part of this project's scope.

The human interface should maintain a runspace and implement the necessary PowerShell host callbacks. Agent executions can use separate runspaces and receive structured results. These clients share connection definitions and transport code without competing for one interactive input stream. WinRM is a PowerShell remoting session model; arbitrary native programs expecting a console need separate validation. [PowerShell remoting behavior](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/powershell-remoting-faq?view=powershell-7.5)

The dedicated admin machine also introduces a possible second hop: the user connects to that machine, then accesses another server or network resource from it. Successful first-hop authentication does not settle credential delegation. The app should distinguish that failure from an initial login failure. [Microsoft second-hop guidance](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/ps-remoting-second-hop?view=powershell-7.5)

## Desktop architecture options

| Option | Fit for this project | Tradeoff |
| --- | --- | --- |
| Tauri with Rust and TypeScript | Leading candidate given the Rust interest, web terminal ecosystem, and local native engine | Windows and Linux use different webview engines; embedded RDP rendering needs proof |
| Electron with a Rust engine | Alternative when a consistent Chromium environment materially improves integration | Adds Chromium and Node packaging; still needs native protocol integration |
| Qt Quick with a native backend | Credible choice for custom desktop rendering and QML interfaces | Adds QML and native bindings; module licensing and distribution need review |
| Avalonia with a .NET backend | Credible if C# maintenance becomes preferable | Cross-platform UI support does not automatically provide Linux WinRM or terminal integration |
| Extend Tabby | Reuses substantial terminal, profile, SSH, and split-pane behavior | Its architecture and plugin model would become ours; embedded RDP and WinRM still need integration |

Tauri combines a Rust backend with web content. It uses WebView2 on Windows and WebKitGTK on Linux, so rendering and input behavior need testing on both. [Tauri architecture](https://v2.tauri.app/concept/architecture/), [webview backends](https://v2.tauri.app/reference/webview-versions/)

Electron provides a Chromium-derived process model. Its rendering consistency is useful, but changing the desktop framework would not remove RDP or WinRM integration work. [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model)

Qt Quick supplies a QML interface framework with native extension APIs. Avalonia documents Windows and Linux targets. Both can support modern interfaces; appearance alone is insufficient to choose among them. [Qt Quick](https://doc.qt.io/qt-6/qtquick-index.html), [Avalonia platforms](https://docs.avaloniaui.net/docs/supported-platforms)

[Tabby](https://tabby.sh/about/features) already supports saved split-pane profiles, SSH, jump hosts, forwarding, and terminal restoration. It establishes a useful baseline: those features alone do not distinguish this project. The combined portability, WinRM, embedded desktop, Kubernetes, and agent workflows provide the stronger reason to build.

The proposed Rust engine owns connections, active sessions, execution results, and credential resolution. The GUI and MCP adapter call that engine. One owner for an active session avoids competing writers and duplicated connection state. The precise process layout should follow the feasibility prototypes, with local IPC if GUI and MCP run as separate processes.

RDP frame delivery deserves an early performance check. Tauri documents that its generic event system is unsuitable for high-throughput or low-latency data and provides ordered channels for streaming. Evaluate an appropriate binary/frame path and partial updates; avoid assuming JSON events carrying complete frames will perform well. [Tauri frontend communication](https://v2.tauri.app/develop/calling-frontend/)

If a Python WinRM adapter is required, Tauri can package external binaries per target architecture. That creates another build artifact to maintain, but it does not require users to install a Python development environment. [Tauri sidecars](https://v2.tauri.app/develop/sidecar/)

## Portable profiles and Kubernetes configuration

Use stable references for connections, workspaces, identities, and external configuration sources. A workspace describes pane positions, targets, entry commands, and launch behavior. A machine-specific binding tells the application where an identity, kubeconfig source, or required executable lives.

Moving to another computer should require binding missing identities and tools once. Shared workspaces then reuse those bindings. The portable format should have a schema version, validation, readable changes, and an import preview. Application writes should be atomic, with recoverable backups and visible conflict handling.

Plain profile exports should exclude secret material. Offer an explicitly encrypted full backup later if credential migration is needed. Configuration itself may also contain private hostnames and usernames, so public example exports need a preview and deliberate sanitization.

For local secret storage, select explicit operating-system store backends and define behavior when the Linux store is locked or unavailable. The current keyring documentation points applications needing store selection toward keyring-core and specific stores. Do not silently fall back to plaintext storage. [Rust keyring guidance](https://docs.rs/keyring/latest/keyring/), [keyring-core](https://docs.rs/keyring-core/latest/keyring_core/)

For Kubernetes, record both the source and context identity. The importer should detect collisions, preserve file-relative references, and make source precedence visible. Managed commands should specify their configuration and context. Terminal sessions should receive independent app-owned defaults rather than changing the user's shared current-context. A user can still override the context inside a general shell; the displayed context label describes the managed default, not an enforced restriction. [Kubernetes kubeconfig rules](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)

Preserve certificate paths and executable authentication plugins when creating session configuration. Moving a kubeconfig does not move a cloud login, provider CLI, or local credential cache. Dependency checks should identify what is missing on the new machine. Imports must inspect executable authentication settings before use. [Kubernetes authentication](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)

K9s is a useful early integration because it supports explicit context selection and namespace navigation. Launch it in a pane with the chosen session configuration. Headlamp supplies a separate graphical Kubernetes interface when one is wanted. A complete resource editor would significantly widen this project's scope. [K9s commands](https://k9scli.io/topics/commands/), [Headlamp](https://headlamp.dev/docs/latest/)

## Additional features worth building

The ranking below reflects this user's workflow. Effort is a qualitative integration estimate, not a delivery schedule. Established requirements remain part of the core regardless of where convenience features rank.

| Feature | Concrete benefit | Smallest useful version | Suggested order | Effort |
| --- | --- | --- | --- | --- |
| Migration and binding wizard | Stops recreating existing configuration | Import SSH aliases, kubeconfig contexts, and supported terminal layouts; report unresolved references | Core | Medium |
| Command palette | Quickly finds a machine, workspace, or action | Search names, tags, recent sessions, and saved workspaces from the keyboard | Core | Low |
| Reusable runbooks | Makes repeated operational tasks shareable and agent-accessible | Named action with typed inputs, target, result, and cancellation | Early addition | Medium |
| Workspace templates | Reuses the same four-pane setup on another machine | Select a target when opening a saved layout; retain per-pane overrides | Early addition | Medium |
| Managed tunnels and port forwards | Eliminates forgotten ports and orphaned forwarding processes | Start/stop, target display, port-conflict diagnosis, and session ownership | Early addition | Medium |
| Connection diagnostics | Makes setup failures understandable | Display the failed stage and evidence: name resolution, transport, trust, authentication, or remote setup | Early addition | Medium |
| Agent activity and handoff | Makes agent work visible and stoppable | Show target, operation, output, status, and an explicit stop/takeover control | Core MCP behavior | Medium |
| SFTP file panel | Keeps routine file transfer beside SSH work | Browse, upload, download, and explicit overwrite handling | After core | Medium |
| Simple shared defaults | Reduces repetitive identity and gateway configuration | Group defaults with visible effective values and explicit overrides | Early addition | Medium |
| Kubernetes quick actions | Turns cluster selection into useful work immediately | Namespace picker, pod logs/exec, K9s launch, and owned port forwards | After isolated contexts | Medium |
| Remote persistence helpers | Reopens real remote work after a disconnect | Saved tmux attach/create action with clear lifecycle behavior | After core | Low to medium |
| Notes and related links | Keeps operational knowledge with the target | Markdown notes and links to documentation or an existing browser | Early addition | Low |
| Search across session output | Finds an error without checking each terminal separately | Search current workspace buffers with target and pane labels | After core | Medium |
| Completion notifications | Lets long tasks run without watching them | Notify for managed command completion; use shell integration for terminal commands | After execution tracking | Low to medium |
| Shared profile library | Lets colleagues reuse layouts and actions | Import/export readable files suitable for a private repository; resolve conflicts explicitly | After portable format | Medium |
| Agent control of remote desktops | Allows agents to operate tools available only through a GUI | Opt-in screenshots and input, visible control owner, and takeover | Later | High |
| Selected-pane broadcast | Speeds identical maintenance across chosen machines | Explicit selection, clear active state, and a quick off action | Later | Medium |

Runbooks are particularly valuable because one saved operation can serve three uses: a human launches it, a workspace uses it as an entry action, and an agent calls it through MCP. Start with individual actions and validated inputs. A workflow language with arbitrary branching is unnecessary for this first version.

Workspace templates address the current terminal macros directly. A maintenance template can define shell, service logs, process monitor, and container monitor panes. Opening it for app-02 binds the shared target once, while preserving any pane that intentionally points elsewhere. This avoids copying and editing four separate commands for every new host.

Managed tunnels fit the existing protocols: OpenSSH supports forwarding and jump hosts, while Tabby demonstrates persistent forward profiles. A tunnel panel should show exactly what remains open, which connection owns it, and whether closing a terminal also closes the forward. [OpenSSH forwarding](https://man.openbsd.org/ssh_config), [Tabby forwarding profiles](https://tabby.sh/about/features)

A migration wizard can inspect Windows Terminal command lines containing tabs and split-pane actions. Start with a supported subset and explain unsupported shell scripting rather than executing imported macros or silently changing their meaning. [Windows Terminal command line arguments](https://learn.microsoft.com/en-us/windows/terminal/command-line-arguments)

Remote desktop agent control has concrete precedent in IronRDP's automation CLI, including screenshots and input. Its custom NOW command-execution channel is a separate capability with server requirements; ordinary RDP connectivity does not provide a general remote shell. Keep SSH and WinRM as the normal command-execution paths. [IronRDP agent capabilities](https://github.com/Devolutions/IronRDP/tree/master/crates/ironrdp-agent)

## MCP interface and execution behavior

The official Rust MCP SDK provides a direct implementation route. Start with local stdio and add a network interface only when agents on other machines require one. A local MCP process can communicate with the application's session owner, or start an owner without a visible GUI if that lifecycle is supported. [Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk), [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

An initial interface can cover connection discovery, workspace discovery, session opening, command execution, incremental result reading, cancellation, and session closing. These are proposed capabilities, not fixed tool names or an implemented API.

Every execution binds to a connection or session ID. GUI selection must never become an implicit remote target. Agent sessions should be separate from human input streams by default, with a visible activity view and deliberate handoff. Credentials are resolved by the engine; the MCP interface has no secret-export operation.

Long-running commands need operation IDs, bounded output, explicit truncation, timeouts, and cancellation. Preserve command failure separately from connection failure. If transport fails after submitting a mutating command, report an unknown outcome until it can be reconciled; automatic retry can repeat an operation that already ran. Structured outputs are useful for agents, but arbitrary output can itself contain secrets and needs appropriate retention settings. [MCP tool results](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Connection access settings should distinguish discovery, saved-action execution, and general command execution. A universal command tool cannot become safely read-only by matching command names. Constrained remote identities, Kubernetes RBAC, and WinRM JEA endpoints provide real remote enforcement. Application settings are routing controls and do not sandbox an arbitrary process running as the same local user. [Kubernetes RBAC](https://kubernetes.io/docs/reference/access-authn-authz/rbac/), [PowerShell JEA](https://learn.microsoft.com/en-us/powershell/scripting/security/remoting/jea/overview?view=powershell-7.5), [MCP trust boundaries](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/SECURITY.md)

Terminal output and remote content are untrusted data. Keep packaged UI code separate from remote HTML and arbitrary scripts. An agent reading output does not turn instructions embedded in that output into permission to run another operation. [xterm.js integration security](https://xtermjs.org/docs/guides/security/)

## Feasibility checks before committing the stack

| Check | Acceptance evidence | What failure changes |
| --- | --- | --- |
| Embedded RDP | Native protocol connection rendered inside a real pane on Windows and Linux; authentication, input, resize, clipboard, and trust checks pass | Try the alternative RDP engine or rendering route before choosing the UI framework |
| WinRM credentials | Domain and local accounts work from both client operating systems, with documented dependencies | Change the WinRM adapter; preserve the WinRM requirement |
| Interactive PowerShell | Variables/modules/location persist; prompts, completion, errors, progress, and interruption behave predictably | Limit the documented interaction model or use another PSRP adapter; plain command execution is insufficient evidence |
| Kubernetes isolation | Production and staging sessions operate independently; relative certificates and authentication plugins still work | Repair session configuration design before adding graphical cluster features |
| Shared GUI and MCP | Agent operations bind to explicit targets, can be observed and cancelled, and do not alter a human's input stream | Resolve session ownership and operation lifecycle |
| Profile migration | Export on one OS and import on the other; missing bindings are resolved without recreating the layout | Repair the portable schema and binding flow |
| Rendering load | Four active SSH panes and two RDP sessions remain usable during logs, resize, and agent output | Measure the bottleneck and revise buffering or frame delivery; do not infer performance from language choice |

The RDP scenarios should include both X11 and Wayland on Linux where supported. Initial distribution targets should be named explicitly, such as Windows 11 and selected supported Ubuntu/Debian releases, rather than claiming every Linux distribution.

## Proposed release scope

The first complete release includes the established protocols, saved layouts, entry commands, import/export, credential references, isolated Kubernetes sessions, and local MCP execution. It also needs keyboard navigation, accessible labels, readable light/dark themes, reliable connection states, and an agent activity view.

The strongest next additions are runbooks, managed tunnels, diagnostics, and SFTP. These build directly on the session model. They should follow the core interaction and portability checks instead of delaying protocol support.

Remote desktop automation, full secret-vault synchronization, a graphical Kubernetes resource editor, a plugin marketplace, a hosted team service, and mobile clients each add substantial maintenance. Keep them as separate decisions driven by actual use.

For public development, provide a sample library with fictional targets, profile-schema documentation, import compatibility notes, and reproducible Windows/Linux builds. Pin protocol dependencies, preserve license notices, and publish the actual tested compatibility matrix. Keep app-managed credentials out of fixtures, example profiles, diagnostics, and process arguments. Scripts and arbitrary remote output can contain their own sensitive data, so export previews and retention settings remain necessary. Review the distribution model against the selected modules' licenses before publishing binaries.

The next product-design step is to specify three complete journeys: save and reopen a four-pane workspace; move it from Windows to Linux; and let an agent run a scoped action while the user observes it. Those journeys will expose missing behavior more effectively than expanding a generic feature list.

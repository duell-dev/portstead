# Contributing

The first goal is a dependable daily workspace on Windows and Linux. Avoid adding more protocol types before the existing adapters pass their live acceptance checks.

Before opening a pull request, run the checks in the README. Changes to the native/frontend boundary must update the Rust command, TypeScript caller and relevant smoke test together. Use fictional examples; keep actual hosts, kubeconfigs, credential material and generated test artifacts out of Git.

Execution must always identify the intended target. A changed connection must not redirect a stale pane or agent request. No automatic retry is permitted when the remote outcome is unknown. An import must validate before replacing the library, preserve a recoverable backup and require fresh agent grants. Certificate verification must remain on by default.

The next acceptance gates are:

1. Build and launch on a clean Linux desktop; exercise local PTYs, credential storage and Kubernetes context isolation.
2. Connect to a verified non-production RDP server; check NLA, rendering, keyboard layouts, modifier release and mouse input. Implement session reactivation and desktop resize before declaring RDP ready for daily use.
3. Validate WinRM with domain NTLM, local-account NTLM and Kerberos, on both clients. Check state persistence, secure prompts, cancellation, disconnects and server-side cleanup. Replace SDK result collection with bounded streaming before supporting noisy/long-running jobs.
4. Exercise SSH against a non-production host with an agent, host-key trust, a jump host, an entry command and a disconnected network.
5. Test real kubeconfigs with certificate files, exec authentication and concurrent contexts. Confirm the original files never change and snapshots are removed on close.
6. Prepare unsigned Windows/Linux packages and dependency license notices, then document the signing/release process before publishing binaries.

Use small changes with tests that demonstrate user-visible behavior. Explain what was tested live, what was simulated, and which platform remains unchecked.

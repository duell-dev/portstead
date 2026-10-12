import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createIcons, icons } from 'lucide';
import { Connection, Credentials, Library, Operation, Pane, Target, Update, Workspace, decodeFrame, defaultTarget, describe, escapeHtml as e } from './types';

const app = document.querySelector<HTMLDivElement>('#app')!;
const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const kinds: Record<Target['protocol'], string> = { local: 'terminal', ssh: 'server', winrm: 'terminal-square', rdp: 'monitor', kubernetes: 'boxes' };
let library: Library;
let selected = ''; let search = ''; let agents = false;
let theme = localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
document.documentElement.dataset.theme = theme;
const encoder = new TextEncoder();
interface View { node: HTMLElement; connection: Connection; pane: Pane; id?: string; pending?: Promise<string>; terminal?: Terminal; fit?: FitAddon; observer?: ResizeObserver; disposed: boolean; sequence: number }
const views = new Map<string, View>();
function refreshIcons() { createIcons({ icons }); }
function toast(error: unknown) {
  document.querySelector('.toast')?.remove(); const box = document.createElement('div'); box.className = 'toast'; box.role = 'alert'; box.textContent = String(error); document.body.append(box); setTimeout(() => box.remove(), 10000);
}
const catchError = (fn: () => Promise<unknown>) => { void fn().catch(toast); };
function dialog(title: string, body: string, actions: string): HTMLDialogElement {
  const node = document.createElement('dialog');
  node.innerHTML = `<form><div class="dialog-heading"><h2>${e(title)}</h2><button type="button" data-close aria-label="Close">${icon('x')}</button></div>${body}<p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-close>Cancel</button>${actions}</div></form>`;
  node.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => node.close()));
  node.addEventListener('close', () => { node.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input => input.value = ''); node.remove(); });
  document.body.append(node); node.showModal(); refreshIcons(); return node;
}
const field = (label: string, name: string, value = '', type = 'text', required = false) => `<label class="field">${e(label)}<input name="${name}" value="${e(value)}" type="${type}" ${required ? 'required' : ''}></label>`;
function value(form: HTMLFormElement, name: string) { return String(new FormData(form).get(name) || '').trim(); }
function formError(node: HTMLElement, error: unknown) { node.querySelector('.form-error')!.textContent = String(error); }
async function persist(next: Library) { library = await invoke<Library>('save_library', { library: next }); renderSidebar(); }
async function confirmAction(title: string, text: string, button: string): Promise<boolean> {
  return new Promise(resolve => {
    const node = dialog(title, `<p>${e(text)}</p>`, `<button type="submit" class="primary">${e(button)}</button>`);
    let accepted = false; node.querySelector('form')!.onsubmit = event => { event.preventDefault(); accepted = true; node.close(); };
    node.addEventListener('close', () => resolve(accepted));
  });
}

function shell() {
  app.innerHTML = `<div class="shell"><header class="appbar"><div class="brand"><span class="brandmark">›_</span>Portstead <span class="badge">Prototype</span></div><div class="actions"><button id="import">${icon('download')}Import</button><button id="export">${icon('upload')}Export</button><button id="agents">${icon('bot')}Agents off</button><button id="theme" aria-label="Change theme">${icon('sun-moon')}</button></div></header><aside class="sidebar"><input id="search" class="search" placeholder="Find a connection or workspace" aria-label="Search connections and workspaces"><div class="section-label">Workspaces<button id="new-workspace" aria-label="New workspace">${icon('plus')}</button></div><nav id="workspaces" aria-label="Workspaces"></nav><div class="section-label">Connections<button id="new-connection" aria-label="New connection">${icon('plus')}</button></div><nav id="connections" aria-label="Connections"></nav><button id="import-kube" class="nav-item muted">${icon('file-key')}Import kubeconfig</button></aside><main class="main"><div id="workspace-heading" class="workspace-heading"></div><div id="panes" class="panes"></div><section class="activity"><button id="activity-toggle" class="activity-summary">${icon('activity')}Execution activity</button><div id="operations" hidden></div></section></main><footer class="footer"><span id="session-count">Ready</span><span>Profiles stay on this device · Credentials use your OS store</span></footer></div>`;
  document.querySelector<HTMLInputElement>('#search')!.oninput = event => { search = (event.target as HTMLInputElement).value.toLowerCase(); renderSidebar(); };
  document.querySelector('#new-connection')!.addEventListener('click', () => editConnection());
  document.querySelector('#new-workspace')!.addEventListener('click', () => editWorkspace());
  document.querySelector('#theme')!.addEventListener('click', () => { theme = theme === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); for (const view of views.values()) if (view.terminal) view.terminal.options.theme = terminalTheme(); });
  document.querySelector('#import')!.addEventListener('click', () => catchError(importProfiles));
  document.querySelector('#export')!.addEventListener('click', () => catchError(async () => { const path = await save({ defaultPath: 'portstead-profiles.json', filters: [{ name: 'Profiles', extensions: ['json'] }] }); if (path) await invoke('export_library', { path }); }));
  document.querySelector('#import-kube')!.addEventListener('click', () => catchError(importKube));
  document.querySelector('#agents')!.addEventListener('click', () => catchError(showAgents));
  document.querySelector('#activity-toggle')!.addEventListener('click', () => { const body = document.querySelector<HTMLElement>('#operations')!; body.hidden = !body.hidden; });
  renderSidebar(); renderWorkspace(); refreshIcons();
}

function renderSidebar() {
  const match = (text: string) => text.toLowerCase().includes(search);
  const ws = document.querySelector('#workspaces')!;
  ws.innerHTML = library.workspaces.filter(w => match(w.name)).map(w => `<button class="nav-item" data-id="${e(w.id)}" aria-current="${w.id === selected}">${icon('panels-top-left')}<span class="nav-copy"><span>${e(w.name)}</span><small>${w.panes.length} ${w.panes.length === 1 ? 'pane' : 'panes'}</small></span></button>`).join('');
  ws.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => { selected = button.dataset.id!; renderSidebar(); renderWorkspace(); });
  const list = document.querySelector('#connections')!;
  list.innerHTML = library.connections.filter(c => match(`${c.name} ${c.group} ${describe(c.target)}`)).map(c => `<button class="nav-item" data-id="${e(c.id)}">${icon(kinds[c.target.protocol])}<span class="nav-copy"><span>${e(c.name)}</span><small>${e(c.target.protocol.toUpperCase())}${c.group ? ' · ' + e(c.group) : ''}</small></span></button>`).join('');
  list.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => editConnection(library.connections.find(c => c.id === button.dataset.id)));
  refreshIcons();
}

function renderWorkspace() {
  const workspace = library.workspaces.find(w => w.id === selected);
  const heading = document.querySelector('#workspace-heading')!; const container = document.querySelector<HTMLElement>('#panes')!;
  container.replaceChildren();
  if (!workspace) { heading.innerHTML = ''; container.innerHTML = `<div class="empty"><h2>Your working setup, saved</h2><p>Create a workspace with the connections and entry commands you use together.</p><button class="primary" id="empty-new">New workspace</button></div>`; document.querySelector('#empty-new')!.addEventListener('click', () => editWorkspace()); return; }
  heading.innerHTML = `<div><h1>${e(workspace.name)}</h1><div class="workspace-description">Saved layout · ${workspace.panes.length} ${workspace.panes.length === 1 ? 'pane' : 'panes'} · Entry commands run when opened</div></div><div class="actions"><button id="edit-workspace">${icon('sliders-horizontal')}Edit layout</button><button id="stop-workspace" aria-label="Close workspace sessions">${icon('square')}</button><button class="primary" id="launch-workspace">${icon('play')}Open workspace</button></div>`;
  container.dataset.count = String(workspace.panes.length);
  workspace.panes.forEach((pane, index) => {
    const key = `${workspace.id}:${index}`; let view = views.get(key);
    const saved = library.connections.find(c => c.id === pane.connection_id)!;
    if (view && !view.id && JSON.stringify(view.connection) !== JSON.stringify(saved)) { view.terminal?.dispose(); views.delete(key); view = undefined; }
    if (!view) { view = makeView(pane); views.set(key, view); }
    container.append(view.node); requestAnimationFrame(() => view?.fit?.fit());
  });
  document.querySelector('#edit-workspace')!.addEventListener('click', () => editWorkspace(workspace));
  document.querySelector('#launch-workspace')!.addEventListener('click', () => catchError(async () => {
    const cache = new Map<string, Credentials>();
    try { for (let i = 0; i < workspace.panes.length; i++) { const view = views.get(`${workspace.id}:${i}`)!; if (!view.id) { let credentials = cache.get(view.connection.id); if (!credentials) { credentials = await getCredentials(view.connection); cache.set(view.connection.id, credentials); } await launch(view, credentials); } } }
    finally { for (const credentials of cache.values()) credentials.password = ''; }
  }));
  document.querySelector('#stop-workspace')!.addEventListener('click', () => catchError(async () => { await closeWorkspace(workspace.id); renderWorkspace(); }));
  refreshIcons();
}

function makeView(pane: Pane): View {
  const connection = library.connections.find(c => c.id === pane.connection_id)!;
  const node = document.createElement('section'); node.className = 'pane'; node.setAttribute('aria-label', `${pane.title || connection.name}: ${describe(connection.target)}`);
  node.innerHTML = `<div class="pane-header"><div><div class="pane-title">${e(pane.title || connection.name)}</div><div class="pane-target">${e(describe(connection.target))}</div></div><div class="actions"><span class="status" data-status="idle">Idle</span><button data-run aria-label="Run a command">${icon('terminal')}</button><button data-stop aria-label="Close session" disabled>${icon('x')}</button></div></div><div class="pane-content"><div class="pane-placeholder">${icon(kinds[connection.target.protocol])}<span class="muted">${e(connection.target.protocol.toUpperCase())}</span>${pane.entry_command ? `<code class="entry">${e(pane.entry_command)}</code>` : ''}<button class="secondary" data-connect>Connect</button></div></div>`;
  const view: View = { node, connection: structuredClone(connection), pane: structuredClone(pane), disposed: false, sequence: 0 };
  node.querySelector('[data-connect]')!.addEventListener('click', () => catchError(async () => { const credentials = await getCredentials(view.connection); try { await launch(view, credentials); } finally { credentials.password = ''; } }));
  node.querySelector('[data-stop]')!.addEventListener('click', () => catchError(async () => { await stop(view); renderWorkspace(); }));
  const run = node.querySelector<HTMLButtonElement>('[data-run]')!; run.disabled = connection.target.protocol === 'rdp'; run.addEventListener('click', () => commandDialog(view.connection));
  return view;
}

function terminalTheme() { const style = getComputedStyle(document.documentElement); return { background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--fg').trim(), cursor: style.getPropertyValue('--accent').trim() }; }
async function launch(view: View, credentials: Credentials) {
  if (view.id || view.pending || view.disposed) return;
  const content = view.node.querySelector<HTMLElement>('.pane-content')!; content.replaceChildren();
  let size = { cols: 100, rows: 30 };
  if (view.connection.target.protocol !== 'rdp') {
    const node = document.createElement('div'); node.className = 'terminal'; content.append(node);
    view.terminal = new Terminal({ fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 13, scrollback: 5000, theme: terminalTheme(), cursorBlink: true, allowProposedApi: false });
    view.fit = new FitAddon(); view.terminal.loadAddon(view.fit); view.terminal.open(node); view.fit.fit(); size = { cols: view.terminal.cols, rows: view.terminal.rows };
    if (view.connection.target.protocol !== 'winrm') view.terminal.onData(data => { if (view.id) catchError(() => invoke('session_write', { id: view.id, data: Array.from(encoder.encode(data)) })); });
  }
  try { view.pending = invoke<string>('open_session', { connectionId: view.connection.id, expectedTarget: view.connection.target, entry: view.pane.entry_command, credentials, size }); view.id = await view.pending; }
  catch (error) { view.terminal?.dispose(); view.terminal = undefined; content.innerHTML = `<div class="pane-placeholder"><p class="pane-error">${e(String(error))}</p><button class="secondary" data-retry>Try again</button></div>`; content.querySelector('[data-retry]')!.addEventListener('click', () => catchError(async () => { const c = await getCredentials(view.connection); try { await launch(view, c); } finally { c.password = ''; } })); throw error; }
  finally { view.pending = undefined; }
  if (view.disposed) return;
  view.node.querySelector<HTMLButtonElement>('[data-stop]')!.disabled = false;
  if (view.connection.target.protocol === 'rdp') { const canvas = document.createElement('canvas'); canvas.className = 'desktop-canvas'; canvas.tabIndex = 0; canvas.setAttribute('aria-label', 'Remote desktop; click to send keyboard and mouse input'); content.append(canvas); desktopInput(view, canvas); }
  if (view.connection.target.protocol === 'winrm') {
    const form = document.createElement('form'); form.className = 'ps-input'; form.innerHTML = '<input aria-label="PowerShell command" placeholder="Enter a PowerShell command" autocomplete="off"><button type="submit">Run</button><button type="button" data-interrupt>Stop</button>'; view.node.append(form);
    form.onsubmit = event => { event.preventDefault(); const input = form.querySelector('input')!; const command = input.value; input.value = ''; view.terminal?.writeln(command); catchError(() => invoke('session_write', { id: view.id, data: Array.from(encoder.encode(command)) })); };
    form.querySelector('[data-interrupt]')!.addEventListener('click', () => catchError(() => invoke('session_write', { id: view.id, data: [3] })));
  }
  view.observer = new ResizeObserver(() => { if (view.id && view.fit && content.clientHeight > 0) { view.fit.fit(); catchError(() => invoke('session_resize', { id: view.id, size: { cols: view.terminal!.cols, rows: view.terminal!.rows } })); } }); view.observer.observe(content);
  void poll(view); updateCount();
}

async function poll(view: View) {
  while (view.id && !view.disposed) {
    try {
      const update = await invoke<Update>('session_poll', { id: view.id });
      const status = view.node.querySelector<HTMLElement>('.status')!; status.textContent = update.status; status.dataset.status = update.status;
      if (update.data.length) view.terminal?.write(new Uint8Array(update.data));
      if (update.dropped_bytes) view.terminal?.writeln(`\r\n[${update.dropped_bytes} bytes omitted while the display was busy]`);
      if (update.error) { let error = view.node.querySelector<HTMLElement>('.pane-error'); if (!error) { error = document.createElement('p'); error.className = 'pane-error'; view.node.querySelector('.pane-content')!.append(error); } error.textContent = update.error; }
      if (update.prompt && !view.node.querySelector('.ps-prompt')) {
        const form = document.createElement('form'); form.className = 'ps-prompt'; form.innerHTML = `<label class="field">${e(update.prompt.label)}<input type="${update.prompt.secret ? 'password' : 'text'}" autocomplete="off" aria-label="PowerShell prompt response"></label><button type="submit" class="secondary">Send response</button>`; view.node.append(form);
        form.onsubmit = event => { event.preventDefault(); const input = form.querySelector('input')!; const text = input.value; input.value = ''; form.remove(); catchError(() => invoke('session_write', { id: view.id, data: Array.from(encoder.encode(text)) })); };
      }
      if (!update.prompt) view.node.querySelector('.ps-prompt')?.remove();
      view.node.querySelectorAll<HTMLInputElement | HTMLButtonElement>('.ps-input input, .ps-input button[type=submit]').forEach(control => control.disabled = !!update.prompt || update.status !== 'running');
      if (view.connection.target.protocol === 'rdp' && view.node.isConnected) {
        const buffer = await invoke<ArrayBuffer>('desktop_frame', { id: view.id, sequence: view.sequence }); const frame = decodeFrame(buffer);
        if (frame) { const canvas = view.node.querySelector('canvas')!; canvas.width = frame.width; canvas.height = frame.height; canvas.getContext('2d')!.putImageData(new ImageData(frame.pixels, frame.width, frame.height), 0, 0); view.sequence = frame.sequence; }
      }
      if (update.status === 'exited' || update.status === 'failed') break;
    } catch (error) { if (!view.disposed) toast(error); break; }
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

async function stop(view: View) { view.disposed = true; const id = view.id || await view.pending?.catch(() => undefined); if (id) await invoke('session_close', { id }); view.id = undefined; view.observer?.disconnect(); view.terminal?.dispose(); for (const [key, candidate] of views) if (candidate === view) views.delete(key); updateCount(); }
async function closeWorkspace(id: string) { for (const [key, view] of [...views]) if (key.startsWith(id + ':')) await stop(view); }
function updateCount() { const count = [...views.values()].filter(v => v.id).length; document.querySelector('#session-count')!.textContent = count ? `${count} open ${count === 1 ? 'session' : 'sessions'}` : 'Ready'; }

const scanCodes: Record<string, number> = { Escape:1, Digit1:2, Digit2:3, Digit3:4, Digit4:5, Digit5:6, Digit6:7, Digit7:8, Digit8:9, Digit9:10, Digit0:11, Backspace:14, Tab:15, KeyQ:16, KeyW:17, KeyE:18, KeyR:19, KeyT:20, KeyY:21, KeyU:22, KeyI:23, KeyO:24, KeyP:25, Enter:28, ControlLeft:29, KeyA:30, KeyS:31, KeyD:32, KeyF:33, KeyG:34, KeyH:35, KeyJ:36, KeyK:37, KeyL:38, ShiftLeft:42, KeyZ:44, KeyX:45, KeyC:46, KeyV:47, KeyB:48, KeyN:49, KeyM:50, ShiftRight:54, AltLeft:56, Space:57, CapsLock:58, F1:59, F2:60, F3:61, F4:62, F5:63, F6:64, F7:65, F8:66, F9:67, F10:68, F11:87, F12:88, ArrowUp:72, ArrowLeft:75, ArrowRight:77, ArrowDown:80, Home:71, End:79, PageUp:73, PageDown:81, Insert:82, Delete:83, ControlRight:29, AltRight:56, MetaLeft:91, MetaRight:92 };
function desktopInput(view: View, canvas: HTMLCanvasElement) {
  const send = (input: object) => { if (view.id) catchError(() => invoke('desktop_input', { id: view.id, input })); };
  const pressed = new Map<string, { code: number; extended: boolean }>();
  canvas.addEventListener('keydown', event => {
    event.preventDefault();
    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) { send({ kind: 'text', text: event.key }); return; }
    const code = scanCodes[event.code]; if (code === undefined) return;
    const extended = /Arrow|Home|End|Page|Insert|Delete|Right$|Meta/.test(event.code) && event.code !== 'ShiftRight'; pressed.set(event.code, { code, extended }); send({ kind: 'key', code, extended, down: true });
  });
  canvas.addEventListener('keyup', event => { event.preventDefault(); const key = pressed.get(event.code); if (key) { send({ kind: 'key', ...key, down: false }); pressed.delete(event.code); } });
  canvas.addEventListener('blur', () => { for (const key of pressed.values()) send({ kind: 'key', ...key, down: false }); pressed.clear(); });
  const coords = (event: MouseEvent) => { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(canvas.width - 1, Math.round((event.clientX - rect.left) * canvas.width / rect.width))), y: Math.max(0, Math.min(canvas.height - 1, Math.round((event.clientY - rect.top) * canvas.height / rect.height))) }; };
  let lastMove = 0; canvas.addEventListener('mousemove', event => { if (performance.now() - lastMove > 20) { send({ kind: 'mouse', ...coords(event) }); lastMove = performance.now(); } });
  const button = (event: MouseEvent) => event.button === 0 ? 1 : event.button === 2 ? 2 : 3;
  canvas.addEventListener('pointerdown', event => { event.preventDefault(); canvas.focus(); canvas.setPointerCapture(event.pointerId); send({ kind: 'mouse', ...coords(event), button: button(event), down: true }); });
  canvas.addEventListener('pointerup', event => { send({ kind: 'mouse', ...coords(event), button: button(event), down: false }); canvas.releasePointerCapture(event.pointerId); });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener('wheel', event => { event.preventDefault(); send({ kind: 'mouse', ...coords(event), wheel: -Math.sign(event.deltaY) * 120 }); }, { passive: false });
}

async function getCredentials(connection: Connection): Promise<Credentials> {
  const empty = { username: '', domain: '', password: '', remember: false };
  if (connection.target.protocol !== 'rdp' && connection.target.protocol !== 'winrm') return empty;
  const info = await invoke<{ stored: boolean; username: string }>('auth_info', { connectionId: connection.id, expectedTarget: connection.target });
  if (info.stored || connection.target.protocol === 'winrm' && connection.target.auth === 'kerberos') return empty;
  return new Promise((resolve, reject) => {
    const target = connection.target as Extract<Target, { protocol: 'rdp' | 'winrm' }>;
    const node = dialog(`Sign in to ${connection.name}`, `<p class="muted">${e(describe(target))}</p>${field('Username', 'username', info.username || target.username, 'text', true)}${field('Domain (optional)', 'domain', target.domain)}${field('Password', 'password', '', 'password', true)}<label class="check"><input name="remember" type="checkbox"><span>Remember in this device's operating-system credential store</span></label>`, '<button class="primary" type="submit">Connect</button>');
    let completed = false;
    node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); const form = event.target as HTMLFormElement; const data = { username: value(form, 'username'), domain: value(form, 'domain'), password: (form.elements.namedItem('password') as HTMLInputElement).value, remember: new FormData(form).has('remember') };
      try { if (data.remember) { const next = structuredClone(library); const saved = next.connections.find(c => c.id === connection.id)!; if (saved.target.protocol === 'rdp' || saved.target.protocol === 'winrm') { saved.target.username = data.username; saved.target.domain = data.domain; await persist(next); connection.target = structuredClone(saved.target); } } completed = true; node.close(); resolve(data); }
      catch (error) { formError(node, error); }
    };
    node.addEventListener('close', () => { if (!completed) reject(new Error('Sign-in cancelled')); });
  });
}

function editConnection(existing?: Connection) {
  const draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: '', group: '', agent_access: false, target: defaultTarget('ssh') };
  const node = dialog(existing ? 'Connection settings' : 'New connection', `${field('Name', 'name', draft.name, 'text', true)}<div class="field-row">${field('Group', 'group', draft.group)}<label class="field">Connection type<select name="protocol">${Object.keys(kinds).map(kind => `<option value="${kind}" ${kind === draft.target.protocol ? 'selected' : ''}>${kind.toUpperCase()}</option>`).join('')}</select></label></div><div id="target-fields"></div><label class="check"><input type="checkbox" name="agent_access" ${draft.agent_access ? 'checked' : ''}><span>Allow agents to execute commands using this connection's account</span></label>${existing && ['rdp', 'winrm'].includes(existing.target.protocol) ? '<button type="button" class="secondary" data-forget>Forget saved password on this device</button>' : ''}${existing?.target.protocol === 'rdp' ? '<button type="button" class="secondary" data-probe>Check server certificate</button><p data-probe-result class="muted"></p>' : ''}`, `${existing ? '<button type="button" class="danger" data-delete>Delete</button>' : ''}<button type="submit" class="primary">Save connection</button>`);
  const targetFields = () => {
    const t = draft.target; let markup = '';
    if (t.protocol === 'local') markup = field('Shell executable (empty uses the default)', 'shell', t.shell || '');
    else if (t.protocol === 'kubernetes') markup = field('Kubeconfig source on this device', 'source', t.source, 'text', true) + field('Context', 'context', t.context, 'text', true) + field('Namespace', 'namespace', t.namespace);
    else { markup = `<div class="field-row">${field('Host or SSH alias', 'host', t.host, 'text', true)}${field('Port', 'port', String(t.port), 'number', true)}</div>` + field('Username', 'username', t.username);
      if (t.protocol === 'ssh') markup += field('Identity file (optional)', 'identity_file', t.identity_file || '');
      else { markup += field('Domain (optional)', 'domain', t.domain); if (t.protocol === 'rdp') markup += field('Trusted certificate SHA-256 (optional)', 'certificate_sha256', t.certificate_sha256 || '') + '<p class="muted">Uses normal certificate verification unless you provide an independently verified fingerprint.</p>';
        else markup += `<label class="field">Authentication<select name="auth"><option value="ntlm" ${t.auth === 'ntlm' ? 'selected' : ''}>NTLM · username and password</option><option value="kerberos" ${t.auth === 'kerberos' ? 'selected' : ''}>Kerberos · current identity / ticket</option></select></label><label class="check"><input type="checkbox" name="tls" ${t.tls ? 'checked' : ''}>Use HTTPS</label>`;
      }
    }
    const pathField = t.protocol === 'kubernetes' ? 'source' : t.protocol === 'ssh' ? 'identity_file' : t.protocol === 'local' ? 'shell' : null;
    if (pathField) markup += `<button type="button" class="secondary" data-file="${pathField}">Choose local file</button><p class="muted">File locations stay on this device. After importing a profile, replace its local:// reference with the matching file here.</p>`;
    node.querySelector('#target-fields')!.innerHTML = markup;
    node.querySelector<HTMLButtonElement>('[data-file]')?.addEventListener('click', () => catchError(async () => { const path = await open(); if (typeof path === 'string') node.querySelector<HTMLInputElement>(`[name=${pathField}]`)!.value = path; }));
  };
  targetFields(); node.querySelector<HTMLSelectElement>('[name=protocol]')!.onchange = event => { draft.target = defaultTarget((event.target as HTMLSelectElement).value as Target['protocol']); targetFields(); };
  node.querySelector('[data-forget]')?.addEventListener('click', () => catchError(async () => { await invoke('forget_credential', { connectionId: draft.id }); formError(node, 'Saved app password removed. Windows RDP credentials managed outside this app are retained.'); }));
  node.querySelector('[data-probe]')?.addEventListener('click', () => catchError(async () => { const result = node.querySelector('[data-probe-result]')!; result.textContent = 'Checking the saved server address…'; const check = await invoke<{ verified: boolean; detail: string }>('rdp_probe', { connectionId: draft.id }); result.textContent = check.detail; }));
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); const form = event.target as HTMLFormElement; const protocol = draft.target.protocol; let target: Target;
    if (protocol === 'local') target = { protocol, shell: value(form, 'shell') || null };
    else if (protocol === 'kubernetes') target = { protocol, source: value(form, 'source'), context: value(form, 'context'), namespace: value(form, 'namespace') };
    else { const base = { protocol, host: value(form, 'host'), username: value(form, 'username'), port: Number(value(form, 'port')) };
      if (protocol === 'ssh') target = { ...base, protocol, identity_file: value(form, 'identity_file') || null };
      else if (protocol === 'rdp') target = { ...base, protocol, domain: value(form, 'domain'), certificate_sha256: value(form, 'certificate_sha256').replace(/[:\s]/g, '') || null };
      else target = { ...base, protocol, domain: value(form, 'domain'), tls: new FormData(form).has('tls'), auth: value(form, 'auth') as 'ntlm' | 'kerberos' };
    }
    try { const next = structuredClone(library); const saved: Connection = { id: draft.id, name: value(form, 'name'), group: value(form, 'group'), agent_access: new FormData(form).has('agent_access'), target }; const index = next.connections.findIndex(c => c.id === draft.id); if (index < 0) next.connections.push(saved); else next.connections[index] = saved; await persist(next); node.close(); renderWorkspace(); }
    catch (error) { formError(node, error); }
  };
  node.querySelector('[data-delete]')?.addEventListener('click', () => catchError(async () => {
    if (library.workspaces.some(w => w.panes.some(p => p.connection_id === draft.id))) { formError(node, 'Remove this connection from its workspace layouts before deleting it.'); return; }
    if (await confirmAction('Delete connection', `Delete ${draft.name}?`, 'Delete')) { const next = structuredClone(library); next.connections = next.connections.filter(c => c.id !== draft.id); await persist(next); node.close(); }
  }));
}

function editWorkspace(existing?: Workspace) {
  if (!library.connections.length) { editConnection(); return; }
  const draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: '', panes: [{ connection_id: library.connections[0].id, title: '', entry_command: '' }] };
  const node = dialog(existing ? 'Edit workspace layout' : 'New workspace', `${field('Workspace name', 'name', draft.name, 'text', true)}<div id="pane-editors"></div><button type="button" class="secondary" data-add>${icon('plus')}Add pane</button>`, `${existing ? '<button type="button" class="danger" data-delete>Delete workspace</button>' : ''}<button type="submit" class="primary">Save workspace</button>`);
  const capture = () => { draft.name = value(node.querySelector('form')!, 'name'); node.querySelectorAll<HTMLElement>('.pane-editor').forEach((row, i) => { draft.panes[i] = { connection_id: row.querySelector('select')!.value, title: row.querySelector<HTMLInputElement>('[data-title]')!.value, entry_command: row.querySelector('textarea')!.value }; }); };
  const render = () => {
    node.querySelector('#pane-editors')!.innerHTML = draft.panes.map((p, i) => `<div class="pane-editor"><div class="field-row"><label class="field">Pane ${i + 1} connection<select>${library.connections.map(c => `<option value="${e(c.id)}" ${p.connection_id === c.id ? 'selected' : ''}>${e(c.name)}</option>`).join('')}</select></label><button type="button" data-remove="${i}" aria-label="Remove pane ${i + 1}" ${draft.panes.length === 1 ? 'disabled' : ''}>${icon('x')}</button></div><label class="field">Pane title<input data-title value="${e(p.title)}" placeholder="Connection name"></label><label class="field">Entry command<textarea placeholder="Optional command to run after connecting">${e(p.entry_command)}</textarea></label></div>`).join('');
    node.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.onclick = () => { capture(); draft.panes.splice(Number(button.dataset.remove), 1); render(); });
    node.querySelector<HTMLButtonElement>('[data-add]')!.disabled = draft.panes.length === 4; refreshIcons();
  };
  render(); node.querySelector('[data-add]')!.addEventListener('click', () => { capture(); draft.panes.push({ connection_id: draft.panes.at(-1)!.connection_id, title: '', entry_command: '' }); render(); });
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); capture(); try {
    if ([...views.entries()].some(([key, v]) => key.startsWith(draft.id + ':') && v.id) && !await confirmAction('Apply workspace changes', 'Applying this layout closes its currently open sessions.', 'Apply and close sessions')) return;
    const next = structuredClone(library); const index = next.workspaces.findIndex(w => w.id === draft.id); if (index < 0) next.workspaces.push(draft); else next.workspaces[index] = draft;
    await persist(next); await closeWorkspace(draft.id); selected = draft.id; node.close(); renderSidebar(); renderWorkspace();
  } catch (error) { formError(node, error); } };
  node.querySelector('[data-delete]')?.addEventListener('click', () => catchError(async () => { if (await confirmAction('Delete workspace', 'This removes the saved layout and closes its sessions.', 'Delete workspace')) { const next = structuredClone(library); next.workspaces = next.workspaces.filter(w => w.id !== draft.id); await persist(next); await closeWorkspace(draft.id); selected = library.workspaces[0]?.id || ''; node.close(); renderSidebar(); renderWorkspace(); } }));
}

async function importProfiles() {
  const path = await open({ filters: [{ name: 'Profiles', extensions: ['json'] }] }); if (typeof path !== 'string') return;
  const incoming = await invoke<Library>('import_library', { path });
  if (!await confirmAction('Import profile library', `Replace the current profiles with ${incoming.connections.length} connections and ${incoming.workspaces.length} workspaces and close open sessions? A backup is kept. Agent permissions will be off. Review entry commands and bind local files before connecting.`, 'Replace profiles')) return;
  incoming.connections.forEach(connection => connection.agent_access = false);
  incoming.revision = library.revision; await persist(incoming); for (const view of [...views.values()]) await stop(view); selected = library.workspaces[0]?.id || ''; renderSidebar(); renderWorkspace();
}
async function importKube() {
  const path = await open({ filters: [{ name: 'Kubeconfig', extensions: ['*'] }] }); if (typeof path !== 'string') return;
  const incoming = await invoke<{ connections: Connection[]; warnings: string[] }>('import_kubeconfig', { path });
  const node = dialog('Import Kubernetes contexts', `<p>${incoming.connections.length} contexts found. Authentication remains attached to this source on this device.</p><div class="import-list">${incoming.connections.map(c => `<p>${e(c.name)} · ${e(describe(c.target))}</p>`).join('')}${incoming.warnings.map(w => `<p>${e(w)}</p>`).join('')}</div>`, '<button type="submit" class="primary">Import contexts</button>');
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); try { const next = structuredClone(library); next.connections.push(...incoming.connections); await persist(next); node.close(); } catch (error) { formError(node, error); } };
}

function commandDialog(connection: Connection) {
  const node = dialog(`Run on ${connection.name}`, `<p class="muted">${e(describe(connection.target))}</p><label class="field">Command<textarea name="command" required placeholder="Command to execute on this target"></textarea></label>`, '<button class="primary" type="submit">Run command</button>');
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); try { const credentials = await getCredentials(connection); try { await invoke('run_command', { connectionId: connection.id, expectedTarget: connection.target, command: value(event.target as HTMLFormElement, 'command'), credentials }); } finally { credentials.password = ''; } node.close(); document.querySelector<HTMLElement>('#operations')!.hidden = false; await activity(); } catch (error) { formError(node, error); } };
}
async function showAgents() {
  if (agents) { if (await confirmAction('Disable local agents', 'This disconnects MCP clients and requests cancellation of active agent commands.', 'Disable agents')) { await invoke('disable_agents'); agents = false; document.querySelector('#agents')!.innerHTML = icon('bot') + 'Agents off'; refreshIcons(); } return; }
  const info = await invoke<{ port: number; executable: string; profile_directory: string }>('enable_agents'); agents = true; document.querySelector('#agents')!.innerHTML = icon('bot') + 'Agents on'; refreshIcons();
  const config = JSON.stringify({ mcpServers: { portstead: { command: info.executable, args: ['--mcp'], env: { PORTSTEAD_HOME: info.profile_directory } } } }, null, 2);
  const node = dialog('Connect your agents', `<p>Local MCP access is enabled. Allow command execution for each connection in its settings.</p><label class="field">MCP client configuration<textarea readonly rows="8">${e(config)}</textarea></label><p class="muted">Agent commands appear in Execution activity. Turning Agents off stops new requests and cancels active agent commands.</p>`, '<button type="submit" class="primary">Done</button>');
  node.querySelector('form')!.onsubmit = event => { event.preventDefault(); node.close(); };
}
let activityBusy = false;
async function activity() {
  if (activityBusy || !library) return; activityBusy = true;
  try { const operations = await invoke<Operation[]>('operations_list'); const container = document.querySelector('#operations'); if (!container) return;
    container.innerHTML = operations.slice(-12).reverse().map(op => `<div class="operation"><div class="operation-head"><span>${e(op.connection_name)} · ${e(describe(op.target))} · ${e(op.actor)} · ${e(op.status)}</span>${op.status === 'running' ? `<button data-cancel="${e(op.id)}">Stop</button>` : ''}</div><code>${e(op.command)}</code>${op.stdout || op.stderr ? `<pre>${e(op.stdout)}${op.stderr ? '\n' + e(op.stderr) : ''}</pre>` : ''}${op.truncated ? '<span class="muted">Output was truncated.</span>' : ''}</div>`).join('') || '<p class="muted">Commands run by you and your agents appear here.</p>';
    container.querySelectorAll<HTMLButtonElement>('[data-cancel]').forEach(button => button.onclick = () => catchError(() => invoke('operation_cancel', { id: button.dataset.cancel })));
  } finally { activityBusy = false; }
}

document.addEventListener('keydown', event => { if (!event.defaultPrevented && (event.ctrlKey || event.metaKey) && event.key === 'k') { event.preventDefault(); document.querySelector<HTMLInputElement>('#search')?.focus(); } });
invoke<Library>('load_library').then(loaded => { library = loaded; selected = library.workspaces[0]?.id || ''; shell(); setInterval(() => { void activity().catch(() => {}); }, 1000); })
  .catch(error => { app.innerHTML = `<div class="empty" style="padding-top:25vh"><h2>Could not load your profiles</h2><p>${e(String(error))}</p><p>Launch the native desktop app to use Portstead.</p><button class="secondary" onclick="location.reload()">Reload</button></div>`; });

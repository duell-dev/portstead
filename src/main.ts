import './style.css';
import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { createIcons, icons } from 'lucide';
import { Connection, Credentials, Library, Operation, Pane, Target, Update, Workspace, decodeFrame, defaultTarget, describe, protocolLabel, escapeHtml as e } from './types';
import { HierarchyNode, allNodes, groupPath, hierarchy, inGroup, moveGroup, parentGroup, radialLayout } from './hierarchy';

const app = document.querySelector<HTMLDivElement>('#app')!;
const icon = (name: string) => `<i data-lucide="${name}" aria-hidden="true"></i>`;
const kinds: Record<Target['protocol'], string> = { local: 'terminal', ssh: 'server', winrm: 'terminal-square', rdp: 'monitor', kubernetes: 'boxes', web: 'globe' };
let library: Library;
let selected = ''; let search = ''; let agents = false;
let page: 'workspace' | 'map' = 'map';
let mapMode: 'global' | 'focused' = 'global';
let focusFolder = ''; let mapSelection = 'folder:';
const collapsedFolders = new Set<string>();
let mapResize: ResizeObserver | undefined;
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
async function persist(next: Library) { library = await invoke<Library>('save_library', { library: next }); renderSidebar(); if (page === 'map') renderMap(); }
async function confirmAction(title: string, text: string, button: string): Promise<boolean> {
  return new Promise(resolve => {
    const node = dialog(title, `<p>${e(text)}</p>`, `<button type="submit" class="primary">${e(button)}</button>`);
    let accepted = false; node.querySelector('form')!.onsubmit = event => { event.preventDefault(); accepted = true; node.close(); };
    node.addEventListener('close', () => resolve(accepted));
  });
}

function shell() {
  app.innerHTML = `<div class="shell"><header class="appbar"><div class="brand"><span class="brandmark">›_</span>Portstead <span class="badge">Prototype</span></div><div class="actions"><button id="import">${icon('download')}Import</button><button id="export">${icon('upload')}Export</button><button id="agents">${icon('bot')}Agents off</button><button id="theme" aria-label="Change theme">${icon('sun-moon')}</button></div></header><aside class="sidebar"><input id="search" class="search" placeholder="Find a connection or workspace" aria-label="Search connections and workspaces"><button id="show-map" class="nav-item">${icon('network')}Connection map</button><div class="section-label">Workspaces<button id="new-workspace" aria-label="New workspace">${icon('plus')}</button></div><nav id="workspaces" aria-label="Workspaces"></nav><div class="section-label">Folders & connections<button id="new-connection" aria-label="New connection">${icon('plus')}</button></div><nav id="connections" aria-label="Folder hierarchy"></nav><button id="new-folder" class="nav-item muted">${icon('folder-plus')}New folder</button><button id="import-kube" class="nav-item muted">${icon('file-key')}Import kubeconfig</button></aside><main class="main"><section id="organization" class="organization"></section><div id="workspace-heading" class="workspace-heading"></div><div id="panes" class="panes"></div><section class="activity"><button id="activity-toggle" class="activity-summary">${icon('activity')}Execution activity</button><div id="operations" hidden></div></section></main><footer class="footer"><span id="session-count">Ready</span><span>Profiles stay on this device · Credentials use your OS store</span></footer></div>`;
  document.querySelector<HTMLInputElement>('#search')!.oninput = event => { search = (event.target as HTMLInputElement).value.toLowerCase(); renderSidebar(); if (page === 'map') renderMap(); };
  document.querySelector('#show-map')!.addEventListener('click', () => { page = 'map'; renderSidebar(); renderWorkspace(); });
  document.querySelector('#new-folder')!.addEventListener('click', () => editFolder());
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
  ws.innerHTML = library.workspaces.filter(w => match(`${w.name} ${w.group || ''}`)).map(w => `<button class="nav-item" data-id="${e(w.id)}" aria-current="${page === 'workspace' && w.id === selected}">${icon('panels-top-left')}<span class="nav-copy"><span>${e(w.name)}</span><small>${w.panes.length} ${w.panes.length === 1 ? 'pane' : 'panes'}</small></span></button>`).join('');
  ws.querySelectorAll<HTMLButtonElement>('button').forEach(button => button.onclick = () => { page = 'workspace'; selected = button.dataset.id!; renderSidebar(); renderWorkspace(); });
  document.querySelector('#show-map')!.setAttribute('aria-current', String(page === 'map'));
  const list = document.querySelector('#connections')!;
  const root = searchHierarchy();
  const row = (node: HierarchyNode): string => {
    if (node.kind === 'workspace') return '';
    if (node.kind === 'connection') {
      const connection = library.connections.find(c => 'connection:' + c.id === node.id)!;
      return `<li><button class="nav-item tree-connection" data-node="${e(node.id)}" aria-current="${page === 'map' && mapSelection === node.id}">${icon(kinds[connection.target.protocol])}<span class="nav-copy"><span>${e(node.name)}</span><small>${e(protocolLabel(connection.target))}</small></span></button></li>`;
    }
    const expanded = !!search || !collapsedFolders.has(node.path);
    return `<li><div class="folder-row"><button data-collapse="${e(node.path)}" aria-label="${expanded ? 'Collapse' : 'Expand'} ${e(node.name)}" aria-expanded="${expanded}">${icon(expanded ? 'chevron-down' : 'chevron-right')}</button><button class="nav-item" data-node="${e(node.id)}" aria-current="${page === 'map' && focusFolder === node.path}">${icon('folder')}<span class="nav-copy"><span>${e(node.name)}</span></span></button></div>${expanded ? `<ul>${node.children.map(row).join('')}</ul>` : ''}</li>`;
  };
  list.innerHTML = `<ul class="folder-tree">${root.children.map(row).join('')}</ul>`;
  list.querySelectorAll<HTMLButtonElement>('[data-collapse]').forEach(button => button.onclick = () => { const path = button.dataset.collapse!; if (collapsedFolders.has(path)) collapsedFolders.delete(path); else collapsedFolders.add(path); renderSidebar(); });
  list.querySelectorAll<HTMLButtonElement>('[data-node]').forEach(button => button.onclick = () => selectMapNode(button.dataset.node!));
  refreshIcons();
}

function renderWorkspace() {
  document.querySelector<HTMLElement>('#organization')!.hidden = page !== 'map';
  document.querySelector<HTMLElement>('#workspace-heading')!.hidden = page === 'map';
  document.querySelector<HTMLElement>('#panes')!.hidden = page === 'map';
  if (page === 'map') { renderMap(); return; }
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

function searchHierarchy(): HierarchyNode {
  const root = hierarchy(library);
  if (!search) return root;
  const filter = (node: HierarchyNode): HierarchyNode | null => {
    const connection = node.kind === 'connection' ? library.connections.find(c => 'connection:' + c.id === node.id) : undefined;
    const matches = `${node.name} ${node.path} ${connection ? describe(connection.target) : ''}`.toLowerCase().includes(search);
    const children = node.children.map(filter).filter((child): child is HierarchyNode => !!child);
    return matches || children.length ? { ...node, children: matches ? node.children : children } : null;
  };
  return { ...root, children: root.children.map(filter).filter((child): child is HierarchyNode => !!child) };
}

function folderField(path = '') {
  const folders = allNodes(hierarchy(library)).filter(n => n.kind === 'folder' && n.path);
  return `<label class="field">Folder path<input name="group" value="${e(path)}" list="folder-choices" placeholder="Company / Site / Environment"></label><datalist id="folder-choices">${folders.map(n => `<option value="${e(n.path)}"></option>`).join('')}</datalist>`;
}

function selectMapNode(id: string) {
  const node = allNodes(hierarchy(library)).find(n => n.id === id); if (!node) return;
  const wasMap = page === 'map'; page = 'map'; mapSelection = id;
  if (node.kind === 'folder') { focusFolder = node.path; mapMode = node.path ? 'focused' : 'global'; }
  else if (mapMode === 'focused' && !inGroup(node.path, focusFolder)) focusFolder = node.path;
  for (let path = node.path; path; path = parentGroup(path)) collapsedFolders.delete(path);
  renderSidebar();
  if (wasMap && node.kind !== 'folder' && document.querySelector(`[data-map-node="${CSS.escape(id)}"]`)) {
    document.querySelectorAll('[data-map-node]').forEach(element => element.classList.toggle('selected', element.getAttribute('data-map-node') === id));
    renderMapInspector();
  } else renderWorkspace();
  highlightMapPath();
  requestAnimationFrame(() => document.querySelector<SVGGElement>(`[data-map-node="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }));
}

function highlightMapPath() {
  const node = allNodes(hierarchy(library)).find(n => n.id === mapSelection); if (!node) return;
  const selectedPath = new Set([node.id, 'folder:']);
  for (let path = node.path; path; path = parentGroup(path)) selectedPath.add('folder:' + path);
  document.querySelectorAll<SVGPathElement>('[data-child]').forEach(edge => edge.classList.toggle('selected', selectedPath.has(edge.dataset.child!)));
}

async function openConnection(connection: Connection) {
  if (connection.target.protocol === 'web') { await invoke('open_management_page', { connectionId: connection.id, expectedTarget: connection.target }); return; }
  let workspace = library.workspaces.find(w => w.panes.length === 1 && w.panes[0].connection_id === connection.id && !w.panes[0].entry_command);
  if (!workspace) {
    workspace = { id: crypto.randomUUID(), name: connection.name, group: connection.group, panes: [{ connection_id: connection.id, title: '', entry_command: '' }] };
    const next = structuredClone(library); next.workspaces.push(workspace); await persist(next);
  }
  page = 'workspace'; selected = workspace.id; renderSidebar(); renderWorkspace();
  const view = views.get(`${workspace.id}:0`)!;
  const credentials = await getCredentials(connection); try { await launch(view, credentials); } finally { credentials.password = ''; }
}

function editFolder(existing?: string, parent = focusFolder) {
  const folders = allNodes(hierarchy(library)).filter(n => n.kind === 'folder' && (!existing || !inGroup(n.path, existing)));
  const node = dialog(existing ? 'Edit folder' : 'New folder', `${field('Folder name', 'name', existing?.split(' / ').at(-1) || '', 'text', true)}<label class="field">Parent folder<select name="parent">${folders.map(n => `<option value="${e(n.path)}" ${n.path === (existing ? parentGroup(existing) : parent) ? 'selected' : ''}>${e(n.path || 'All connections')}</option>`).join('')}</select></label>`, `${existing ? '<button type="button" class="danger" data-delete>Delete empty folder</button>' : ''}<button type="submit" class="primary">Save folder</button>`);
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); try {
    const form = event.target as HTMLFormElement; const name = value(form, 'name'); const parent = value(form, 'parent');
    if (!name || name.includes('/')) throw new Error('Use a folder name without slashes. Choose its parent separately.');
    const path = parent ? parent + ' / ' + name : name;
    let next: Library;
    if (existing) next = moveGroup(library, existing, path);
    else { if (allNodes(hierarchy(library)).some(n => n.kind === 'folder' && n.path === path)) throw new Error('That folder already exists.'); next = structuredClone(library); next.groups = [...(next.groups || []), path]; }
    await persist(next); focusFolder = path; mapMode = 'focused'; mapSelection = 'folder:' + path; page = 'map'; node.close(); renderSidebar(); renderWorkspace();
  } catch (error) { formError(node, error); } };
  node.querySelector('[data-delete]')?.addEventListener('click', () => catchError(async () => {
    const folder = allNodes(hierarchy(library)).find(n => n.id === 'folder:' + existing)!;
    if (folder.children.length) { formError(node, 'Move the contents out before deleting this folder.'); return; }
    const next = structuredClone(library); next.groups = (next.groups || []).filter(path => groupPath(path) !== existing);
    await persist(next); focusFolder = parentGroup(existing!); mapSelection = 'folder:' + focusFolder; node.close(); renderSidebar(); renderWorkspace();
  }));
}

function renderMapInspector() {
  const node = allNodes(hierarchy(library)).find(n => n.id === mapSelection) || hierarchy(library);
  const panel = document.querySelector('#map-inspector')!;
  let body: string;
  if (node.kind === 'folder') {
    const contents = allNodes(node).filter(n => n.kind !== 'folder');
    const connections = contents.filter(n => n.kind === 'connection').length; const workspaces = contents.filter(n => n.kind === 'workspace').length;
    body = `<div class="inspector-icon">${icon('folder')}</div><h2>${e(node.name)}</h2><p class="muted">${connections} ${connections === 1 ? 'connection' : 'connections'} · ${workspaces} ${workspaces === 1 ? 'workspace' : 'workspaces'}</p><dl><dt>Folder</dt><dd>${e(node.path || 'All connections')}</dd></dl><button class="primary" data-add-connection>${icon('plus')}Add connection</button><button class="secondary" data-add-child>${icon('folder-plus')}Add child folder</button>${node.path ? '<button class="secondary" data-edit-folder>Edit folder</button>' : ''}`;
  } else if (node.kind === 'connection') {
    const connection = library.connections.find(c => 'connection:' + c.id === node.id)!;
    body = `<div class="inspector-icon">${icon(kinds[connection.target.protocol])}</div><h2>${e(connection.name)}</h2><span class="protocol-badge">${e(protocolLabel(connection.target))}</span><dl><dt>${connection.target.protocol === 'web' ? 'URL' : 'Target'}</dt><dd>${e(describe(connection.target))}</dd><dt>Folder</dt><dd>${e(connection.group || 'All connections')}</dd></dl><button class="primary" data-open-connection>${icon(connection.target.protocol === 'web' ? 'external-link' : 'play')}${connection.target.protocol === 'web' ? 'Open management page' : 'Open connection'}</button><button class="secondary" data-edit-connection>${icon('sliders-horizontal')}Edit connection</button>`;
  } else {
    const workspace = library.workspaces.find(w => 'workspace:' + w.id === node.id)!;
    body = `<div class="inspector-icon">${icon('panels-top-left')}</div><h2>${e(workspace.name)}</h2><p class="muted">Saved layout · ${workspace.panes.length} panes</p><dl><dt>Folder</dt><dd>${e(workspace.group || 'All connections')}</dd></dl><button class="primary" data-workspace>View workspace</button><button class="secondary" data-edit-workspace>Edit workspace</button>`;
  }
  panel.innerHTML = body;
  panel.querySelector('[data-add-connection]')?.addEventListener('click', () => editConnection(undefined, node.path));
  panel.querySelector('[data-add-child]')?.addEventListener('click', () => editFolder(undefined, node.path));
  panel.querySelector('[data-edit-folder]')?.addEventListener('click', () => editFolder(node.path));
  panel.querySelector('[data-edit-connection]')?.addEventListener('click', () => editConnection(library.connections.find(c => 'connection:' + c.id === node.id)));
  panel.querySelector('[data-open-connection]')?.addEventListener('click', () => catchError(() => openConnection(library.connections.find(c => 'connection:' + c.id === node.id)!)));
  panel.querySelector('[data-edit-workspace]')?.addEventListener('click', () => editWorkspace(library.workspaces.find(w => 'workspace:' + w.id === node.id)));
  panel.querySelector('[data-workspace]')?.addEventListener('click', () => { selected = node.id.slice('workspace:'.length); page = 'workspace'; renderSidebar(); renderWorkspace(); });
  refreshIcons();
}

function renderMap() {
  mapResize?.disconnect();
  document.querySelector('.main')!.scrollTop = 0;
  const tree = hierarchy(library);
  if (focusFolder && !allNodes(tree).some(n => n.kind === 'folder' && n.path === focusFolder)) { focusFolder = ''; mapMode = 'global'; }
  const viewingPath = mapMode === 'focused' ? focusFolder : '';
  const filtered = searchHierarchy();
  let root = allNodes(filtered).find(n => n.id === 'folder:' + viewingPath) || { ...allNodes(tree).find(n => n.id === 'folder:' + viewingPath)!, children: [] };
  if (!viewingPath && root.children.length === 1 && root.children[0].kind === 'folder') root = root.children[0];
  const points = radialLayout(root); const byId = new Map(points.map(p => [p.node.id, p]));
  if (!byId.has(mapSelection)) mapSelection = root.id;
  const paths = ['']; for (const part of viewingPath.split(' / ').filter(Boolean)) paths.push(paths.at(-1) ? paths.at(-1) + ' / ' + part : part);
  const nodeType = (node: HierarchyNode) => node.kind === 'folder' ? 'folder' : node.kind === 'workspace' ? 'panels-top-left' : kinds[library.connections.find(c => 'connection:' + c.id === node.id)!.target.protocol];
  const label = (node: HierarchyNode) => node.kind === 'folder' ? `${node.children.length} ${node.children.length === 1 ? 'item' : 'items'}` : node.kind === 'workspace' ? 'Workspace' : protocolLabel(library.connections.find(c => 'connection:' + c.id === node.id)!.target);
  const edges = points.filter(p => p.parent).map(p => { const parent = byId.get(p.parent!)!; return `<path data-child="${e(p.node.id)}" d="M ${parent.x} ${parent.y} L ${p.x} ${p.y}"/>`; }).join('');
  const marks = points.map(p => `<g class="map-node ${p.node.id === mapSelection ? 'selected' : ''}" role="button" tabindex="0" aria-label="${e(p.node.kind + ': ' + (p.node.path && p.node.kind === 'folder' ? p.node.path : p.node.name))}" data-map-node="${e(p.node.id)}" transform="translate(${p.x} ${p.y})"><title>${e(p.node.name)} · ${e(p.node.path || 'All connections')}</title>${p.depth ? `<rect x="-82" y="-29" width="164" height="58" rx="9"/><foreignObject x="-68" y="-11" width="22" height="22"><div xmlns="http://www.w3.org/1999/xhtml">${icon(nodeType(p.node))}</div></foreignObject><text x="-38" y="-3">${e(p.node.name.length > 20 ? p.node.name.slice(0, 19) + '…' : p.node.name)}</text><text class="map-subtitle" x="-38" y="15">${e(label(p.node))}</text>` : `<circle r="48"/><foreignObject x="-12" y="-24" width="24" height="24"><div xmlns="http://www.w3.org/1999/xhtml">${icon('folder')}</div></foreignObject><text text-anchor="middle" y="19">${e(p.node.name.length > 14 ? p.node.name.slice(0, 13) + '…' : p.node.name)}</text>`}</g>`).join('');
  document.querySelector('#organization')!.innerHTML = `<div class="map-heading"><div><h1>Connection map</h1><p class="workspace-description">${mapMode === 'global' ? 'Your whole library' : 'Everything beneath this folder'}</p></div><div class="actions"><button class="secondary" data-add-folder>${icon('folder-plus')}Add folder</button><button class="primary" data-map-add>${icon('plus')}Connection</button></div></div><div class="map-toolbar"><div class="map-modes" role="group" aria-label="Map scope"><button aria-pressed="${mapMode === 'global'}" data-mode="global">Global map</button><button aria-pressed="${mapMode === 'focused'}" data-mode="focused" ${!focusFolder ? 'disabled' : ''}>Focused map</button></div><nav class="breadcrumbs" aria-label="Folder breadcrumbs">${paths.map((path, i) => `<button data-path="${e(path)}" ${i === paths.length - 1 ? 'aria-current="location"' : ''}>${e(path ? path.split(' / ').at(-1)! : 'All connections')}</button>${i < paths.length - 1 ? '<span aria-hidden="true">›</span>' : ''}`).join('')}</nav></div><div class="map-body"><div class="map-viewport"><svg class="connection-map" aria-label="Connection hierarchy map" tabindex="0"><g class="map-links">${edges}</g>${marks}</svg><div class="map-controls"><button class="secondary" data-zoom="out" aria-label="Zoom out">−</button><span data-scale></span><button class="secondary" data-zoom="in" aria-label="Zoom in">+</button><button class="secondary" data-fit>Fit to view</button></div>${points.length === 1 ? `<p class="map-empty">${search ? 'No matching connections in this folder.' : 'This folder is empty. Add a connection or child folder.'}</p>` : ''}<span class="map-key">Lines show folder membership</span></div><aside id="map-inspector" class="map-inspector" aria-label="Selected item details"></aside></div>`;
  const svg = document.querySelector<SVGSVGElement>('.connection-map')!;
  let scale = 1; let center = { x: 0, y: 0 }; let drag: { x: number; y: number; center: typeof center } | undefined;
  const paint = () => { const width = svg.clientWidth / scale; const height = svg.clientHeight / scale; svg.setAttribute('viewBox', `${center.x - width / 2} ${center.y - height / 2} ${width} ${height}`); document.querySelector('[data-scale]')!.textContent = Math.round(scale * 100) + '%'; };
  const fit = () => {
    if (!svg.isConnected || !svg.clientWidth || !svg.clientHeight) return;
    const xs = points.map(p => p.x); const ys = points.map(p => p.y);
    const left = Math.min(...xs) - 110; const right = Math.max(...xs) + 110; const top = Math.min(...ys) - 80; const bottom = Math.max(...ys) + 100;
    center = mapMode === 'focused' ? { x: 0, y: 0 } : { x: (left + right) / 2, y: (top + bottom) / 2 };
    const width = mapMode === 'focused' ? 2 * Math.max(Math.abs(left), Math.abs(right)) : right - left;
    const height = mapMode === 'focused' ? 2 * Math.max(Math.abs(top), Math.abs(bottom)) : bottom - top;
    scale = Math.max(0.02, Math.min(1, svg.clientWidth / width, svg.clientHeight / height)); paint();
  };
  const zoom = (factor: number) => { scale = Math.max(0.02, Math.min(2, scale * factor)); paint(); };
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button => button.onclick = () => { mapMode = button.dataset.mode as typeof mapMode; renderMap(); });
  document.querySelectorAll<HTMLButtonElement>('[data-path]').forEach(button => button.onclick = () => selectMapNode('folder:' + button.dataset.path));
  document.querySelector('[data-map-add]')!.addEventListener('click', () => editConnection(undefined, viewingPath));
  document.querySelector('[data-add-folder]')!.addEventListener('click', () => editFolder(undefined, viewingPath));
  document.querySelector('[data-fit]')!.addEventListener('click', fit);
  document.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(button => button.onclick = () => zoom(button.dataset.zoom === 'in' ? 1.25 : 0.8));
  svg.querySelectorAll<SVGGElement>('[data-map-node]').forEach(mark => {
    mark.addEventListener('click', () => selectMapNode(mark.dataset.mapNode!));
    mark.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); selectMapNode(mark.dataset.mapNode!); } });
  });
  svg.addEventListener('pointerdown', event => { if ((event.target as Element).closest('[data-map-node]')) return; svg.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY, center: { ...center } }; });
  svg.addEventListener('pointermove', event => { if (!drag) return; center = { x: drag.center.x - (event.clientX - drag.x) / scale, y: drag.center.y - (event.clientY - drag.y) / scale }; paint(); });
  const endDrag = () => { drag = undefined; }; svg.addEventListener('pointerup', endDrag); svg.addEventListener('pointercancel', endDrag);
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  svg.addEventListener('keydown', event => { if (event.target !== svg) return; if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) { event.preventDefault(); if (event.key === 'Home') fit(); else if (event.key === '-' || event.key === '+' || event.key === '=') zoom(event.key === '-' ? 0.8 : 1.25); else { center.x += (event.key === 'ArrowLeft' ? -80 : event.key === 'ArrowRight' ? 80 : 0) / scale; center.y += (event.key === 'ArrowUp' ? -80 : event.key === 'ArrowDown' ? 80 : 0) / scale; paint(); } } });
  mapResize = new ResizeObserver(fit); mapResize.observe(svg);
  requestAnimationFrame(fit); renderMapInspector(); highlightMapPath(); refreshIcons();
}

function makeView(pane: Pane): View {
  const connection = library.connections.find(c => c.id === pane.connection_id)!;
  const node = document.createElement('section'); node.className = 'pane'; node.setAttribute('aria-label', `${pane.title || connection.name}: ${describe(connection.target)}`);
  node.innerHTML = `<div class="pane-header"><div><div class="pane-title">${e(pane.title || connection.name)}</div><div class="pane-target">${e(describe(connection.target))}</div></div><div class="actions"><span class="status" data-status="idle">Idle</span><button data-run aria-label="Run a command">${icon('terminal')}</button><button data-stop aria-label="Close session" disabled>${icon('x')}</button></div></div><div class="pane-content"><div class="pane-placeholder">${icon(kinds[connection.target.protocol])}<span class="muted">${e(connection.target.protocol.toUpperCase())}</span>${pane.entry_command ? `<code class="entry">${e(pane.entry_command)}</code>` : ''}<button class="secondary" data-connect>Connect</button></div></div>`;
  const view: View = { node, connection: structuredClone(connection), pane: structuredClone(pane), disposed: false, sequence: 0 };
  node.querySelector('[data-connect]')!.addEventListener('click', () => catchError(async () => { const credentials = await getCredentials(view.connection); try { await launch(view, credentials); } finally { credentials.password = ''; } }));
  node.querySelector('[data-stop]')!.addEventListener('click', () => catchError(async () => { await stop(view); renderWorkspace(); }));
  const run = node.querySelector<HTMLButtonElement>('[data-run]')!; run.disabled = ['rdp', 'web'].includes(connection.target.protocol); run.addEventListener('click', () => commandDialog(view.connection));
  return view;
}

function terminalTheme() { const style = getComputedStyle(document.documentElement); return { background: style.getPropertyValue('--bg').trim(), foreground: style.getPropertyValue('--fg').trim(), cursor: style.getPropertyValue('--accent').trim() }; }
async function launch(view: View, credentials: Credentials) {
  if (view.id || view.pending || view.disposed) return;
  const content = view.node.querySelector<HTMLElement>('.pane-content')!; content.replaceChildren();
  if (view.connection.target.protocol === 'web') {
    try { view.pending = invoke<string>('open_management_page', { connectionId: view.connection.id, expectedTarget: view.connection.target }); view.id = await view.pending; }
    catch (error) { webPlaceholder(view, String(error)); throw error; }
    finally { view.pending = undefined; }
    if (view.disposed) return;
    content.innerHTML = `<div class="pane-placeholder">${icon('globe')}<p>Management page opened in a Portstead window.</p><span class="muted">${e(view.connection.target.url)}</span></div>`;
    view.node.querySelector<HTMLButtonElement>('[data-stop]')!.disabled = false;
    refreshIcons(); void poll(view); updateCount(); return;
  }
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
      if (view.connection.target.protocol === 'web') {
        const open = await invoke<boolean>('management_page_is_open', { label: view.id });
        const status = view.node.querySelector<HTMLElement>('.status')!;
        status.textContent = open ? 'Open' : 'Closed'; status.dataset.status = open ? 'running' : 'idle';
        if (!open) { view.id = undefined; webPlaceholder(view); view.node.querySelector<HTMLButtonElement>('[data-stop]')!.disabled = true; updateCount(); break; }
        await new Promise(resolve => setTimeout(resolve, 500)); continue;
      }
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

function webPlaceholder(view: View, error?: string) {
  view.node.querySelector('.pane-content')!.innerHTML = `<div class="pane-placeholder">${icon('globe')}${error ? `<p class="pane-error">${e(error)}</p>` : '<p>Management page closed.</p>'}<button class="secondary" data-reopen>Open management page</button></div>`;
  view.node.querySelector('[data-reopen]')!.addEventListener('click', () => catchError(() => launch(view, { username: '', domain: '', password: '', remember: false }))); refreshIcons();
}
async function stop(view: View) { view.disposed = true; const id = view.id || await view.pending?.catch(() => undefined); if (id) { if (view.connection.target.protocol === 'web') await invoke('close_management_page', { label: id }); else await invoke('session_close', { id }); } view.id = undefined; view.observer?.disconnect(); view.terminal?.dispose(); for (const [key, candidate] of views) if (candidate === view) views.delete(key); updateCount(); }
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

function editConnection(existing?: Connection, group = page === 'map' && mapMode === 'focused' ? focusFolder : '') {
  const draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: '', group, agent_access: false, target: defaultTarget('ssh') };
  const node = dialog(existing ? 'Connection settings' : 'New connection', `${field('Name', 'name', draft.name, 'text', true)}<div class="field-row">${folderField(draft.group)}<label class="field">Connection type<select name="protocol">${Object.keys(kinds).map(kind => `<option value="${kind}" ${kind === draft.target.protocol ? 'selected' : ''}>${kind === 'web' ? 'HTTP / HTTPS management page' : kind.toUpperCase()}</option>`).join('')}</select></label></div><div id="target-fields"></div><label class="check"><input type="checkbox" name="agent_access" ${draft.agent_access ? 'checked' : ''}><span>Allow agents to execute commands using this connection's account</span></label>${existing && ['rdp', 'winrm'].includes(existing.target.protocol) ? '<button type="button" class="secondary" data-forget>Forget saved password on this device</button>' : ''}${existing?.target.protocol === 'rdp' ? '<button type="button" class="secondary" data-probe>Check server certificate</button><p data-probe-result class="muted"></p>' : ''}`, `${existing ? '<button type="button" class="danger" data-delete>Delete</button>' : ''}<button type="submit" class="primary">Save connection</button>`);
  const targetFields = () => {
    const t = draft.target; let markup = '';
    if (t.protocol === 'local') markup = field('Shell executable (empty uses the default)', 'shell', t.shell || '');
    else if (t.protocol === 'kubernetes') markup = field('Kubeconfig source on this device', 'source', t.source, 'text', true) + field('Context', 'context', t.context, 'text', true) + field('Namespace', 'namespace', t.namespace);
    else if (t.protocol === 'web') markup = field('Management URL', 'url', t.url, 'url', true) + '<p class="muted">Opens in a private Portstead browser window. Sign in on the device page. Saved URLs are included in profile exports; keep passwords and tokens out of them.</p>';
    else { markup = `<div class="field-row">${field('Host or SSH alias', 'host', t.host, 'text', true)}${field('Port', 'port', String(t.port), 'number', true)}</div>` + field('Username', 'username', t.username);
      if (t.protocol === 'ssh') markup += field('Identity file (optional)', 'identity_file', t.identity_file || '');
      else { markup += field('Domain (optional)', 'domain', t.domain); if (t.protocol === 'rdp') markup += field('Trusted certificate SHA-256 (optional)', 'certificate_sha256', t.certificate_sha256 || '') + '<p class="muted">Uses normal certificate verification unless you provide an independently verified fingerprint.</p>';
        else markup += `<label class="field">Authentication<select name="auth"><option value="ntlm" ${t.auth === 'ntlm' ? 'selected' : ''}>NTLM · username and password</option><option value="kerberos" ${t.auth === 'kerberos' ? 'selected' : ''}>Kerberos · current identity / ticket</option></select></label><label class="check"><input type="checkbox" name="tls" ${t.tls ? 'checked' : ''}>Use HTTPS</label>`;
      }
    }
    const pathField = t.protocol === 'kubernetes' ? 'source' : t.protocol === 'ssh' ? 'identity_file' : t.protocol === 'local' ? 'shell' : null;
    if (pathField) markup += `<button type="button" class="secondary" data-file="${pathField}">Choose local file</button><p class="muted">File locations stay on this device. After importing a profile, replace its local:// reference with the matching file here.</p>`;
    node.querySelector('#target-fields')!.innerHTML = markup;
    const grant = node.querySelector<HTMLInputElement>('[name=agent_access]')!; grant.disabled = t.protocol === 'web'; if (grant.disabled) grant.checked = false;
    node.querySelector<HTMLButtonElement>('[data-file]')?.addEventListener('click', () => catchError(async () => { const path = await open(); if (typeof path === 'string') node.querySelector<HTMLInputElement>(`[name=${pathField}]`)!.value = path; }));
  };
  targetFields(); node.querySelector<HTMLSelectElement>('[name=protocol]')!.onchange = event => { draft.target = defaultTarget((event.target as HTMLSelectElement).value as Target['protocol']); targetFields(); };
  node.querySelector('[data-forget]')?.addEventListener('click', () => catchError(async () => { await invoke('forget_credential', { connectionId: draft.id }); formError(node, 'Saved app password removed. Windows RDP credentials managed outside this app are retained.'); }));
  node.querySelector('[data-probe]')?.addEventListener('click', () => catchError(async () => { const result = node.querySelector('[data-probe-result]')!; result.textContent = 'Checking the saved server address…'; const check = await invoke<{ verified: boolean; detail: string }>('rdp_probe', { connectionId: draft.id }); result.textContent = check.detail; }));
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); const form = event.target as HTMLFormElement; const protocol = draft.target.protocol; let target: Target;
    if (protocol === 'local') target = { protocol, shell: value(form, 'shell') || null };
    else if (protocol === 'kubernetes') target = { protocol, source: value(form, 'source'), context: value(form, 'context'), namespace: value(form, 'namespace') };
    else if (protocol === 'web') target = { protocol, url: value(form, 'url') };
    else { const base = { protocol, host: value(form, 'host'), username: value(form, 'username'), port: Number(value(form, 'port')) };
      if (protocol === 'ssh') target = { ...base, protocol, identity_file: value(form, 'identity_file') || null };
      else if (protocol === 'rdp') target = { ...base, protocol, domain: value(form, 'domain'), certificate_sha256: value(form, 'certificate_sha256').replace(/[:\s]/g, '') || null };
      else target = { ...base, protocol, domain: value(form, 'domain'), tls: new FormData(form).has('tls'), auth: value(form, 'auth') as 'ntlm' | 'kerberos' };
    }
    try { const next = structuredClone(library); const saved: Connection = { id: draft.id, name: value(form, 'name'), group: groupPath(value(form, 'group')), agent_access: new FormData(form).has('agent_access'), target }; const index = next.connections.findIndex(c => c.id === draft.id); if (index < 0) next.connections.push(saved); else next.connections[index] = saved; await persist(next); node.close(); renderWorkspace(); }
    catch (error) { formError(node, error); }
  };
  node.querySelector('[data-delete]')?.addEventListener('click', () => catchError(async () => {
    if (library.workspaces.some(w => w.panes.some(p => p.connection_id === draft.id))) { formError(node, 'Remove this connection from its workspace layouts before deleting it.'); return; }
    if (await confirmAction('Delete connection', `Delete ${draft.name}?`, 'Delete')) { const next = structuredClone(library); next.connections = next.connections.filter(c => c.id !== draft.id); await persist(next); node.close(); }
  }));
}

function editWorkspace(existing?: Workspace) {
  if (!library.connections.length) { editConnection(); return; }
  const draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: '', group: mapMode === 'focused' ? focusFolder : '', panes: [{ connection_id: library.connections[0].id, title: '', entry_command: '' }] };
  const node = dialog(existing ? 'Edit workspace layout' : 'New workspace', `${field('Workspace name', 'name', draft.name, 'text', true)}${folderField(draft.group)}<div id="pane-editors"></div><button type="button" class="secondary" data-add>${icon('plus')}Add pane</button>`, `${existing ? '<button type="button" class="danger" data-delete>Delete workspace</button>' : ''}<button type="submit" class="primary">Save workspace</button>`);
  const capture = () => { draft.name = value(node.querySelector('form')!, 'name'); draft.group = groupPath(value(node.querySelector('form')!, 'group')); node.querySelectorAll<HTMLElement>('.pane-editor').forEach((row, i) => { const connection_id = row.querySelector('select')!.value; const terminal = !['web', 'rdp'].includes(library.connections.find(c => c.id === connection_id)!.target.protocol); draft.panes[i] = { connection_id, title: row.querySelector<HTMLInputElement>('[data-title]')!.value, entry_command: terminal ? row.querySelector('textarea')!.value : '' }; }); };
  const render = () => {
    node.querySelector('#pane-editors')!.innerHTML = draft.panes.map((p, i) => `<div class="pane-editor"><div class="field-row"><label class="field">Pane ${i + 1} connection<select>${library.connections.map(c => `<option value="${e(c.id)}" ${p.connection_id === c.id ? 'selected' : ''}>${e(c.name)}</option>`).join('')}</select></label><button type="button" data-remove="${i}" aria-label="Remove pane ${i + 1}" ${draft.panes.length === 1 ? 'disabled' : ''}>${icon('x')}</button></div><label class="field">Pane title<input data-title value="${e(p.title)}" placeholder="Connection name"></label><label class="field">Entry command<textarea ${['web', 'rdp'].includes(library.connections.find(c => c.id === p.connection_id)!.target.protocol) ? 'disabled' : ''} placeholder="Optional command to run after connecting">${e(p.entry_command)}</textarea></label></div>`).join('');
    node.querySelectorAll<HTMLSelectElement>('.pane-editor select').forEach(select => select.onchange = () => { capture(); render(); });
    node.querySelectorAll<HTMLButtonElement>('[data-remove]').forEach(button => button.onclick = () => { capture(); draft.panes.splice(Number(button.dataset.remove), 1); render(); });
    node.querySelector<HTMLButtonElement>('[data-add]')!.disabled = draft.panes.length === 4; refreshIcons();
  };
  render(); node.querySelector('[data-add]')!.addEventListener('click', () => { capture(); draft.panes.push({ connection_id: draft.panes.at(-1)!.connection_id, title: '', entry_command: '' }); render(); });
  node.querySelector('form')!.onsubmit = async event => { event.preventDefault(); capture(); try {
    if ([...views.entries()].some(([key, v]) => key.startsWith(draft.id + ':') && v.id) && !await confirmAction('Apply workspace changes', 'Applying this layout closes its currently open sessions.', 'Apply and close sessions')) return;
    const next = structuredClone(library); const index = next.workspaces.findIndex(w => w.id === draft.id); if (index < 0) next.workspaces.push(draft); else next.workspaces[index] = draft;
    await persist(next); await closeWorkspace(draft.id); selected = draft.id; page = 'workspace'; node.close(); renderSidebar(); renderWorkspace();
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

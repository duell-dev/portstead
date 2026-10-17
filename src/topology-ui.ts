import { Device, Library, escapeHtml as e } from './types';
import { allNodes, groupPath, hierarchy, inGroup } from './hierarchy';
import { deviceConnections } from './discovery';
import { TopologyLink, TopologyNode, bothEnds, topology, topologyLayout } from './topology';

export interface TopologyState { folder: string; selected: string; link: string; focus: string; tablePage: number }
interface Options { library: Library; search: string; state: TopologyState; rerender: () => void; details: (device: Device) => void; open: (id: string) => void; discover: () => void }
const date = (seconds: number) => seconds ? new Date(seconds * 1000).toLocaleString() : 'Unknown';
const short = (value: string, max = 24) => value.length > max ? value.slice(0, max - 1) + '…' : value;

export function renderTopology(container: HTMLElement, options: Options): () => void {
  const { library, state, rerender } = options;
  const graph = topology(library.devices || []); const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const folders = allNodes(hierarchy(library)).filter(n => n.kind === 'folder' && n.path);
  if (!folders.some(n => n.path === state.folder)) state.folder = '';
  if (!byId.has(state.focus)) state.focus = '';
  const seeds = new Set(graph.nodes.filter(n => (!state.folder || n.device && inGroup(groupPath(n.device.group), state.folder)) && `${n.name} ${n.addresses.join(' ')} ${n.chassis} ${n.device?.group || ''}`.toLowerCase().includes(options.search)).map(n => n.id));
  const links = graph.links.filter(l => (seeds.has(l.a) || seeds.has(l.b)) && (!state.focus || l.a === state.focus || l.b === state.focus));
  const visible = new Set(links.flatMap(l => [l.a, l.b]));
  for (const id of seeds) if (!state.focus || id === state.focus) visible.add(id);
  const nodes = graph.nodes.filter(n => visible.has(n.id));
  if (!visible.has(state.selected)) state.selected = nodes[0]?.id || '';
  if (!links.some(l => l.id === state.link)) state.link = '';
  // shortcut: dense graphs use the paginated link table; add clustering when real inventories need it.
  const draw = nodes.length <= 150 && links.length <= 300;
  const points = draw ? topologyLayout({ nodes, links }) : []; const positions = new Map(points.map(p => [p.id, p]));
  const bounds = points.flatMap(p => [{ x: p.x - 112, y: p.y - 54 }, { x: p.x + 112, y: p.y + 54 }]);
  const pages = Math.max(1, Math.ceil(links.length / 100)); state.tablePage = Math.min(state.tablePage, pages - 1);
  const endpoints = (link: TopologyLink) => `${byId.get(link.a)!.name}: ${link.aPort || 'Unknown port'} ↔ ${byId.get(link.b)!.name}: ${link.bPort || 'Unknown port'}`;
  const pairs = new Map<string, TopologyLink[]>();
  for (const link of links) { const key = JSON.stringify([link.a, link.b]); const pair = pairs.get(key) || []; pair.push(link); pairs.set(key, pair); }
  const edges = points.length ? links.map((link, i) => {
    const a = positions.get(link.a)!; const b = positions.get(link.b)!;
    const pair = pairs.get(JSON.stringify([link.a, link.b]))!; const offset = (pair.indexOf(link) - (pair.length - 1) / 2) * 55;
    const dx = b.x - a.x; const dy = b.y - a.y; const length = Math.hypot(dx, dy) || 1;
    const cx = (a.x + b.x) / 2 - dy / length * offset; const cy = (a.y + b.y) / 2 + dx / length * offset;
    const path = link.a === link.b ? `M ${a.x - 60} ${a.y - 34} C ${a.x - 180 - pair.indexOf(link) * 25} ${a.y - 180}, ${a.x + 180} ${a.y - 180}, ${a.x + 60} ${a.y - 34}` : `M ${a.x} ${a.y} Q ${cx} ${cy} ${b.x} ${b.y}`;
    const labelX = link.a === link.b ? a.x : (a.x + 2 * cx + b.x) / 4;
    const labelY = link.a === link.b ? a.y - 135 - pair.indexOf(link) * 24 : (a.y + b.y) / 2 + (pair.indexOf(link) - (pair.length - 1) / 2) * 24;
    bounds.push({ x: labelX - 110, y: labelY - 25 }, { x: labelX + 110, y: labelY + 15 });
    if (link.a === link.b) bounds.push({ x: a.x - 180 - pair.indexOf(link) * 25, y: a.y - 180 }, { x: a.x + 180, y: a.y });
    return `<g data-topology-edge="${i}" class="topology-edge ${bothEnds(link) ? 'reciprocal' : 'one-sided'}"><path class="edge-line" d="${path}"/><path class="edge-hit" d="${path}" tabindex="0" role="button" aria-label="${e(endpoints(link))}"/><title>${e(endpoints(link))} · ${bothEnds(link) ? 'Reported by both ends' : 'Reported by one end'}</title><text class="port-label" x="${labelX}" y="${labelY - 6}" text-anchor="middle">${e(short(link.aPort || '?', 15))} ↔ ${e(short(link.bPort || '?', 15))}</text></g>`;
  }).join('') : '';
  const marks = points.map(p => {
    const node = byId.get(p.id)!;
    return `<g class="map-node ${node.device ? '' : 'unresolved'}" data-topology-node="${e(node.id)}" role="button" tabindex="0" aria-label="${e((node.device ? 'Device: ' : 'Unresolved neighbor: ') + node.name)}" transform="translate(${p.x} ${p.y})"><title>${e(node.name)} · ${e(node.addresses.join(', ') || node.chassis)}</title><rect x="-92" y="-34" width="184" height="68" rx="10"/><text x="-78" y="-9">${e(short(node.name))}</text><text x="-78" y="10" class="map-subtitle">${e(short(node.addresses[0] || node.chassis || 'No address'))}</text><text x="-78" y="25" class="map-subtitle">${node.device ? 'Saved device' : 'Unresolved neighbor'}</text></g>`;
  }).join('');
  container.innerHTML = `<div class="map-heading"><div><h1>Topology</h1><p class="workspace-description">LLDP observations · ${nodes.filter(n => n.device).length} saved devices · ${nodes.filter(n => !n.device).length} unresolved · ${links.length} links</p></div><button data-discover>Discover devices</button></div><div class="map-toolbar topology-toolbar"><label>Folder <select aria-label="Topology folder"><option value="">All folders</option>${folders.map(n => `<option value="${e(n.path)}" ${n.path === state.folder ? 'selected' : ''}>${e(n.path)}</option>`).join('')}</select></label><span class="muted">${state.focus ? `Neighborhood of ${e(byId.get(state.focus)!.name)} · ` : ''}Solid: both ends · Dashed: one end</span>${state.focus ? '<button data-reset-focus>Show full topology</button>' : ''}</div><div class="map-body"><div class="map-viewport topology-viewport"><svg class="connection-map topology-map" aria-label="LLDP network topology" tabindex="0">${edges}${marks}</svg><div class="map-controls"><button data-zoom="out" aria-label="Zoom out">−</button><span data-scale></span><button data-zoom="in" aria-label="Zoom in">+</button><button data-fit>Fit to view</button></div>${!nodes.length || !draw ? `<p class="map-empty">${!draw ? 'This graph is too dense to read. Choose a folder, search, or use the link table below to focus a device.' : !(library.devices || []).length ? 'Discover devices, then add selected devices to save their LLDP observations here.' : 'No devices match this view. Clear search or choose another folder.'}</p>` : ''}<span class="map-key">Saved observations · Layout does not represent distance</span></div><aside class="map-inspector" id="topology-inspector" aria-label="Topology details"></aside></div><section class="topology-table"><h2>Observed links</h2><p class="muted">These are saved snapshots, not live status. Port labels are shown on selected links. Different port identifiers can leave reverse reports separate.</p><div class="table-scroll"><table><caption class="sr-only">LLDP links and observation times</caption><thead><tr><th scope="col">Device / local port</th><th scope="col">Neighbor / remote port</th><th scope="col">Evidence</th><th scope="col">Last observations</th></tr></thead><tbody>${links.slice(state.tablePage * 100, (state.tablePage + 1) * 100).map(link => `<tr><td><button data-select-node="${e(link.a)}">${e(byId.get(link.a)!.name)}</button><small>${e(link.aPort || 'Unknown port')}</small></td><td><button data-select-node="${e(link.b)}">${e(byId.get(link.b)!.name)}</button><small>${e(link.bPort || 'Unknown port')}</small></td><td><button data-select-link="${e(link.id)}">${bothEnds(link) ? 'Both ends' : 'One end'}</button></td><td>${link.observations.map(o => `<div>${e(byId.get(o.reporter)!.name)}: ${e(date(o.observed_at))}</div>`).join('')}</td></tr>`).join('') || '<tr><td colspan="4">No LLDP links in this view. Check saved device details for discovery warnings.</td></tr>'}</tbody></table></div>${pages > 1 ? `<div class="actions"><button data-table-page="-1" ${!state.tablePage ? 'disabled' : ''}>Previous links</button><span>Page ${state.tablePage + 1} / ${pages}</span><button data-table-page="1" ${state.tablePage === pages - 1 ? 'disabled' : ''}>Next links</button></div>` : ''}</section>`;
  const inspector = container.querySelector<HTMLElement>('#topology-inspector')!;
  const select = (node: string, link = '') => { state.selected = node; state.link = link; inspect(); };
  const focus = (id: string) => { state.focus = id; state.tablePage = 0; rerender(); };
  const nodeButton = (node: TopologyNode) => `<button data-neighborhood="${e(node.id)}">Focus ${e(short(node.name, 40))}</button>`;
  function inspect() {
    const link = links.find(l => l.id === state.link); const node = byId.get(state.selected);
    container.querySelectorAll<SVGGElement>('[data-topology-node]').forEach(mark => mark.classList.toggle('selected', !link && mark.dataset.topologyNode === state.selected));
    container.querySelectorAll<SVGGElement>('[data-topology-edge]').forEach(mark => {
      const edge = links[Number(mark.dataset.topologyEdge)];
      const highlighted = link ? edge.id === link.id : edge.a === state.selected || edge.b === state.selected;
      mark.classList.toggle('selected', highlighted);
      mark.querySelector('.port-label')?.setAttribute('visibility', highlighted ? 'visible' : 'hidden');
    });
    inspector.innerHTML = link ? `<span class="protocol-badge">${bothEnds(link) ? 'Reported by both ends' : 'Reported by one end'}</span><h2>Link observations</h2><p>${e(endpoints(link))}</p><dl>${link.observations.map(o => `<dt>${e(byId.get(o.reporter)!.name)}</dt><dd>${e(date(o.observed_at))}<br>Matched by ${e(o.match === 'unresolved' ? 'unresolved advertisement' : o.match === 'address' ? 'management address' : 'chassis identity')}</dd>`).join('')}</dl><p class="muted">Reciprocal reports describe the same port pair; they do not establish current availability.</p>${[...new Set([link.a, link.b])].map(id => nodeButton(byId.get(id)!)).join('')}` : node ? `<span class="protocol-badge">${node.device ? 'Saved device' : 'Unresolved neighbor'}</span><h2>${e(node.name)}</h2><dl><dt>Management addresses</dt><dd>${e(node.addresses.join(', ') || 'Not advertised')}</dd><dt>Chassis identity</dt><dd>${e(node.chassis || 'Not collected')}</dd>${node.device ? `<dt>Folder</dt><dd>${e(node.device.group || 'All folders')}</dd><dt>Last observed</dt><dd>${e(date(node.device.observed_at))}</dd><dt>Discovery warnings</dt><dd>${e(node.device.warnings.join('\n') || 'None reported')}</dd>` : `<dt>Why unresolved?</dt><dd>${e(node.reason || '')}</dd>`}</dl>${nodeButton(node)}${node.device ? `<button data-device-details>Device details</button>${deviceConnections(library, node.device).map(c => `<button data-open="${e(c.id)}">Open ${e(c.name)}</button>`).join('')}` : '<p class="muted">Add this device through discovery to collect its own observations. No connection or scan starts automatically.</p>'}` : '<h2>No device selected</h2><p class="muted">Save discovery results to build the topology.</p>';
    inspector.querySelectorAll<HTMLButtonElement>('[data-neighborhood]').forEach(b => b.onclick = () => focus(b.dataset.neighborhood!));
    inspector.querySelector('[data-device-details]')?.addEventListener('click', () => node?.device && options.details(node.device));
    inspector.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(b => b.onclick = () => options.open(b.dataset.open!));
  }
  const activate = (element: SVGElement, fn: () => void) => {
    element.addEventListener('click', fn);
    element.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); fn(); } });
  };
  container.querySelectorAll<SVGGElement>('[data-topology-node]').forEach(mark => activate(mark, () => select(mark.dataset.topologyNode!)));
  container.querySelectorAll<SVGPathElement>('.edge-hit').forEach(mark => activate(mark, () => select('', links[Number(mark.parentElement!.getAttribute('data-topology-edge'))].id)));
  container.querySelectorAll<HTMLButtonElement>('[data-select-node]').forEach(b => b.onclick = () => select(b.dataset.selectNode!));
  container.querySelectorAll<HTMLButtonElement>('[data-select-link]').forEach(b => b.onclick = () => select('', b.dataset.selectLink!));
  container.querySelector<HTMLSelectElement>('select')!.onchange = event => { state.folder = (event.target as HTMLSelectElement).value; state.focus = ''; state.tablePage = 0; rerender(); };
  container.querySelector('[data-reset-focus]')?.addEventListener('click', () => focus(''));
  container.querySelectorAll<HTMLButtonElement>('[data-table-page]').forEach(b => b.onclick = () => { state.tablePage += Number(b.dataset.tablePage); rerender(); });
  container.querySelector('[data-discover]')!.addEventListener('click', options.discover);
  const svg = container.querySelector<SVGSVGElement>('svg.topology-map')!;
  let scale = 1; let x = 0; let y = 0; let drag: { x: number; y: number; cx: number; cy: number } | undefined;
  const paint = () => { const w = Math.max(1, svg.clientWidth) / scale; const h = Math.max(1, svg.clientHeight) / scale; svg.setAttribute('viewBox', `${x - w / 2} ${y - h / 2} ${w} ${h}`); container.querySelector('[data-scale]')!.textContent = Math.round(scale * 100) + '%'; };
  const fit = () => {
    if (!svg.isConnected) return;
    const xs = bounds.map(p => p.x); const ys = bounds.map(p => p.y);
    const left = Math.min(-50, ...xs) - 20; const right = Math.max(50, ...xs) + 20; const top = Math.min(-50, ...ys) - 35; const bottom = Math.max(50, ...ys) + 60;
    x = (left + right) / 2; y = (top + bottom) / 2; scale = Math.max(0.02, Math.min(1, svg.clientWidth / (right - left), svg.clientHeight / (bottom - top))); paint();
  };
  const zoom = (factor: number) => { scale = Math.max(0.02, Math.min(2, scale * factor)); paint(); };
  container.querySelector('[data-fit]')!.addEventListener('click', fit);
  container.querySelectorAll<HTMLButtonElement>('[data-zoom]').forEach(b => b.onclick = () => zoom(b.dataset.zoom === 'in' ? 1.25 : 0.8));
  svg.addEventListener('pointerdown', event => { if ((event.target as Element).closest('[data-topology-node], .edge-hit')) return; svg.setPointerCapture(event.pointerId); drag = { x: event.clientX, y: event.clientY, cx: x, cy: y }; });
  svg.addEventListener('pointermove', event => { if (drag) { x = drag.cx - (event.clientX - drag.x) / scale; y = drag.cy - (event.clientY - drag.y) / scale; paint(); } });
  svg.addEventListener('pointerup', () => drag = undefined); svg.addEventListener('pointercancel', () => drag = undefined);
  svg.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12); }, { passive: false });
  svg.addEventListener('keydown', event => {
    if (event.target !== svg || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'Home'].includes(event.key)) return;
    event.preventDefault(); if (event.key === 'Home') fit(); else if (['+', '=', '-'].includes(event.key)) zoom(event.key === '-' ? 0.8 : 1.25);
    else { x += (event.key === 'ArrowLeft' ? -80 : event.key === 'ArrowRight' ? 80 : 0) / scale; y += (event.key === 'ArrowUp' ? -80 : event.key === 'ArrowDown' ? 80 : 0) / scale; paint(); }
  });
  const resize = new ResizeObserver(fit); resize.observe(svg); requestAnimationFrame(fit); inspect();
  return () => resize.disconnect();
}

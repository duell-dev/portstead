import { Library } from './types';

export interface HierarchyNode {
  id: string;
  name: string;
  path: string;
  kind: 'folder' | 'connection' | 'workspace' | 'device';
  children: HierarchyNode[];
}
export interface MapNode { node: HierarchyNode; x: number; y: number; depth: number; parent?: string }
export const groupPath = (path = '') => path.trim() ? path.split('/').map(part => part.trim()).join(' / ') : '';
export const parentGroup = (path: string) => groupPath(path).split(' / ').slice(0, -1).join(' / ');
export const inGroup = (path: string, root: string) => !root || path === root || path.startsWith(root + ' / ');

export function hierarchy(library: Library): HierarchyNode {
  const root: HierarchyNode = { id: 'folder:', name: 'All connections', path: '', kind: 'folder', children: [] };
  const folders = new Map([['', root]]);
  const folder = (path: string) => {
    let current = root; let full = '';
    for (const name of groupPath(path).split(' / ').filter(Boolean)) {
      full = full ? full + ' / ' + name : name;
      let child = folders.get(full);
      if (!child) { child = { id: 'folder:' + full, name, path: full, kind: 'folder', children: [] }; current.children.push(child); folders.set(full, child); }
      current = child;
    }
    return current;
  };
  for (const path of library.groups || []) folder(path);
  for (const d of library.devices || []) folder(d.group).children.push({ id: 'device:' + d.id, name: d.name, path: groupPath(d.group), kind: 'device', children: [] });
  for (const c of library.connections) folder(c.group).children.push({ id: 'connection:' + c.id, name: c.name, path: groupPath(c.group), kind: 'connection', children: [] });
  for (const w of library.workspaces) folder(w.group).children.push({ id: 'workspace:' + w.id, name: w.name, path: groupPath(w.group), kind: 'workspace', children: [] });
  const sort = (node: HierarchyNode) => { node.children.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)); node.children.forEach(sort); };
  sort(root); return root;
}

export function allNodes(root: HierarchyNode): HierarchyNode[] {
  return [root, ...root.children.flatMap(allNodes)];
}

export function moveGroup(library: Library, from: string, to: string): Library {
  from = groupPath(from); to = groupPath(to);
  if (!from || !to) throw new Error('A folder name is required.');
  if (from === to) return structuredClone(library);
  if (inGroup(to, from)) throw new Error('A folder cannot be moved inside itself.');
  const folders = allNodes(hierarchy(library)).filter(n => n.kind === 'folder');
  if (!folders.some(n => n.path === from)) throw new Error('Folder no longer exists.');
  if (folders.some(n => n.path === to)) throw new Error('A folder with that path already exists.');
  const replace = (path: string) => { path = groupPath(path); return inGroup(path, from) ? to + path.slice(from.length) : path; };
  const next = structuredClone(library);
  next.groups = [...new Set([...(next.groups || []).map(replace), to])];
  next.connections.forEach(c => c.group = replace(c.group));
  next.workspaces.forEach(w => w.group = replace(w.group));
  next.devices?.forEach(d => d.group = replace(d.group));
  return next;
}

// The angle of each branch comes from its leaf count; depth becomes distance from the viewing root.
export function radialLayout(root: HierarchyNode): MapNode[] {
  const weights = new Map<string, number>();
  const weigh = (node: HierarchyNode): number => { const weight = Math.max(1, node.children.reduce((sum, child) => sum + weigh(child), 0)); weights.set(node.id, weight); return weight; };
  weigh(root);
  const points: { node: HierarchyNode; angle: number; depth: number; parent?: string }[] = [];
  const place = (node: HierarchyNode, start: number, end: number, depth: number, parent?: string) => {
    points.push({ node, angle: (start + end) / 2, depth, parent });
    if (depth && end - start > Math.PI) { const center = (start + end) / 2; start = center - Math.PI / 2; end = center + Math.PI / 2; }
    let cursor = start;
    for (const child of node.children) { const next = cursor + (end - start) * weights.get(child.id)! / weights.get(node.id)!; place(child, cursor, next, depth + 1, node.id); cursor = next; }
  };
  place(root, -Math.PI / 2, 3 * Math.PI / 2, 0);
  let spacing = 90;
  if (points.length <= 300) {
    const placed: (MapNode & { radius: number })[] = [];
    const byId = new Map<string, MapNode & { radius: number }>();
    for (const p of [...points].sort((a, b) => a.depth - b.depth)) {
      let radius = p.parent ? byId.get(p.parent)!.radius + 90 : 0;
      let x = radius * Math.cos(p.angle); let y = radius * Math.sin(p.angle);
      while (placed.some(other => Math.abs(x - other.x) < (other.depth && p.depth ? 180 : 146) && Math.abs(y - other.y) < (other.depth && p.depth ? 74 : 93))) {
        radius += 16; x = radius * Math.cos(p.angle); y = radius * Math.sin(p.angle);
      }
      const point = { node: p.node, depth: p.depth, parent: p.parent, x, y, radius };
      placed.push(point); byId.set(p.node.id, point);
    }
    return points.map(p => { const { radius: _radius, ...point } = byId.get(p.node.id)!; return point; });
  }
  // shortcut: large libraries use conservative ring spacing; add denser packing when needed.
  spacing = 220;
  const levels = new Map<number, number[]>();
  for (const p of points) if (p.depth) { const angles = levels.get(p.depth) || []; angles.push(p.angle); levels.set(p.depth, angles); }
  for (const [depth, angles] of levels) {
    angles.sort((a, b) => a - b);
    if (angles.length < 2) continue;
    for (let i = 0; i < angles.length; i++) {
      const gap = (angles[(i + 1) % angles.length] - angles[i] + 2 * Math.PI) % (2 * Math.PI);
      spacing = Math.max(spacing, 180 / (2 * depth * Math.sin(gap / 2)));
    }
  }
  return points.map(p => ({ node: p.node, depth: p.depth, parent: p.parent, x: p.depth * spacing * Math.cos(p.angle), y: p.depth * spacing * Math.sin(p.angle) }));
}

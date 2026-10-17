import { Device, LldpNeighbor } from './types';

export interface TopologyNode { id: string; name: string; device?: Device; addresses: string[]; chassis: string; reason?: string }
export interface Observation { reporter: string; observed_at: number; match: 'address' | 'chassis' | 'unresolved' }
export interface TopologyLink { id: string; a: string; b: string; aPort: string; bPort: string; observations: Observation[] }
export interface Topology { nodes: TopologyNode[]; links: TopologyLink[] }
export interface TopologyPoint { id: string; x: number; y: number }
const key = (parts: unknown[]) => JSON.stringify(parts);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const addressKey = (value: string) => {
  value = value.toLowerCase().replace(/^\[|\]$/g, '');
  // URL canonicalizes equivalent IPv6 spellings without DNS or network access.
  try { return value.includes(':') ? new URL(`http://[${value}]/`).hostname : value; } catch { return value; }
};
function chassisKey(id = '', subtype = 0): string {
  if (!id) return '';
  const mac = id.replace(/[:-]/g, '');
  if (subtype === 4 || !subtype) return /^[0-9a-f]{12}$/i.test(mac) ? '4:' + mac.toLowerCase() : '';
  return subtype ? subtype + ':' + id : '';
}
export function bothEnds(link: TopologyLink): boolean {
  return link.a !== link.b && [link.a, link.b].every(id => link.observations.some(o => o.reporter === id));
}

// Derive edges from observations; inventory names and folders never establish physical links.
export function topology(devices: Device[]): Topology {
  const nodes = new Map<string, TopologyNode>(); const links = new Map<string, TopologyLink>();
  const addresses = new Map<string, Set<string>>(); const chassis = new Map<string, Set<string>>();
  const index = (map: Map<string, Set<string>>, value: string, id: string) => {
    if (!value) return; const ids = map.get(value) || new Set<string>(); ids.add(id); map.set(value, ids);
  };
  for (const device of [...devices].sort((a, b) => compare(a.id, b.id))) {
    const id = 'device:' + device.id;
    nodes.set(id, { id, name: device.name, device, addresses: [device.address], chassis: device.chassis_id || '' });
    index(addresses, addressKey(device.address), id);
    index(chassis, chassisKey(device.chassis_id, device.chassis_subtype), id);
  }
  const resolve = (neighbor: LldpNeighbor): { id?: string; match: Observation['match']; reason: string } => {
    const ids = new Set(neighbor.addresses.flatMap(a => [...(addresses.get(addressKey(a)) || [])]));
    if (ids.size === 1) return { id: [...ids][0], match: 'address', reason: '' };
    if (ids.size > 1) return { match: 'unresolved', reason: 'Management addresses match multiple saved devices' };
    const candidates = chassis.get(chassisKey(neighbor.chassis_id, neighbor.chassis_subtype));
    if (candidates?.size === 1) return { id: [...candidates][0], match: 'chassis', reason: '' };
    return { match: 'unresolved', reason: candidates?.size ? 'Chassis identity matches multiple saved devices' : 'No saved device matches the advertised address or chassis identity' };
  };
  for (const device of devices) for (const neighbor of device.neighbors) {
    const source = 'device:' + device.id; const resolved = resolve(neighbor);
    // Unresolved sightings stay separate: identical names/IDs can occur at unrelated sites.
    const target = resolved.id || 'neighbor:' + key([source, neighbor.local_port, neighbor.chassis_subtype || 0, neighbor.chassis_id, neighbor.remote_port, [...neighbor.addresses].sort(), neighbor.name]);
    if (!nodes.has(target)) nodes.set(target, { id: target, name: neighbor.name || neighbor.addresses[0] || neighbor.chassis_id || 'Unidentified neighbor', addresses: neighbor.addresses, chassis: neighbor.chassis_id, reason: resolved.reason });
    let a = source; let b = target; let aPort = neighbor.local_port; let bPort = neighbor.remote_port;
    if (compare(a, b) > 0 || (a === b && compare(aPort, bPort) > 0)) [a, b, aPort, bPort] = [b, a, bPort, aPort];
    // Without both port IDs, reverse reports cannot safely identify the same cable.
    const id = key([a, b, aPort, bPort, !aPort || !bPort ? source : '']);
    const link = links.get(id) || { id, a, b, aPort, bPort, observations: [] };
    if (!link.observations.some(o => o.reporter === source)) link.observations.push({ reporter: source, observed_at: device.observed_at, match: resolved.match });
    links.set(id, link);
  }
  return { nodes: [...nodes.values()].sort((a, b) => compare(a.id, b.id)), links: [...links.values()].sort((a, b) => compare(a.id, b.id)) };
}

// Stable circular components show cycles without implying a parent or a physical distance.
export function topologyLayout(graph: Topology): TopologyPoint[] {
  const adjacency = new Map(graph.nodes.map(n => [n.id, new Set<string>()]));
  for (const link of graph.links) { adjacency.get(link.a)?.add(link.b); adjacency.get(link.b)?.add(link.a); }
  const seen = new Set<string>(); const components: string[][] = [];
  for (const node of graph.nodes) {
    if (seen.has(node.id)) continue;
    const component: string[] = []; const stack = [node.id];
    while (stack.length) {
      const id = stack.pop()!; if (seen.has(id)) continue;
      seen.add(id); component.push(id); stack.push(...[...(adjacency.get(id) || [])].sort(compare).reverse().filter(id => !seen.has(id)));
    }
    components.push(component);
  }
  const sizes = components.map(c => c.length > 1 ? Math.max(140, 220 / (2 * Math.sin(Math.PI / c.length))) : 0);
  const columns = Math.max(1, Math.ceil(Math.sqrt(components.length))); const cell = 2 * Math.max(0, ...sizes) + 260;
  return components.flatMap((component, i) => component.map((id, j) => {
    const angle = -Math.PI / 2 + 2 * Math.PI * j / component.length;
    return { id, x: i % columns * cell + sizes[i] * Math.cos(angle), y: Math.floor(i / columns) * cell + sizes[i] * Math.sin(angle) };
  }));
}

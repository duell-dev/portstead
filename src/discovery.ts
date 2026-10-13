import { Connection, Device, Library, Target } from './types';
import { groupPath } from './hierarchy';

export type DiscoverySelection = { device: Device; protocol: '' | 'http' | 'https' | 'ssh' };
const addressKey = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
export function deviceConnections(library: Library, device: Device): Connection[] {
  const addresses = new Set([device.host, device.address].map(addressKey));
  return library.connections.filter(c => {
    if ('host' in c.target) return addresses.has(addressKey(c.target.host));
    if (c.target.protocol === 'web') { try { return addresses.has(addressKey(new URL(c.target.url).hostname)); } catch { return false; } }
    return false;
  });
}
export function managementTarget(device: Device, protocol: DiscoverySelection['protocol']): Target | undefined {
  if (protocol === 'ssh') return { protocol: 'ssh', host: device.host, username: '', port: 22, identity_file: null };
  if (protocol === 'http' || protocol === 'https') return { protocol: 'web', url: `${protocol}://${device.host.includes(':') ? '[' + device.host + ']' : device.host}/` };
  return undefined;
}
export function mergeDiscovery(library: Library, selections: DiscoverySelection[], group: string): Library {
  if (!selections.length) throw new Error('Select at least one device.');
  const next = structuredClone(library); next.devices ||= [];
  for (const { device, protocol } of selections) {
    const incoming = structuredClone(device);
    if (!incoming.name.trim() || new TextEncoder().encode(incoming.name).length > 200) throw new Error('Device names need 1–200 bytes.');
    const existing = next.devices.find(d => d.address === incoming.address && d.snmp_port === incoming.snmp_port);
    if (existing) {
      // Refresh observations while preserving the user's identity, name and folder.
      Object.assign(existing, incoming, { id: existing.id, name: existing.name, group: existing.group, host: existing.host });
    } else { incoming.id = crypto.randomUUID(); incoming.group = groupPath(group); next.devices.push(incoming); }
    const target = managementTarget(incoming, protocol);
    if (target && !deviceConnections(next, incoming).some(c => c.target.protocol === target.protocol && (target.protocol !== 'web' || c.target.protocol === 'web' && new URL(c.target.url).origin === new URL(target.url).origin))) {
      next.connections.push({ id: crypto.randomUUID(), name: incoming.name, group: existing ? existing.group : incoming.group, agent_access: false, target });
    }
  }
  return next;
}

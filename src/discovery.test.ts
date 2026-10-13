import { describe, expect, it } from 'vitest';
import { deviceConnections, managementTarget, mergeDiscovery } from './discovery';
import { hierarchy, allNodes, moveGroup } from './hierarchy';
import { Device, Library } from './types';

const device: Device = { id: 'observed-device', name: 'Discovered switch', group: '', host: 'SWITCH.example.invalid', address: '192.0.2.4', snmp_port: 161, sys_object_id: '1.3.6.1.4.1.8691', description: '<script>device text</script>', location: 'Lab', contact: '', uptime_ticks: 10000, observed_at: 42, interfaces: [], neighbors: [], warnings: [] };
const library = (): Library => ({ version: 1, revision: 7, groups: [], workspaces: [], connections: [{ id: 'ssh', name: 'My SSH', group: 'Existing', agent_access: true, target: { protocol: 'ssh', host: 'switch.example.invalid', port: 2222, username: 'operator', identity_file: null } }] });
describe('SNMP discovery import', () => {
  it('merges observations without changing existing targets, grants, names or folders', () => {
    const source = library(); const first = mergeDiscovery(source, [{ device, protocol: 'https' }], 'Sites / Budapest');
    expect(source.devices).toBeUndefined(); expect(first.connections[0]).toEqual(source.connections[0]);
    expect(first.connections[1].agent_access).toBe(false);
    const id = first.devices![0].id; first.devices![0].name = 'My switch';
    const second = mergeDiscovery(first, [{ device: { ...device, name: 'Reported new name', observed_at: 100 }, protocol: 'https' }], 'Other site');
    expect(second.devices).toHaveLength(1); expect(second.connections).toHaveLength(2);
    expect(second.devices![0]).toMatchObject({ id, name: 'My switch', group: 'Sites / Budapest', observed_at: 100 });
    expect(deviceConnections(second, device)).toHaveLength(2);
  });
  it('supports inventory without connections, validates selections and constructs IPv6 URLs', () => {
    const result = mergeDiscovery(library(), [{ device, protocol: '' }], 'Site'); expect(result.connections).toHaveLength(1);
    expect(() => mergeDiscovery(library(), [], '')).toThrow();
    expect(() => mergeDiscovery(library(), [{ device: { ...device, name: ' ' }, protocol: '' }], '')).toThrow();
    expect(managementTarget({ ...device, host: '2001:db8::1' }, 'https')).toEqual({ protocol: 'web', url: 'https://[2001:db8::1]/' });
  });
  it('includes inventory in hierarchy moves and empty-folder checks', () => {
    const source = mergeDiscovery(library(), [{ device, protocol: '' }], 'Sites / Budapest / Devices');
    const moved = moveGroup(source, 'Sites / Budapest', 'Sites / Debrecen');
    expect(moved.devices![0].group).toBe('Sites / Debrecen / Devices');
    expect(allNodes(hierarchy(moved)).some(n => n.kind === 'device' && n.name === device.name)).toBe(true);
  });
});

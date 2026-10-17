import { describe, expect, it } from 'vitest';
import { bothEnds, topology, topologyLayout } from './topology';
import { Device, LldpNeighbor } from './types';

const neighbor = (address: string, local_port = 'P1', remote_port = 'P2'): LldpNeighbor => ({ local_port, remote_port, addresses: address ? [address] : [], chassis_id: '', name: 'Same model name', description: '' });
const device = (id: string, address: string, neighbors: LldpNeighbor[] = []): Device => ({ id, address, name: 'Same model name', group: '', host: address, snmp_port: 161, sys_object_id: '', description: '', location: '', contact: '', uptime_ticks: 0, observed_at: 42, interfaces: [], warnings: [], neighbors });

describe('LLDP topology', () => {
  it('joins reverse reports by device and exact port pair while preserving parallel links and dates', () => {
    const a = device('a', '192.0.2.1', [neighbor('192.0.2.2'), neighbor('192.0.2.2', 'P3', 'P4')]);
    const b = device('b', '192.0.2.2', [neighbor('192.0.2.1', 'P2', 'P1')]); b.observed_at = 100;
    const graph = topology([b, a]);
    expect(graph.nodes).toHaveLength(2); expect(graph.links).toHaveLength(2);
    const mutual = graph.links.find(bothEnds)!;
    expect(mutual.observations.map(o => o.observed_at).sort((a, b) => a - b)).toEqual([42, 100]);
    expect(graph.links.filter(l => !bothEnds(l))).toHaveLength(1);
    expect(topology([a, b]).links.map(l => l.id)).toEqual(graph.links.map(l => l.id));
  });
  it('uses typed chassis IDs when an address is absent, including legacy MAC advertisements', () => {
    const a = device('a', '192.0.2.1', [{ ...neighbor(''), chassis_id: '00:01:02:03:04:05' }]);
    const b = { ...device('b', '192.0.2.2'), chassis_subtype: 4, chassis_id: '00-01-02-03-04-05' };
    expect(topology([a, b]).links[0].observations[0].match).toBe('chassis');
    a.neighbors[0].chassis_subtype = 7;
    expect(topology([a, b]).nodes.filter(n => !n.device)).toHaveLength(1);
    a.neighbors[0].chassis_id = b.chassis_id = 'Case-sensitive-ID'; b.chassis_subtype = 7;
    expect(topology([a, b]).links[0].observations[0].match).toBe('chassis');
    a.neighbors[0].chassis_id = 'case-sensitive-id';
    expect(topology([a, b]).nodes.filter(n => !n.device)).toHaveLength(1);
  });
  it('keeps ambiguous addresses, duplicate chassis identities and same names unresolved', () => {
    const a = device('a', '192.0.2.1', [neighbor('192.0.2.2')]);
    const b = device('b', '192.0.2.2'); const c = device('c', '192.0.2.2');
    let graph = topology([a, b, c]); expect(graph.nodes.find(n => !n.device)?.reason).toMatch(/multiple/);
    b.chassis_id = c.chassis_id = 'duplicate'; b.chassis_subtype = c.chassis_subtype = 7;
    a.neighbors = [{ ...neighbor(''), chassis_id: 'duplicate', chassis_subtype: 7 }];
    graph = topology([a, b, c]); expect(graph.nodes.find(n => !n.device)?.reason).toMatch(/multiple/);
    a.neighbors = [neighbor('198.51.100.1')];
    expect(topology([a, b]).nodes.filter(n => !n.device)).toHaveLength(1);
  });
  it('canonicalizes IPv6 addresses and leaves isolated devices and self-loops visible', () => {
    const a = device('a', '2001:db8::1', [neighbor('2001:0db8:0:0:0:0:0:1')]);
    const graph = topology([a, device('isolated', '192.0.2.3')]);
    expect(graph.nodes).toHaveLength(2); expect(graph.links[0].a).toBe(graph.links[0].b);
    expect(bothEnds(graph.links[0])).toBe(false);
    expect(topologyLayout(graph)).toHaveLength(2);
  });
  it('does not collapse incomplete port pairs or distinct external sightings', () => {
    const a = device('a', '192.0.2.1', [neighbor('192.0.2.2', '', ''), neighbor('198.51.100.1')]);
    const b = device('b', '192.0.2.2', [neighbor('192.0.2.1', '', ''), neighbor('198.51.100.1')]);
    const graph = topology([a, b]);
    expect(graph.links).toHaveLength(4); expect(graph.links.some(bothEnds)).toBe(false);
    expect(graph.nodes.filter(n => !n.device)).toHaveLength(2);
  });
  it('lays out rings and disconnected components deterministically without overlapping cards', () => {
    const devices = Array.from({ length: 40 }, (_, i) => device(String(i), `192.0.2.${i + 1}`, [neighbor(`192.0.2.${(i + 1) % 40 + 1}`)]));
    devices.push(device('alone', '198.51.100.1'));
    const graph = topology(devices); const points = topologyLayout(graph);
    expect(topologyLayout(topology(devices.reverse()))).toEqual(points);
    expect(graph.links).toHaveLength(40);
    for (const [i, point] of points.entries()) for (const other of points.slice(i + 1)) expect(Math.abs(point.x - other.x) >= 184 || Math.abs(point.y - other.y) >= 68).toBe(true);
  });
});

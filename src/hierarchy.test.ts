import { describe, it, expect } from 'vitest';
import { Library } from './types';
import { hierarchy, allNodes, moveGroup, radialLayout } from './hierarchy';

const fixture = (): Library => ({ version: 1, revision: 5, groups: ['Company / Debrecen / Empty'], connections: [
  { id: 'ssh', name: 'Debian', group: 'Company / Budapest / Production', agent_access: true, target: { protocol: 'ssh', host: 'dev.example.invalid', username: '', port: 22, identity_file: null } },
  { id: 'moxa', name: 'Moxa', group: 'Company / Debrecen', agent_access: false, target: { protocol: 'web', url: 'http://192.0.2.1' } }
], workspaces: [{ id: 'ws', name: 'Servers', group: 'Company / Budapest', panes: [{ connection_id: 'ssh', title: '', entry_command: '' }] }] });

describe('portable folder hierarchy and radial navigation', () => {
  it('includes implicit parents, empty folders and workspaces, and focuses every descendant', () => {
    const root = hierarchy(fixture());
    const budapest = allNodes(root).find(n => n.path === 'Company / Budapest' && n.kind === 'folder')!;
    expect(allNodes(budapest).map(n => n.id)).toEqual(['folder:Company / Budapest', 'folder:Company / Budapest / Production', 'connection:ssh', 'workspace:ws']);
    expect(allNodes(root).some(n => n.path.endsWith('Empty'))).toBe(true);
  });
  it('moves an entire folder without changing connection targets or permissions', () => {
    const source = fixture(); const next = moveGroup(source, 'Company / Budapest', 'Company / Debrecen / Servers');
    expect(next.connections[0].group).toBe('Company / Debrecen / Servers / Production');
    expect(next.workspaces[0].group).toBe('Company / Debrecen / Servers');
    expect(next.connections[0].target).toEqual(source.connections[0].target);
    expect(next.connections[0].agent_access).toBe(true);
    expect(source.connections[0].group).toBe('Company / Budapest / Production');
    expect(() => moveGroup(source, 'Company', 'Company / Budapest / Inner')).toThrow('inside itself');
    expect(() => moveGroup(source, 'Company / Budapest', 'Company / Debrecen')).toThrow('already exists');
  });
  it('places the viewing root at the center with stable links and no overlapping node cards', () => {
    const library = fixture();
    for (let i = 0; i < 80; i++) library.groups.push('Company / Budapest / Branch ' + i);
    const root = hierarchy(library); const points = radialLayout(root);
    expect(points[0]).toMatchObject({ x: 0, y: 0, depth: 0 });
    expect(radialLayout(root)).toEqual(points);
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const width = ((points[i].depth ? 164 : 96) + (points[j].depth ? 164 : 96)) / 2;
      const height = ((points[i].depth ? 58 : 96) + (points[j].depth ? 58 : 96)) / 2;
      expect(Math.abs(points[i].x - points[j].x) >= width || Math.abs(points[i].y - points[j].y) >= height).toBe(true);
    }
    const focused = allNodes(root).find(n => n.path === 'Company / Debrecen' && n.kind === 'folder')!;
    expect(radialLayout(focused).map(p => p.node.id)).not.toContain('connection:ssh');
    const large = fixture();
    for (let i = 0; i < 350; i++) large.groups.push('Company / Large / Folder ' + i);
    const denseRoot = hierarchy(large); const dense = radialLayout(denseRoot);
    expect(dense.length).toBe(allNodes(denseRoot).length);
    expect(dense.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    for (let i = 0; i < dense.length; i++) for (let j = i + 1; j < dense.length; j++) {
      expect(Math.abs(dense[i].x - dense[j].x) >= 164 || Math.abs(dense[i].y - dense[j].y) >= 60).toBe(true);
    }
  });
});

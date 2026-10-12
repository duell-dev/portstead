export type Target =
  | { protocol: 'local'; shell: string | null }
  | { protocol: 'ssh'; host: string; username: string; port: number; identity_file: string | null }
  | { protocol: 'winrm'; host: string; username: string; domain: string; port: number; tls: boolean; auth: 'ntlm' | 'kerberos' }
  | { protocol: 'rdp'; host: string; username: string; domain: string; port: number; certificate_sha256: string | null }
  | { protocol: 'kubernetes'; source: string; context: string; namespace: string };
export interface Connection { id: string; name: string; group: string; agent_access: boolean; target: Target }
export interface Pane { connection_id: string; title: string; entry_command: string }
export interface Workspace { id: string; name: string; panes: Pane[] }
export interface Library { version: number; revision: number; connections: Connection[]; workspaces: Workspace[] }
export interface Credentials { username: string; domain: string; password: string; remember: boolean }
export interface Update { data: number[]; status: string; error: string | null; dropped_bytes: number; prompt: { label: string; secret: boolean } | null }
export interface Operation { id: string; connection_id: string; connection_name: string; target: Target; started_at: number; command: string; status: string; stdout: string; stderr: string; exit_code: number | null; truncated: boolean; actor: string }
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
export function describe(target: Target): string {
  switch (target.protocol) {
    case 'local': return target.shell || 'Default shell';
    case 'kubernetes': return `${target.context} · ${target.namespace || 'default'}`;
    default: return `${'username' in target && target.username ? target.username + '@' : ''}${target.host}`;
  }
}
export function defaultTarget(protocol: Target['protocol']): Target {
  switch (protocol) {
    case 'local': return { protocol, shell: null };
    case 'ssh': return { protocol, host: '', username: '', port: 22, identity_file: null };
    case 'winrm': return { protocol, host: '', username: '', domain: '', port: 5986, tls: true, auth: 'ntlm' };
    case 'rdp': return { protocol, host: '', username: '', domain: '', port: 3389, certificate_sha256: null };
    case 'kubernetes': return { protocol, source: '', context: '', namespace: 'default' };
  }
}
export function decodeFrame(buffer: ArrayBuffer): { width: number; height: number; sequence: number; pixels: Uint8ClampedArray<ArrayBuffer> } | null {
  if (buffer.byteLength === 0) return null;
  if (buffer.byteLength < 12) throw new Error('Incomplete desktop frame');
  const header = new DataView(buffer); const width = header.getUint16(8, true); const height = header.getUint16(10, true);
  if (!width || !height || width > 8192 || height > 8192 || buffer.byteLength !== 12 + width * height * 4) throw new Error('Invalid desktop frame size');
  return { width, height, sequence: Number(header.getBigUint64(0, true)), pixels: new Uint8ClampedArray(buffer, 12) };
}

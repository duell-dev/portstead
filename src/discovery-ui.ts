import { invoke } from '@tauri-apps/api/core';
import { Device, DiscoveryResult, Library, escapeHtml as e } from './types';
import { DiscoverySelection, mergeDiscovery } from './discovery';

interface UI {
  library: () => Library;
  persist: (library: Library) => Promise<void>;
  dialog: (title: string, body: string, actions: string) => HTMLDialogElement;
  field: (label: string, name: string, value?: string, type?: string, required?: boolean) => string;
  folderField: (group: string) => string;
  error: (node: HTMLElement, error: unknown) => void;
  group: string;
}
export function showDiscovery(ui: UI) {
  const node = ui.dialog('Discover devices', `<p class="muted">Read SNMP inventory and LLDP neighbors. Only the targets below are queried; advertised neighbors are not followed automatically.</p><label class="field">Hosts or IPv4 CIDR ranges<textarea name="targets" placeholder="switch.example.internal&#10;192.0.2.0/28" required></textarea></label><p class="muted">One per line, up to 256 addresses. IPv4 ranges: /24–/32. IPv6: individual addresses.</p><div class="field-row">${ui.field('SNMP port', 'port', '161', 'number', true)}<label class="field">Credentials<select name="mode"><option value="new">Enter credentials</option><option value="saved">Use saved profile</option></select></label></div>${ui.field('Credential profile name (to save or reuse)', 'profile_name')}<div data-credentials><label class="field">SNMP version<select name="version"><option value="v3">SNMPv3 · authentication + encryption</option><option value="v2c">SNMPv2c · community string</option></select></label><div data-secret-fields></div><label class="check"><input type="checkbox" name="remember">Remember credentials in this device's OS credential store</label></div><div data-discovery-status role="status" aria-live="polite"></div>`, '<button type="button" class="secondary" data-forget>Forget saved profile</button><button type="submit" class="primary">Discover</button>');
  node.classList.add('discovery-dialog');
  const form = node.querySelector('form')!;
  const read = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value;
  const secretFields = () => {
    node.querySelector('[data-secret-fields]')!.innerHTML = read('version') === 'v2c'
      ? `${ui.field('Community string', 'community', '', 'password', true)}<p class="muted">SNMPv2c sends its community string without encryption. Use a read-only community.</p>`
      : `${ui.field('Username', 'username', '', 'text', true)}<label class="field">Authentication<select name="auth_protocol"><option value="sha256">SHA-256</option><option value="sha1">SHA-1 (device compatibility)</option></select></label>${ui.field('Authentication password', 'auth_password', '', 'password', true)}${ui.field('Privacy password (AES-128)', 'privacy_password', '', 'password', true)}${ui.field('SNMPv3 context (optional)', 'context')}`;
  };
  secretFields();
  form.querySelector<HTMLSelectElement>('[name=version]')!.onchange = secretFields;
  form.querySelector<HTMLSelectElement>('[name=mode]')!.onchange = () => {
    const saved = read('mode') === 'saved';
    node.querySelector<HTMLElement>('[data-credentials]')!.hidden = saved;
    node.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-credentials] input, [data-credentials] select').forEach(input => input.disabled = saved);
    node.querySelector<HTMLInputElement>('[name=profile_name]')!.required = saved;
  };
  node.querySelector('[data-forget]')!.addEventListener('click', async () => {
    try { await invoke('forget_snmp_profile', { profileName: read('profile_name').trim() }); node.querySelector('[data-discovery-status]')!.textContent = 'Saved credential profile forgotten.'; }
    catch (error) { ui.error(node, error); }
  });
  let running = false; let requestId = '';
  node.addEventListener('close', () => { if (running) void invoke('cancel_discovery', { requestId }).catch(() => {}); });
  form.onsubmit = async event => {
    event.preventDefault(); if (running) return;
    const port = Number(read('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) { ui.error(node, 'Use an SNMP port from 1 to 65535.'); return; }
    const saved = read('mode') === 'saved';
    const credentials = saved ? null : read('version') === 'v2c' ? { version: 'v2c', community: read('community') } : { version: 'v3', username: read('username').trim(), auth_protocol: read('auth_protocol'), auth_password: read('auth_password'), privacy_password: read('privacy_password'), context: read('context').trim() };
    const args = { requestId: crypto.randomUUID(), targets: read('targets').split(/[\n,]/).map(s => s.trim()).filter(Boolean), port, credentials, profileName: read('profile_name').trim(), remember: !saved && (form.elements.namedItem('remember') as HTMLInputElement).checked };
    requestId = args.requestId; running = true;
    const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!; submit.disabled = true;
    node.querySelector('.form-error')!.textContent = '';
    node.querySelector('[data-discovery-status]')!.innerHTML = '<p>Reading devices… A run is limited to 90 seconds.</p><button type="button" data-stop>Stop discovery</button>';
    node.querySelector('[data-stop]')!.addEventListener('click', () => { void invoke('cancel_discovery', { requestId }).catch(error => ui.error(node, error)); });
    node.querySelectorAll<HTMLInputElement>('input[type=password]').forEach(input => input.value = '');
    try {
      const result = await invoke<DiscoveryResult>('discover_devices', args);
      if (!node.isConnected) return;
      preview(ui, node, result);
    } catch (error) {
      if (node.isConnected) { ui.error(node, error); node.querySelector('[data-discovery-status]')!.textContent = 'Discovery did not complete. Re-enter credentials or select a saved profile to retry.'; submit.disabled = false; }
    } finally {
      running = false;
      if (credentials) for (const key of ['community', 'auth_password', 'privacy_password']) if (key in credentials) (credentials as Record<string, unknown>)[key] = '';
    }
  };
}
function preview(ui: UI, node: HTMLDialogElement, result: DiscoveryResult) {
  const rows = result.devices.map((device, index) => `<article class="discovery-result"><label class="check"><input type="checkbox" name="device-${index}" checked><strong>${e(device.name)}</strong> · ${e(device.host)} (${e(device.address)})</label>${ui.field('Device name', 'name-' + index, device.name, 'text', true)}<p>${e(device.description)}</p><p class="muted">${device.interfaces.length} interfaces · ${device.neighbors.length} LLDP neighbors${device.location ? ' · ' + e(device.location) : ''}</p><label class="field">Create a connection<select name="protocol-${index}"><option value="">Device record only</option><option value="https">HTTPS management page</option><option value="http">HTTP management page</option><option value="ssh">SSH</option></select></label><p class="muted">Connection options are your choices; SNMP has not verified these services.</p>${neighborDetails(device)}${device.warnings.map(w => `<p class="muted">${e(w)}</p>`).join('')}</article>`).join('');
  const form = node.querySelector('form')!;
  form.innerHTML = `<div class="dialog-heading"><h2>Review discovered devices</h2><button type="button" data-close aria-label="Close">×</button></div><p>${result.devices.length} devices responded · ${result.failures.length} failed${result.cancelled ? ' · Stopped early; results are partial' : ''}</p><p class="muted">Existing device names and folders stay as saved. Observations refresh by management IP and SNMP port. Connections and agent permissions are preserved.</p>${ui.folderField(ui.group)}<div class="discovery-results">${rows}${result.failures.length ? `<details><summary>Devices that did not respond</summary>${result.failures.map(f => `<p>${e(f.host)}: ${e(f.error)}</p>`).join('')}</details>` : ''}</div><p class="form-error" role="alert"></p><div class="dialog-actions"><button type="button" data-close>Cancel</button><button type="submit" class="primary" ${result.devices.length ? '' : 'disabled'}>Add selected devices</button></div>`;
  node.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => node.close()));
  form.onsubmit = async event => {
    event.preventDefault();
    try {
      const data = new FormData(form);
      const selections: DiscoverySelection[] = result.devices.flatMap((device, index) => data.has('device-' + index) ? [{ device: { ...device, name: String(data.get('name-' + index) || '').trim() }, protocol: String(data.get('protocol-' + index)) as DiscoverySelection['protocol'] }] : []);
      await ui.persist(mergeDiscovery(ui.library(), selections, String(data.get('group') || ''))); node.close();
    } catch (error) { ui.error(node, error); }
  };
}
export function neighborDetails(device: Device): string {
  return device.neighbors.length ? `<details class="neighbors"><summary>LLDP neighbors (${device.neighbors.length})</summary><div class="table-scroll"><table><thead><tr><th>Local port</th><th>Neighbor</th><th>Remote port</th><th>Advertised addresses</th></tr></thead><tbody>${device.neighbors.map(n => `<tr><td>${e(n.local_port)}</td><td>${e(n.name || n.chassis_id || 'Unnamed neighbor')}</td><td>${e(n.remote_port)}</td><td>${e(n.addresses.join(', ') || 'Not advertised')}</td></tr>`).join('')}</tbody></table></div></details>` : '';
}

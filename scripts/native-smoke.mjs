import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createSocket } from 'node:dgram';

const snmpServer = createSocket('udp4');
const tlv = (tag, bytes) => Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
const integer = value => { const bytes = Buffer.alloc(4); bytes.writeInt32BE(value); return tlv(2, bytes); };
const readTlv = (bytes, position) => { const tag = bytes[position++]; let length = bytes[position++]; if (length & 128) { const count = length & 127; length = 0; for (let i = 0; i < count; i++) length = length * 256 + bytes[position++]; } return { tag, start: position, end: position + length }; };
snmpServer.on('message', (bytes, peer) => {
  const message = readTlv(bytes, 0); const version = readTlv(bytes, message.start); const community = readTlv(bytes, version.end); const pdu = readTlv(bytes, community.end); const request = readTlv(bytes, pdu.start);
  assert([0xa0, 0xa5].includes(pdu.tag), 'Discovery must only send GET/GETBULK');
  const value = pdu.tag === 0xa0 ? tlv(0x30, Buffer.concat([tlv(6, Buffer.from([43, 6, 1, 2, 1, 1, 5, 0])), tlv(4, Buffer.from('Native fixture switch'))])) : Buffer.alloc(0);
  const requestBytes = bytes.subarray(request.start, request.end); let requestId = requestBytes.reduce((value, byte) => value * 256 + byte, 0); if (requestBytes[0] & 128) requestId -= 2 ** (8 * requestBytes.length);
  const response = tlv(0xa2, Buffer.concat([integer(requestId), integer(0), integer(0), tlv(0x30, value)]));
  const packet = tlv(0x30, Buffer.concat([integer(1), tlv(4, bytes.subarray(community.start, community.end)), response]));
  snmpServer.send(packet, peer.port, peer.address);
});

assert.equal(process.platform, 'win32', 'This smoke test uses Windows WebView2 debugging');
await mkdir('.local', { recursive: true });
await new Promise(resolve => snmpServer.bind(0, '127.0.0.1', resolve));
const snmpProfileName = 'portstead-native-smoke-' + crypto.randomUUID();
const directory = await mkdtemp(resolve('.local/native-smoke-'));
const executable = resolve(process.env.PORTSTEAD_EXE || 'target/debug/portstead.exe');
const managementServer = createHttpServer((_request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" });
  response.end(`<!doctype html><html><head><title>Device fixture</title></head><body><h1>Fixture management page</h1><form><label>Device username<input name="username"></label><button>Sign in</button></form><p id="device-status">Signed out</p><a href="http://localhost:${managementServer.address().port}/outside">Different origin</a><script>document.querySelector("form").onsubmit = event => { event.preventDefault(); document.querySelector("#device-status").textContent = "Signed in as " + document.querySelector("input").value; };</script></body></html>`);
});
await new Promise(resolve => managementServer.listen(0, '127.0.0.1', resolve));
const managementUrl = `http://127.0.0.1:${managementServer.address().port}`;
const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const env = { ...process.env, CONNMANAGER_HOME: directory, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` };
delete env.PORTSTEAD_HOME; // Verify the legacy profile override still works with the renamed app.
const app = spawn(executable, [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let appError = ''; app.stderr.on('data', bytes => appError += bytes.toString());
let browser; let mcp; let page;
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  for (let i = 0; i < 100; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; } catch { if (app.exitCode !== null) throw new Error(`App exited: ${appError}`); await pause(200); }
  }
  assert(browser, `Could not attach to native WebView2: ${appError}`);
  for (let i = 0; i < 100; i++) { page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.localhost')); if (page) break; await pause(100); }
  assert(page, 'Native app page was not found');
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.getByRole('heading', { name: 'Connection map', exact: true }).waitFor();
  await page.locator('#workspaces button').filter({ hasText: 'Local workspace' }).click();
  await page.getByRole('heading', { name: 'Local workspace' }).waitFor();
  assert.equal(await page.title(), 'Portstead');
  assert.equal(await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|title', { label: 'main' })), 'Portstead');
  await page.getByRole('button', { name: 'Edit layout' }).click();
  const layout = page.getByRole('dialog');
  for (let i = 0; i < 3; i++) await layout.getByRole('button', { name: 'Add pane' }).click();
  for (let i = 0; i < 4; i++) await layout.locator('textarea').nth(i).fill(`Write-Output ('native-pane-' + (40 + ${i + 2}))`);
  await layout.getByRole('button', { name: 'Save workspace' }).click(); await layout.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await page.waitForFunction(() => [42, 43, 44, 45].every(value => document.querySelector('#panes').textContent.includes(`native-pane-${value}`)));
  await page.locator('.xterm-helper-textarea').first().focus();
  await page.keyboard.type("Write-Output ('native-input-' + (40 + 2))"); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#panes').textContent.includes('native-input-42'));
  await page.getByRole('button', { name: 'Run a command' }).first().click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Command', exact: true }).fill("Write-Output ('native-command-' + (40 + 2))");
  await page.getByRole('dialog').getByRole('button', { name: 'Run command', exact: true }).click();
  await page.locator('.operation pre').filter({ hasText: 'native-command-42' }).waitFor();
  await page.screenshot({ path: '.local/native-windows.png' });
  await page.locator('#connections button').filter({ hasText: 'Local shell' }).click();
  await page.getByRole('button', { name: 'Edit connection', exact: true }).click();
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Agents off' }).click();
  const configuration = JSON.parse(await page.getByRole('dialog').locator('textarea').inputValue()).mcpServers.portstead;
  assert.equal(configuration.env.PORTSTEAD_HOME, directory);
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  mcp = spawn(configuration.command, configuration.args, { env: { ...process.env, ...configuration.env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map(); let id = 0;
  createInterface({ input: mcp.stdout }).on('line', line => { const message = JSON.parse(line); if (message.id !== undefined) { const reply = pending.get(message.id); pending.delete(message.id); reply?.(message); } });
  const request = (method, params) => new Promise((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => { pending.delete(current); reject(new Error(`MCP timed out: ${method}`)); }, 10000);
    pending.set(current, response => { clearTimeout(timer); if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(response.result); });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  const initialized = await request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'native-smoke', version: '1' } });
  assert.equal(initialized.serverInfo.name, 'portstead');
  mcp.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  assert.equal((await request('tools/list', {})).tools.length, 6);
  const call = async (name, args = {}) => { const result = await request('tools/call', { name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return JSON.parse(result.content[0].text); };
  const catalog = await call('connections_list');
  const operation = await call('command_run', { connection_id: 'local', library_revision: catalog.library_revision, command: "Write-Output ('native-mcp-' + (40 + 2))" });
  let result;
  for (let i = 0; i < 100; i++) { result = await call('operation_read', operation); if (result.status !== 'running') break; await pause(100); }
  assert.equal(result.exit_code, 0); assert.match(result.stdout, /native-mcp-42/);
  await page.locator('.operation').filter({ hasText: 'native-mcp-42' }).filter({ hasText: 'agent' }).waitFor();
  const cancelled = await call('command_run', { connection_id: 'local', library_revision: catalog.library_revision, command: 'Start-Sleep -Seconds 30' });
  await call('operation_cancel', cancelled);
  for (let i = 0; i < 50; i++) { result = await call('operation_read', cancelled); if (result.status !== 'running') break; await pause(100); }
  assert.equal(result.status, 'cancelled');
  mcp.stdin.end(); await pause(200);
  await page.getByRole('button', { name: 'Agents on' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable agents', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('#workspaces button').filter({ hasText: 'Local workspace' }).click();
  await page.getByRole('button', { name: 'Close workspace sessions' }).click();
  await page.waitForFunction(() => document.querySelector('#session-count').textContent === 'Ready');
  const saved = JSON.parse(await readFile(resolve(directory, 'library.json'), 'utf8')); assert.equal(saved.workspaces[0].panes.length, 4);
  assert.deepEqual(errors, []);
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('Fixture management');
  await page.getByRole('dialog').locator('[name=group]').fill('Devices / Test');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Connection type' }).selectOption('web');
  await page.getByRole('dialog').getByRole('textbox', { name: 'Management URL' }).fill(managementUrl);
  await page.getByRole('dialog').getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Workspace name' }).fill('Device workspace');
  await page.getByRole('dialog').getByRole('combobox', { name: 'Pane 1 connection' }).selectOption({ label: 'Fixture management' });
  assert(await page.getByRole('dialog').locator('textarea').isDisabled());
  await page.getByRole('dialog').getByRole('button', { name: 'Save workspace' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Open workspace' }).click();
  let webPage;
  for (let i = 0; i < 100; i++) { webPage = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith(managementUrl)); if (webPage) break; await pause(100); }
  assert(webPage, 'Native management window was not found: ' + browser.contexts().flatMap(context => context.pages()).map(p => p.url()).join(', '));
  await webPage.getByRole('heading', { name: 'Fixture management page' }).waitFor();
  await webPage.getByRole('textbox', { name: 'Device username' }).fill('fixture-user');
  await webPage.getByRole('button', { name: 'Sign in' }).click();
  assert.equal(await webPage.locator('#device-status').innerText(), 'Signed in as fixture-user');
  const remoteAccess = await webPage.evaluate(async () => {
    if (!window.__TAURI_INTERNALS__?.invoke) return 'not-exposed';
    try { await Promise.race([window.__TAURI_INTERNALS__.invoke('load_library'), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))]); return 'allowed'; }
    catch (error) { return String(error).includes('timeout') ? 'timeout' : 'denied'; }
  });
  assert(['not-exposed', 'denied'].includes(remoteAccess), `Device IPC isolation: ${remoteAccess}`);
  await webPage.getByRole('link', { name: 'Different origin' }).click();
  await pause(200);
  assert.equal(new URL(webPage.url()).origin, managementUrl, 'Device navigation stays on the configured origin');
  await page.screenshot({ path: '.local/native-web-workspace.png' });
  await page.getByRole('button', { name: 'Close workspace sessions' }).click();
  await page.waitForFunction(() => document.querySelector('#session-count').textContent === 'Ready');
  for (let i = 0; i < 50 && !webPage.isClosed(); i++) await pause(100);
  assert(webPage.isClosed(), 'Closing the workspace must close its management window');
  await page.getByRole('button', { name: 'Connection map', exact: true }).click();
  await page.locator('#connections [data-node]').filter({ hasText: 'Fixture management' }).click();
  await page.getByRole('button', { name: 'Open management page', exact: true }).click();
  let reopened;
  for (let i = 0; i < 100; i++) { reopened = browser.contexts().flatMap(context => context.pages()).find(p => p.url().startsWith(managementUrl)); if (reopened) break; await pause(100); }
  assert(reopened, 'Management page must open directly from the map');
  await page.getByRole('button', { name: 'Discover devices', exact: true }).click();
  const discovery = page.getByRole('dialog');
  await discovery.getByRole('textbox', { name: 'Hosts or IPv4 CIDR ranges' }).fill('127.0.0.1');
  await discovery.getByLabel('SNMP port', { exact: true }).fill(String(snmpServer.address().port));
  await discovery.getByRole('combobox', { name: 'SNMP version' }).selectOption('v2c');
  await discovery.getByLabel('Community string', { exact: true }).fill('native-fixture-only');
  await discovery.getByLabel('Credential profile name (to save or reuse)').fill(snmpProfileName);
  await discovery.getByRole('checkbox', { name: "Remember credentials in this device's OS credential store" }).check();
  await discovery.getByRole('button', { name: 'Discover', exact: true }).click();
  await discovery.getByRole('heading', { name: 'Review discovered devices' }).waitFor();
  assert.match(await discovery.innerText(), /Native fixture switch/);
  await discovery.getByLabel('Folder path', { exact: true }).fill('Fixture / Networking');
  await discovery.getByRole('button', { name: 'Add selected devices' }).click(); await discovery.waitFor({ state: 'hidden' });
  const inventory = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('load_library'));
  assert.equal(inventory.devices.length, 1); assert.equal(inventory.devices[0].group, 'Fixture / Networking');
  assert(inventory.workspaces.some(w => w.name === 'Device workspace'));
  await page.getByRole('button', { name: 'Topology', exact: true }).click();
  await page.getByRole('heading', { name: 'Topology', exact: true }).waitFor();
  assert.equal(await page.locator('[data-topology-node]').count(), 1, 'Native saved inventory reaches topology');
  assert.equal(await page.locator('[data-topology-edge]').count(), 0, 'No physical links are invented for an isolated device');
  await page.getByRole('button', { name: 'Device: Native fixture switch', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Device details', exact: true }).click();
  assert.match(await page.getByRole('dialog').innerText(), /127\.0\.0\.1/);
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  const savedInventory = await readFile(resolve(directory, 'library.json'), 'utf8'); assert(!savedInventory.includes('native-fixture-only'));
  const reused = await page.evaluate(args => window.__TAURI_INTERNALS__.invoke('discover_devices', args), { requestId: crypto.randomUUID(), targets: ['127.0.0.1'], port: snmpServer.address().port, credentials: null, profileName: snmpProfileName, remember: false });
  assert.equal(reused.devices[0].name, 'Native fixture switch');
  await page.evaluate(profileName => window.__TAURI_INTERNALS__.invoke('forget_snmp_profile', { profileName }), snmpProfileName);
  const earlyCancelId = crypto.randomUUID();
  await page.evaluate(requestId => window.__TAURI_INTERNALS__.invoke('cancel_discovery', { requestId }), earlyCancelId);
  const cancelledDiscovery = await page.evaluate(args => window.__TAURI_INTERNALS__.invoke('discover_devices', args), { requestId: earlyCancelId, targets: ['127.0.0.1'], port: snmpServer.address().port, credentials: { version: 'v2c', community: 'native-fixture-only' }, profileName: '', remember: false });
  assert.equal(cancelledDiscovery.cancelled, true); assert.equal(cancelledDiscovery.devices.length, 0);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' })).catch(error => assert.match(String(error), /Target page, context or browser has been closed/));
  for (let i = 0; i < 50 && app.exitCode === null; i++) await pause(100);
  assert.equal(app.exitCode, 0, 'Closing the main window must also exit management windows');
  console.log('Native Windows smoke passed: real PTYs, layouts, commands, MCP, cancellation, native HTTP isolation, SNMP UDP discovery, saved-inventory topology, OS credential-profile save/reuse/forget, early discovery cancellation and app exit. Only localhost fixtures were used.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.local/native-failure.png' }).catch(() => {});
    const diagnostics = await page.evaluate(() => ({ output: document.querySelector('#panes')?.textContent, statuses: [...document.querySelectorAll('.status')].map(node => node.textContent), errors: [...document.querySelectorAll('.pane-error,.toast')].map(node => node.textContent) })).catch(() => ({}));
    await writeFile('.local/native-failure.json', JSON.stringify(diagnostics, null, 2));
    console.error(JSON.stringify({ statuses: diagnostics.statuses, errors: diagnostics.errors, outputLength: diagnostics.output?.length, markers: diagnostics.output?.match(/native-[a-z]+-\d+/g) }));
  }
  throw error;
} finally {
  snmpServer.close();
  managementServer.close();
  mcp?.stdin.end();
  if (page) await page.evaluate(async profileName => { await window.__TAURI_INTERNALS__.invoke('forget_snmp_profile', { profileName }); await window.__TAURI_INTERNALS__.invoke('disable_agents'); await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); }, snmpProfileName).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await pause(500);
  if (app.exitCode === null) app.kill();
}

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

assert.equal(process.platform, 'win32', 'This smoke test uses Windows WebView2 debugging');
await mkdir('.local', { recursive: true });
const directory = await mkdtemp(resolve('.local/native-smoke-'));
const executable = resolve(process.env.PORTSTEAD_EXE || 'target/debug/portstead.exe');
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
  await page.getByRole('button', { name: 'Close workspace sessions' }).click();
  await page.waitForFunction(() => document.querySelector('#session-count').textContent === 'Ready');
  const saved = JSON.parse(await readFile(resolve(directory, 'library.json'), 'utf8')); assert.equal(saved.workspaces[0].panes.length, 4);
  assert.deepEqual(errors, []);
  console.log('Native Windows smoke passed: four real PTYs and entry commands, terminal input, command output, saved layout, stdio MCP through the desktop engine, visible agent activity, cancellation and shutdown. No remote connections were opened.');
} catch (error) {
  if (page) {
    await page.screenshot({ path: '.local/native-failure.png' }).catch(() => {});
    const diagnostics = await page.evaluate(() => ({ output: document.querySelector('#panes')?.textContent, statuses: [...document.querySelectorAll('.status')].map(node => node.textContent), errors: [...document.querySelectorAll('.pane-error,.toast')].map(node => node.textContent) })).catch(() => ({}));
    await writeFile('.local/native-failure.json', JSON.stringify(diagnostics, null, 2));
    console.error(JSON.stringify({ statuses: diagnostics.statuses, errors: diagnostics.errors, outputLength: diagnostics.output?.length, markers: diagnostics.output?.match(/native-[a-z]+-\d+/g) }));
  }
  throw error;
} finally {
  mcp?.stdin.end();
  if (page) await page.evaluate(async () => { await window.__TAURI_INTERNALS__.invoke('disable_agents'); await window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }); }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  await pause(500);
  if (app.exitCode === null) app.kill();
}

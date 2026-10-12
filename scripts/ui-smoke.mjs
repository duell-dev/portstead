import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
await mkdir('.local', { recursive: true });
let server; let url = process.env.UI_URL;
if (!url) {
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
}
const browser = await chromium.launch({ headless: true, channel: process.env.UI_BROWSER_CHANNEL || undefined });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, colorScheme: 'dark' });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const connection = { id: 'local', name: 'Local shell', group: 'This device', agent_access: false, target: { protocol: 'local', shell: null } };
    let library = { version: 1, revision: 0, connections: [connection], workspaces: [{ id: 'workspace', name: 'Local workspace', panes: [{ connection_id: 'local', title: 'Shell', entry_command: '' }] }] };
    window.testCalls = []; window.testOperations = []; let count = 0;
    window.__TAURI_INTERNALS__ = { invoke: async (command, args = {}) => {
      window.testCalls.push({ command, args: structuredClone(args) });
      switch (command) {
        case 'load_library': return structuredClone(library);
        case 'save_library': library = structuredClone(args.library); library.revision++; return structuredClone(library);
        case 'operations_list': return window.testOperations;
        case 'open_session': return `session-${++count}`;
        case 'session_poll': return { data: [], status: 'running', error: null, dropped_bytes: 0, prompt: null };
        case 'session_resize': case 'session_write': case 'session_close': case 'disable_agents': return;
        case 'run_command': window.testOperations.push({ id: 'operation', connection_id: 'local', connection_name: 'Local shell', target: connection.target, started_at: Date.now(), command: args.command, status: 'completed', actor: 'you', stdout: '<script>untrusted output</script>', stderr: '', exit_code: 0, truncated: false }); return 'operation';
        case 'enable_agents': return { port: 12345, executable: 'C:\\Portstead\\portstead.exe', profile_directory: 'C:\\Portstead\\profiles' };
        default: throw new Error(`Unexpected test IPC: ${command}`);
      }
    } };
  });
  await page.goto(url);
  await page.getByRole('heading', { name: 'Local workspace' }).waitFor();
  assert.equal(await page.title(), 'Portstead');
  assert.match(await page.locator('.brand').innerText(), /Portstead/);
  await page.getByRole('button', { name: 'Edit layout' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('button', { name: 'Add pane' }).click();
  await editor.getByRole('button', { name: 'Add pane' }).click();
  await editor.getByRole('button', { name: 'Add pane' }).click();
  assert.equal(await editor.getByRole('button', { name: 'Add pane' }).isDisabled(), true);
  await editor.locator('textarea').nth(0).fill('echo workspace-one');
  await editor.locator('textarea').nth(1).fill('echo workspace-two');
  await editor.getByRole('button', { name: 'Save workspace' }).click();
  await editor.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.pane').count(), 4);
  await page.screenshot({ path: '.local/ui-dark.png' });
  await page.getByRole('button', { name: 'Open workspace' }).click();
  await page.waitForFunction(() => window.testCalls.filter(c => c.command === 'open_session').length === 4);
  const calls = await page.evaluate(() => window.testCalls.filter(c => c.command === 'open_session'));
  assert.deepEqual(calls.map(c => c.args.entry), ['echo workspace-one', 'echo workspace-two', '', '']);
  assert(calls.every(c => c.args.expectedTarget.protocol === 'local'));
  await page.getByRole('button', { name: 'Run a command' }).first().click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Command', exact: true }).fill('echo check');
  await page.getByRole('dialog').getByRole('button', { name: 'Run command', exact: true }).click();
  await page.locator('.operation pre').waitFor();
  assert.equal(await page.locator('.operation pre script').count(), 0);
  assert.match(await page.locator('.operation pre').innerText(), /<script>untrusted output<\/script>/);
  await page.getByRole('button', { name: 'Close workspace sessions' }).click();
  await page.waitForFunction(() => window.testCalls.filter(c => c.command === 'session_close').length === 4);
  await page.getByRole('button', { name: 'Change theme' }).click();
  await page.screenshot({ path: '.local/ui-light.png' });
  await page.getByRole('button', { name: 'New connection', exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill('SSH development');
  await page.getByRole('dialog').getByRole('textbox', { name: 'Host or SSH alias' }).fill('dev.example.invalid');
  await page.getByRole('dialog').getByRole('button', { name: 'Save connection' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Agents off' }).click();
  const configuration = JSON.parse(await page.getByRole('dialog').locator('textarea').inputValue()).mcpServers.portstead;
  assert.deepEqual(configuration.args, ['--mcp']);
  assert.equal(configuration.env.PORTSTEAD_HOME, 'C:\\Portstead\\profiles');
  await page.getByRole('dialog').getByRole('button', { name: 'Done' }).click();
  await page.setViewportSize({ width: 850, height: 580 });
  await page.screenshot({ path: '.local/ui-small.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(() => document.querySelector('.activity').getBoundingClientRect().top >= Math.max(...[...document.querySelectorAll('.pane')].map(p => p.getBoundingClientRect().bottom))), true, 'Activity must not overlap the panes');
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: four panes, entry commands, command target, escaped output, close, themes, connection editor, MCP configuration, minimum window size. IPC was mocked; no live connections were made.');
} finally { server?.kill(); await browser.close(); }

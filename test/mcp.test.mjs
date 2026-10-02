import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { forwardChrome } from '../src/adb.mjs';
import { readConfig } from '../src/config.mjs';
import { withDeadline } from '../src/errors.mjs';

const entry = fileURLToPath(new URL('../bin/chrome-control-mcp.mjs', import.meta.url));

async function clientFor(env) {
  const client = new Client({ name: 'chrome-control-tests', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ...env }, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', data => { stderr += data.toString(); });
  await client.connect(transport);
  return { client, stderr: () => stderr, call: async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args });
    const data = JSON.parse(response.content.find(item => item.type === 'text').text);
    return { response, data };
  } };
}

test('MCP discovers tools without Chrome or API keys and gives actionable connection errors', async () => {
  const session = await clientFor({ CHROME_CDP_URL: 'http://127.0.0.1:1', CHROME_AUTO_ADB: '0', GEMINI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' });
  try {
    const { tools } = await session.client.listTools();
    assert.equal(tools.length, 18);
    assert(tools.some(tool => tool.name === 'browser_snapshot'));
    assert(tools.some(tool => tool.name === 'browser_click' && tool.inputSchema.required.includes('ref')));
    const { response, data } = await session.call('browser_status');
    assert.equal(response.isError, true);
    assert.equal(data.error.code, 'CDP_UNAVAILABLE');
    assert.match(data.error.recovery, /CHROME_CDP_URL/);
    assert.equal(session.stderr(), '');
  } finally { await session.client.close(); }
});

test('ADB only chooses authorized devices and never guesses across multiple devices', async () => {
  const calls = [];
  const config = readConfig({});
  await forwardChrome(config, async (command, args) => {
    calls.push({ command, args });
    return { stdout: args[0] === 'devices' ? 'List of devices attached\nbad\toffline\nphone\tdevice\nuntrusted\tunauthorized\n' : '' };
  });
  assert.deepEqual(calls[1].args.slice(0, 2), ['-s', 'phone']);
  assert.deepEqual(calls[2].args, ['-s', 'phone', 'forward', 'tcp:9222', 'localabstract:chrome_devtools_remote']);
  await assert.rejects(forwardChrome(config, async () => ({ stdout: 'a\tdevice\nb\tdevice\n' })), error => error.code === 'ADB_DEVICE_REQUIRED');
});

test('ADB passes configuration as arguments, validates timeouts, and bounds requests', async () => {
  const serial = 'phone; do-not-execute';
  const calls = [];
  await forwardChrome(readConfig({ ANDROID_SERIAL: serial }), async (_, args, options) => {
    calls.push(args);
    assert.equal(options.timeout, 5000);
    return { stdout: '' };
  });
  assert.equal(calls[0][1], serial);
  const wireless = [];
  await forwardChrome(readConfig({ ANDROID_SERIAL: '192.168.100.14:41803' }), async (command, args) => {
    wireless.push({ command, args });
    return { stdout: '' };
  });
  assert.deepEqual(wireless[0], { command: 'adb', args: ['connect', '192.168.100.14:41803'] });
  assert(wireless.slice(1).every(call => call.args[0] === '-s' && call.args[1] === '192.168.100.14:41803'));
  const repair = [];
  await forwardChrome(readConfig({ ANDROID_SERIAL: '192.168.100.14:41803' }), async (_, args) => {
    repair.push(args);
    return { stdout: '' };
  }, { reconnect: true });
  assert.deepEqual(repair.slice(0, 2), [['disconnect', '192.168.100.14:41803'], ['connect', '192.168.100.14:41803']]);
  const abort = new AbortController();
  let adbStarted = false;
  abort.abort();
  await assert.rejects(forwardChrome(readConfig({}), async () => { adbStarted = true; }, { signal: abort.signal }));
  assert.equal(adbStarted, false);
  assert.throws(() => readConfig({ CHROME_ACTION_TIMEOUT_MS: 'NaN' }));
  await assert.rejects(withDeadline(() => new Promise(() => {}), 20), error => error.code === 'REQUEST_TIMEOUT');
});

test('real browser MCP actions, frames, shadow DOM, tab safety and reference lifetime', { timeout: 90000 }, async t => {
  const executable = process.env.CHROME_TEST_EXECUTABLE;
  if (!executable) return t.skip('Set CHROME_TEST_EXECUTABLE to a desktop Chromium binary.');
  const site = createHttpServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/frame') return response.end('<label>Frame input <input aria-label="Frame input"></label>');
    response.end(`<!doctype html><title>Browser fixture</title>
      <h1>Choose a color</h1><label>Name <input id="name"></label>
      <label>Password <input id="password" type="password" value="secret-password"></label>
      <button id="submit" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button>
      <p id="result">Not saved</p>
      <button onclick="document.querySelector('#result').textContent=confirm('Confirm action?')?'Confirmed':'Cancelled'">Confirm</button>
      <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <button style="display:none">Hidden</button><iframe src="http://localhost:${site.address().port}/frame"></iframe>
      <div id="shadow"></div><div style="height:1600px"></div><button id="bottom">Bottom</button>
      <script>document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Shadow context</p><button>Shadow button</button>'</script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const profile = await mkdtemp(join(tmpdir(), 'chrome-control-test-'));
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let session;
  let frameObserver;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let logs = '';
      const timer = setTimeout(() => reject(new Error(`Chromium startup timed out: ${logs.slice(-1000)}`)), 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stderr.on('data', data => {
        logs += data.toString();
        const match = logs.match(/DevTools listening on (ws:\/\/\S+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
    session = await clientFor({ CHROME_CDP_URL: endpoint, CHROME_AUTO_ADB: '0', CHROME_REQUEST_TIMEOUT_MS: '10000', GEMINI_API_KEY: '' });
    const invoke = async (name, args = {}) => {
      const { data, response } = await session.call(name, args);
      assert.equal(response.isError, undefined, JSON.stringify(data));
      return data;
    };
    await invoke('browser_status');
    // Attach before navigation so the observer receives cross-process frame
    // lifecycle events, rather than relying on late CDP attachment to an OOPIF.
    if (process.platform === 'android') Object.defineProperty(process, 'platform', { value: 'linux' });
    const { chromium } = await import('playwright-core');
    frameObserver = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5000 });
    // An observer without a listener would automatically dismiss user dialogs.
    const observerContext = frameObserver.contexts()[0];
    observerContext.pages().forEach(page => page.on('dialog', () => {}));
    observerContext.on('page', page => page.on('dialog', () => {}));
    let snapshot = (await invoke('browser_navigate', { url: base })).snapshot;
    const tabId = snapshot.tab_id;
    // Wait for the frame without relying on fixed external sleeps.
    snapshot = (await invoke('browser_wait', { milliseconds: 200 })).snapshot;
    const find = name => {
      const element = snapshot.elements.find(element => element.name === name);
      assert(element, `Missing element ${name}: ${JSON.stringify(snapshot.elements)}`);
      return element.ref;
    };
    assert(snapshot.frames.some(frame => frame.text.includes('Choose a color')));
    assert(snapshot.frames.some(frame => frame.text.includes('Shadow context')));
    assert(snapshot.elements.some(element => element.name === 'Frame input' && element.frame_id !== 'frame_0'));
    assert(snapshot.elements.some(element => element.name === 'Shadow button'));
    assert(!snapshot.elements.some(element => element.name === 'Hidden'));
    assert(snapshot.elements.find(element => element.name === 'Disabled').disabled);
    assert(!JSON.stringify(snapshot).includes('secret-password'));
    assert.equal(snapshot.elements.find(element => element.name === 'Bottom').in_viewport, false);
    const staleRef = find('Save');
    snapshot = (await invoke('browser_fill', { ref: find('Name'), text: 'Termux' })).snapshot;
    const stale = await session.call('browser_click', { ref: staleRef });
    assert.equal(stale.data.error.code, 'STALE_REF');
    snapshot = (await invoke('browser_click', { ref: find('Save') })).snapshot;
    assert(snapshot.frames[0].text.includes('Saved Termux'));
    snapshot = (await invoke('browser_click', { ref: find('Confirm') })).snapshot;
    assert.equal(snapshot.dialog.type, 'confirm');
    assert.equal(snapshot.dialog.message, 'Confirm action?');
    const blocked = await session.call('browser_press', { key: 'Enter' });
    assert.equal(blocked.data.error.code, 'DIALOG_OPEN');
    snapshot = (await invoke('browser_handle_dialog', { accept: false })).snapshot;
    assert(snapshot.frames[0].text.includes('Cancelled'));
    snapshot = (await invoke('browser_click', { ref: find('Confirm') })).snapshot;
    snapshot = (await invoke('browser_handle_dialog', { accept: true })).snapshot;
    assert(snapshot.frames[0].text.includes('Confirmed'));
    snapshot = (await invoke('browser_select', { ref: find('Color'), values: ['blue'] })).snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Color').value, 'blue');
    snapshot = (await invoke('browser_fill', { ref: find('Frame input'), text: 'inside frame' })).snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Frame input').value, 'inside frame');
    snapshot = (await invoke('browser_click', { ref: find('Shadow button') })).snapshot;
    snapshot = (await invoke('browser_press', { ref: find('Name'), key: 'End' })).snapshot;
    snapshot = (await invoke('browser_scroll', { y: 10000 })).snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Bottom').in_viewport, true);
    const image = await session.call('browser_screenshot');
    assert(image.response.content.some(item => item.type === 'image' && item.mimeType === 'image/jpeg'));
    // A removed node must never resolve to a neighboring button.
    // An unresponsive child frame is partial observation, not a reason to hang
    // the parent or lose usable parent refs. Use a genuine isolated renderer.
    const parent = frameObserver.contexts()[0].pages().find(page => page.url() === `${base}/`);
    let frameDebugger;
    try {
      const childFrame = await (async () => {
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          const frame = parent.frames().find(frame => frame.url().endsWith('/frame'));
          if (frame) return frame;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('The fixture observer did not receive the cross-process frame.');
      })();
      frameDebugger = await parent.context().newCDPSession(childFrame);
      await childFrame.evaluate(() => { setInterval(() => { document.title; }, 100); });
      await frameDebugger.send('Debugger.enable');
      const paused = new Promise(resolve => frameDebugger.once('Debugger.paused', resolve));
      await frameDebugger.send('Debugger.pause');
      await withDeadline(() => paused, 3000);
      snapshot = await invoke('browser_snapshot', { tab_id: tabId });
      assert(snapshot.warnings.some(warning => warning.code === 'FRAME_TIMEOUT'));
      assert(snapshot.elements.some(element => element.name === 'Name'));
      assert(!snapshot.elements.some(element => element.name === 'Frame input'));
      snapshot = (await invoke('browser_fill', { ref: find('Name'), text: 'Parent still works' })).snapshot;
      assert.equal(snapshot.elements.find(element => element.name === 'Name').value, 'Parent still works');
    } finally {
      await frameDebugger?.send('Debugger.resume').catch(() => {});
      await frameDebugger?.detach();
      await frameObserver.close();
      frameObserver = null;
    }
    // A suspended background renderer must not block tab discovery or input in
    // the selected, healthy tab. Pause a separate site through actual CDP.
    const background = await invoke('browser_new_tab', { url: `http://localhost:${site.address().port}/background` });
    snapshot = await invoke('browser_select_tab', { tab_id: tabId });
    const pauseObserver = await chromium.connectOverCDP(endpoint, { noDefaults: true, timeout: 5000 });
    const backgroundPage = pauseObserver.contexts()[0].pages().find(page => page.url().endsWith('/background'));
    const debuggerSession = await backgroundPage.context().newCDPSession(backgroundPage);
    try {
      await backgroundPage.evaluate(() => { setInterval(() => { document.title; }, 100); });
      await debuggerSession.send('Debugger.enable');
      const paused = new Promise(resolve => debuggerSession.once('Debugger.paused', resolve));
      await debuggerSession.send('Debugger.pause');
      await withDeadline(() => paused, 3000);
      const status = await invoke('browser_status');
      assert.equal(status.tabs.length, 2);
      assert.equal(status.tabs.find(tab => tab.tab_id === background.tab_id).title, 'Browser fixture');
      snapshot = (await invoke('browser_fill', { ref: find('Name'), text: 'Healthy tab' })).snapshot;
      assert.equal(snapshot.elements.find(element => element.name === 'Name').value, 'Healthy tab');
    } finally {
      await debuggerSession.send('Debugger.resume').catch(() => {});
      await debuggerSession.detach();
      await pauseObserver.close();
    }
    await invoke('browser_close_tab', { tab_id: background.tab_id });
    snapshot = await invoke('browser_snapshot', { tab_id: tabId });
    const removedSaveRef = find('Save');
    const observer = await chromium.connectOverCDP(endpoint);
    try {
      const observedPage = observer.contexts()[0].pages().find(page => page.url() === `${base}/`);
      await observedPage.evaluate(() => document.querySelector('#submit').remove());
    } finally { await observer.close(); }
    const removed = await session.call('browser_click', { ref: removedSaveRef });
    assert.equal(removed.data.error.code, 'STALE_REF');
    // Manual navigation invalidates retained JavaScript handles as well.
    const nameRef = find('Name');
    const navigationObserver = await chromium.connectOverCDP(endpoint);
    try {
      await navigationObserver.contexts()[0].pages()[0].goto(`${base}/other`, { waitUntil: 'domcontentloaded' });
    } finally { await navigationObserver.close(); }
    const navigated = await session.call('browser_fill', { ref: nameRef, text: 'wrong document' });
    assert.equal(navigated.data.error.code, 'STALE_REF');
    snapshot = await invoke('browser_snapshot');
    const newTab = await invoke('browser_new_tab');
    assert.notEqual(newTab.tab_id, tabId);
    await invoke('browser_select_tab', { tab_id: tabId });
    await invoke('browser_close_tab', { tab_id: newTab.tab_id });
    assert.equal((await invoke('browser_tabs')).tabs.length, 1);
    await invoke('browser_new_tab');
    await session.client.close();
    // A new MCP session must preserve both tabs and require explicit selection.
    session = await clientFor({ CHROME_CDP_URL: endpoint, CHROME_AUTO_ADB: '0', CHROME_REQUEST_TIMEOUT_MS: '10000' });
    const tabs = await invoke('browser_tabs');
    assert.equal(tabs.tabs.length, 2);
    const ambiguous = await session.call('browser_snapshot');
    assert.equal(ambiguous.data.error.code, 'TAB_SELECTION_REQUIRED');
    const timeoutTab = tabs.tabs.find(tab => tab.url === `${base}/other`);
    await invoke('browser_select_tab', { tab_id: timeoutTab.tab_id });
    // Retain the pending promise so Chrome cannot collect it before the server's
    // deadline. This must exercise timeout recovery, not V8's weak CDP handles.
    const timedOut = await session.call('browser_evaluate', { expression: 'window.timeoutCount = (window.timeoutCount || 0) + 1; window.timeoutPromise = new Promise(() => {}); window.timeoutPromise' });
    assert.equal(timedOut.data.error.code, 'REQUEST_TIMEOUT', JSON.stringify(timedOut.data));
    assert.equal(timedOut.data.may_have_executed, true);
    const recovered = await invoke('browser_status');
    assert.equal(recovered.tabs.length, 2);
    assert.equal(recovered.connected, true);
    const beforeReconnect = recovered.tabs.map(tab => tab.tab_id);
    const reconnected = await invoke('browser_status', { reconnect: true });
    assert.equal(reconnected.tabs.length, 2);
    assert(reconnected.tabs.every(tab => !beforeReconnect.includes(tab.tab_id)));
    const selection = await session.call('browser_snapshot');
    assert.equal(selection.data.error.code, 'TAB_SELECTION_REQUIRED');
    const restoredTab = reconnected.tabs.find(tab => tab.url === `${base}/other`);
    await invoke('browser_select_tab', { tab_id: restoredTab.tab_id });
    const count = await invoke('browser_evaluate', { expression: 'window.timeoutCount' });
    assert.equal(count.result, 1, 'A timed out mutation must never be replayed during recovery');
    assert.equal(session.stderr(), '');
  } finally {
    await frameObserver?.close();
    await session?.client.close();
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await new Promise(resolve => site.close(resolve));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket, { WebSocketServer } from 'ws';
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
    const raw = response.content.find(item => item.type === 'text').text;
    let data;
    try { data = JSON.parse(raw); }
    catch (error) { throw new Error('Tool returned non-JSON: ' + raw, { cause: error }); }
    return { response, data };
  } };
}

async function startBrowser(executable, url = 'about:blank') {
  const profile = await mkdtemp(join(tmpdir(), 'chrome-control-test-'));
  const child = spawn(executable, ['--headless', '--no-sandbox', '--disable-dev-shm-usage', '--site-per-process', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  const close = async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  };
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
    return { endpoint, close };
  } catch (error) { await close(); throw error; }
}

test('MCP connects around an empty Chrome target and discovers it after navigation without closing tabs', { timeout: 30000 }, async t => {
  const executable = process.env.CHROME_TEST_EXECUTABLE;
  if (!executable) return t.skip('Set CHROME_TEST_EXECUTABLE to a desktop Chromium binary.');
  const fixture = await startBrowser(executable, 'data:text/html,<title>Healthy page</title><h1>Available</h1>');
  if (process.platform === 'android') Object.defineProperty(process, 'platform', { value: 'linux' });
  const { chromium } = await import('playwright-core');
  let observer;
  let session;
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => relay.once('listening', resolve));
  const pageSite = createHttpServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end('<title>Created page</title><h1>Created</h1>');
  });
  await new Promise(resolve => pageSite.listen(0, '127.0.0.1', resolve));
  const sockets = new Set();
  try {
    observer = await chromium.connectOverCDP(fixture.endpoint, { noDefaults: true, timeout: 5000 });
    const context = observer.contexts()[0];
    const blank = await context.newPage();
    relay.on('connection', downstream => {
      const upstream = new WebSocket(fixture.endpoint);
      sockets.add(downstream); sockets.add(upstream);
      const queue = [];
      const blankSessions = new Set();
      const frameTrees = new Set();
      // Reproduce Android's native target using real Chromium protocol traffic:
      // the target has an execution context, but no URL or subsequent navigation.
      const empty = info => {
        if (info?.type === 'page' && info.url === 'about:blank') info.url = '';
      };
      upstream.on('open', () => queue.splice(0).forEach(data => upstream.send(data)));
      downstream.on('message', data => {
        const text = data.toString();
        const message = JSON.parse(text);
        if (message.method === 'Page.getFrameTree' && blankSessions.has(message.sessionId)) frameTrees.add(message.id);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text); else queue.push(text);
      });
      upstream.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'page' && message.params.targetInfo.url === 'about:blank') blankSessions.add(message.params.sessionId);
        empty(message.params?.targetInfo);
        for (const info of message.result?.targetInfos || []) empty(info);
        if (frameTrees.delete(message.id) && message.result?.frameTree.frame.url === 'about:blank') message.result.frameTree.frame.url = '';
        downstream.send(JSON.stringify(message));
      });
      upstream.on('error', () => downstream.terminate());
      downstream.on('error', () => upstream.terminate());
      downstream.on('close', () => upstream.terminate());
      upstream.on('close', () => downstream.terminate());
    });
    session = await clientFor({ CHROME_CDP_URL: `ws://127.0.0.1:${relay.address().port}`, CHROME_AUTO_ADB: '0', CHROME_REQUEST_TIMEOUT_MS: '10000' });
    const status = (await session.call('browser_status')).data;
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.equal(status.tabs.length, 1);
    assert.equal(status.tabs[0].title, 'Healthy page');
    const snapshot = (await session.call('browser_select_tab', { tab_id: status.tabs[0].tab_id })).data;
    assert(snapshot.frames[0].text.includes('Available'));
    assert.equal(context.pages().length, 2, 'Skipping an empty target must preserve its real tab');
    await blank.goto('data:text/html,<title>Restored page</title><h1>Restored</h1>');
    let tabs;
    const until = Date.now() + 4000;
    do {
      tabs = (await session.call('browser_tabs')).data.tabs;
      if (tabs?.some(tab => tab.title === 'Restored page')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < until);
    assert.equal(tabs.length, 2);
    const restored = tabs.find(tab => tab.title === 'Restored page');
    assert(restored, JSON.stringify(tabs));
    const observed = (await session.call('browser_select_tab', { tab_id: restored.tab_id })).data;
    assert(observed.frames[0].text.includes('Restored'));
    const created = (await session.call('browser_new_tab', { url: `http://127.0.0.1:${pageSite.address().port}` })).data;
    assert.equal(created.ok, true, JSON.stringify(created));
    assert(created.frames[0].text.includes('Created'));
    await session.client.close();
    session = null;
    assert.equal(context.pages().length, 3, 'Disconnecting must preserve existing and newly created tabs');
  } finally {
    await session?.client.close();
    for (const socket of sockets) socket.terminate();
    await new Promise(resolve => relay.close(resolve));
    await new Promise(resolve => pageSite.close(resolve));
    await observer?.close();
    await fixture.close();
  }
});

test('MCP discovers suspended tabs without contacting their renderers', { timeout: 15000 }, async () => {
  const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => relay.once('listening', resolve));
  const targets = [
    { targetId: 'ready', type: 'page', title: 'Ready', url: 'https://ready.example/', browserContextId: 'default' },
    { targetId: 'suspended', type: 'page', title: 'Suspended', url: 'https://suspended.example/', browserContextId: 'default' },
    { targetId: 'native', type: 'page', title: '', url: '', browserContextId: 'default' },
  ];
  const rendererCommands = [];
  const closedTargets = [];
  relay.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      // Browser metadata is responsive; every page renderer is suspended. This
      // is a CDP peer, not a mock of BrowserController or its attachment logic.
      if (targets.some(target => message.sessionId === target.targetId)) {
        if (message.method !== 'Runtime.runIfWaitingForDebugger') rendererCommands.push(message.method);
        return;
      }
      let result = {};
      if (message.method === 'Browser.getVersion') result = {
        product: 'Chrome/152.0.0.0', revision: 'fixture', protocolVersion: '1.3', userAgent: 'Chrome', jsVersion: '1',
      };
      if (message.method === 'Target.setAutoAttach' && message.params.autoAttach) {
        for (const targetInfo of targets) socket.send(JSON.stringify({ method: 'Target.attachedToTarget',
          params: { targetInfo, sessionId: targetInfo.targetId, waitingForDebugger: true } }));
      }
      if (message.method === 'Target.getTargetInfo') result = { targetInfo: { targetId: 'browser', type: 'browser', url: '' } };
      if (message.method === 'Target.attachToBrowserTarget') result = { sessionId: 'browser-metadata' };
      if (message.method === 'Target.getTargets') result = { targetInfos: targets };
      if (message.method === 'Target.closeTarget') closedTargets.push(message.params.targetId);
      socket.send(JSON.stringify({ id: message.id, result, ...(message.sessionId ? { sessionId: message.sessionId } : {}) }));
    });
  });
  const session = await clientFor({ CHROME_CDP_URL: `ws://127.0.0.1:${relay.address().port}`, CHROME_AUTO_ADB: '0' });
  try {
    const status = (await session.call('browser_status')).data;
    assert.equal(status.ok, true, JSON.stringify(status));
    assert.deepEqual(status.tabs.map(tab => tab.title).sort(), ['Ready', 'Suspended']);
    assert(status.tabs.every(tab => !tab.selected), 'Multiple tabs require explicit selection');
    const unselected = (await session.call('browser_snapshot')).data;
    assert.equal(unselected.error.code, 'TAB_SELECTION_REQUIRED');
    const rediscovered = (await session.call('browser_tabs')).data;
    assert.deepEqual(rediscovered.tabs, status.tabs, 'Tab IDs remain stable without renderer reads');
    const reconnected = (await session.call('browser_status', { reconnect: true })).data;
    assert.equal(reconnected.ok, true, JSON.stringify(reconnected));
    assert.equal(reconnected.tabs.length, 2);
    assert.deepEqual(rendererCommands, [], 'Discovery must not initialize suspended renderers');
    assert.deepEqual(closedTargets, [], 'Discovery and reconnect must preserve tabs');
    assert.equal(session.stderr(), '');
  } finally {
    await session.client.close();
    for (const socket of relay.clients) socket.terminate();
    await new Promise(resolve => relay.close(resolve));
  }
});

test('MCP discovers tools without Chrome or API keys and gives actionable connection errors', async () => {
  const session = await clientFor({ CHROME_CDP_URL: 'http://127.0.0.1:1', CHROME_AUTO_ADB: '0', GEMINI_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' });
  try {
    const { tools } = await session.client.listTools();
    assert(tools.some(tool => tool.name === 'browser_snapshot'));
    assert(tools.some(tool => tool.name === 'browser_click' && tool.inputSchema.required.includes('ref')));
    const { response, data } = await session.call('browser_status');
    assert.equal(response.isError, true);
    assert.equal(data.error.code, 'CDP_UNAVAILABLE');
    assert.match(data.error.recovery, /CHROME_CDP_URL/);
    const execute = (code, options = {}) => session.call('browser_exec', { code, include_snapshot: false, ...options });
    const first = await execute('const saved = await Promise.resolve(41); var stream = "User variable"; const events = 7; function next(value) { return value + 1; } print(saved);');
    assert.equal(first.data.ok, true, JSON.stringify(first.data));
    assert.equal(first.data.output, '41\n');
    const second = await execute('console.log(next(saved)); next(saved)');
    assert.equal(second.data.result, 42, 'Variables and functions must survive across MCP calls');
    assert.equal(second.data.output, '42\n');
    assert.deepEqual((await execute('({stream,events})')).data.result, { stream: 'User variable', events: 7 }, 'Node builtin names must remain usable as ordinary persistent variables');
    const failed = await execute('print("Before failure"); throw new Error("Script failed")');
    assert.equal(failed.response.isError, true);
    assert.equal(failed.data.error.code, 'EXEC_ERROR');
    assert.equal(failed.data.output, 'Before failure\n');
    assert.equal((await execute('saved')).data.result, 41, 'Ordinary script errors must preserve the namespace');
    const syntax = await execute('const invalid = ;');
    assert.equal(syntax.data.error.code, 'EXEC_ERROR');
    const bounded = await execute('console.log("x".repeat(100000))');
    assert.equal(bounded.data.output.length, 20000);
    assert.equal(bounded.data.output_truncated, true);
    const timeout = await execute('while (true) {}', { timeout_ms: 300 });
    assert.equal(timeout.data.error.code, 'EXEC_TIMEOUT', 'CPU-bound code must not freeze the MCP request loop');
    assert.equal(timeout.data.session_reset, true);
    assert.equal((await execute('typeof saved')).data.result, 'undefined', 'A timed-out namespace must be discarded');
    assert.equal(session.stderr(), '');
  } finally { await session.client.close(); }
});

test('compact MCP keeps exec helpers and reloads explicitly saved functions across sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'chrome-control-helpers-'));
  const path = join(directory, 'helpers.js');
  await writeFile(path, 'function savedHelper(value) { return value + 2; }');
  const env = { CHROME_CDP_URL: 'http://127.0.0.1:1', CHROME_AUTO_ADB: '0', CHROME_TOOL_MODE: 'compact', CHROME_HELPER_FILES: JSON.stringify([path]) };
  let session;
  let full;
  try {
    session = await clientFor(env);
    full = await clientFor({ ...env, CHROME_TOOL_MODE: 'full' });
    const compactCatalog = await session.client.listTools();
    const fullCatalog = await full.client.listTools();
    assert.equal(compactCatalog.tools.length, 3);
    assert(JSON.stringify(compactCatalog).length < JSON.stringify(fullCatalog).length / 2);
    const execute = (code, options = {}) => session.call('browser_exec', { code, include_snapshot: false, ...options });
    assert.equal((await execute('savedHelper(40)')).data.result, 42);
    // Hidden tools remain callable inside exec rather than disappearing from
    // the runtime namespace when removed from the public catalog.
    const helper = await execute('await list_tabs()');
    assert.equal(helper.data.error.code, 'CDP_UNAVAILABLE');
    assert.equal(helper.data.steps[0].helper, 'list_tabs');
    await writeFile(path, 'function savedHelper(value) { return value + 3; }');
    assert.equal((await execute('savedHelper(40)')).data.result, 43);
    await session.client.close();
    session = await clientFor(env);
    assert.equal((await execute('savedHelper(40)')).data.result, 43, 'Saved helpers must load after a fresh server launch');
    const relative = await execute('1', { helper_files: ['helpers.js'] });
    assert.equal(relative.data.error.code, 'HELPER_PATH_INVALID');
    await writeFile(path, 'x'.repeat(65537));
    assert.equal((await execute('1')).data.error.code, 'HELPER_FILE_LIMIT');
    const reset = await execute('while (true) {}', { helper_files: [], timeout_ms: 300 });
    assert.equal(reset.data.error.code, 'EXEC_TIMEOUT');
    await writeFile(path, 'function savedHelper(value) { return value + 4; }');
    assert.equal((await execute('savedHelper(40)')).data.result, 44, 'Helpers must rebuild after timeout resets the namespace');
    assert.equal(session.stderr(), '');
  } finally {
    await session?.client.close(); await full?.client.close();
    await rm(directory, { recursive: true, force: true });
  }
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
  // Reconnecting a newly supplied port must proceed even if it was never connected.
  const newPort = [];
  await forwardChrome(readConfig({ ANDROID_SERIAL: '192.168.100.14:45749' }), async (_, args) => {
    newPort.push(args);
    if (args[0] === 'disconnect') throw Object.assign(new Error('disconnect failed'), { stderr: "error: no such device '192.168.100.14:45749'" });
    return { stdout: '' };
  }, { reconnect: true });
  assert(newPort.some(args => args[0] === 'connect'), 'A missing old connection must not prevent connecting the new port');
  assert(newPort.some(args => args[2] === 'forward'));
  await assert.rejects(forwardChrome(readConfig({ ANDROID_SERIAL: '192.168.100.14:45749' }), async () => {
    throw new Error('ADB server permission denied');
  }, { reconnect: true }), error => error.code === 'ADB_FAILED' && error.message.includes('permission denied'));
  const abort = new AbortController();
  let adbStarted = false;
  abort.abort();
  await assert.rejects(forwardChrome(readConfig({}), async () => { adbStarted = true; }, { signal: abort.signal }));
  assert.equal(adbStarted, false);
  assert.throws(() => readConfig({ CHROME_ACTION_TIMEOUT_MS: 'NaN' }));
  await assert.rejects(withDeadline(() => new Promise(() => {}), 20), error => error.code === 'REQUEST_TIMEOUT');
});

test('real browser MCP actions, frames, shadow DOM, tab safety and reference lifetime', { timeout: 120000 }, async t => {
  const executable = process.env.CHROME_TEST_EXECUTABLE;
  if (!executable) return t.skip('Set CHROME_TEST_EXECUTABLE to a desktop Chromium binary.');
  const site = createHttpServer((request, response) => {
    response.setHeader('content-type', 'text/html');
    if (request.url === '/data') return setTimeout(() => { response.setHeader('content-type', 'application/json'); response.end('{"received":true}'); }, 350);
    if (request.url === '/frame') return response.end(`<label>Frame input <input aria-label="Frame input"></label>
      <input type="file" aria-label="Frame upload" style="display:none" onchange="this.files[0].text().then(text=>parent.postMessage({upload:text},'*'))">
      <button onclick="document.querySelector('input[type=file]').click()">Browse files</button>
      <script>window.requestAnimationFrame=()=>0;</script>`);
    if (request.url === '/scroller') return response.end(`<style>html,body{margin:0;height:100%;overflow:hidden}main{height:100vh;overflow:auto}</style>
      <main><h1>Scroll container</h1><div style="height:1500px"></div><button>Nested bottom</button></main>`);
    response.end(`<!doctype html><title>Browser fixture</title>
      <h1>Choose a color</h1><label>Name <input id="name"></label>
      <label>Password <input id="password" type="password" value="secret-password"></label>
      <button id="submit" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button>
      <p id="result">Not saved</p>
      <p id="uploaded">No upload</p>
      <a style="cursor:pointer" onclick="document.querySelector('#result').textContent='Deleted'">Delete attachment</a>
      <button onclick="setTimeout(()=>document.querySelector('#result').textContent='Delayed result',600)">Delayed save</button>
      <button onclick="document.querySelector('#bottom').textContent='Changed target'">Change planned target</button>
      <button onclick="document.querySelector('#bottom').remove()">Remove planned target</button>
      <button onclick="location.href='/other'">Navigate away</button>
      <button onclick="window.clicks=(window.clicks||0)+1;document.querySelector('#result').textContent='Clicked '+window.clicks+' time(s)'">Count click</button>
      <button onclick="window.waitClicks=(window.waitClicks||0)+1;document.querySelector('#result').textContent='Wait clicked '+window.waitClicks+' time(s)'">Count wait</button>
      <button onclick="const box=document.querySelector('iframe').getBoundingClientRect();Object.assign(document.querySelector('#cover').style,{display:'block',left:box.left+'px',top:box.top+'px',width:box.width+'px',height:box.height+'px'})">Cover frame</button>
      <button onclick="document.querySelector('#cover').style.display='none'">Uncover frame</button>
      <div id="cover" style="display:none;position:fixed;z-index:99;background:white" onclick="document.querySelector('#result').textContent='Unexpected overlay click'"></div>
      <button onclick="document.querySelector('#result').textContent=confirm('Confirm action?')?'Confirmed':'Cancelled'">Confirm</button>
      <select aria-label="Color"><option value="red">Red</option><option value="blue">Blue</option></select>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <button style="display:none">Hidden</button><iframe src="http://localhost:${site.address().port}/frame"></iframe>
      <div id="shadow"></div><div style="height:1600px"></div><button id="bottom">Bottom</button>
      <script>
        document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<p>Shadow context</p><button>Shadow button</button>';
        addEventListener('message',event=>{if(event.data.upload)document.querySelector('#uploaded').textContent=event.data.upload});
        document.querySelector('#bottom').addEventListener('click',()=>document.querySelector('#result').textContent='Unexpected bottom click');
      </script>`);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const fixture = await startBrowser(executable);
  const uploadDir = await mkdtemp(join(tmpdir(), 'chrome-control-upload-'));
  const uploadPath = join(uploadDir, 'payload.txt');
  await writeFile(uploadPath, 'Upload received from local MCP host');
  let session;
  let frameObserver;
  try {
    const { endpoint } = fixture;
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
    assert(snapshot.elements.some(element => element.name === 'Delete attachment'), 'Link-shaped JavaScript controls must have refs');
    assert.equal(snapshot.elements.find(element => element.name === 'Frame upload').role, 'file_input', 'Hidden cross-origin file inputs must remain addressable');
    assert(!JSON.stringify(snapshot).includes('secret-password'));
    assert.equal(snapshot.elements.find(element => element.name === 'Bottom').in_viewport, false);
    const staleRef = find('Save');
    snapshot = (await invoke('browser_fill', { ref: find('Name'), text: 'Termux' })).snapshot;
    const stale = await session.call('browser_click', { ref: staleRef });
    assert.equal(stale.data.error.code, 'STALE_REF');
    snapshot = (await invoke('browser_click', { ref: find('Save') })).snapshot;
    assert(snapshot.frames[0].text.includes('Saved Termux'));
    const { data: execution, response: executionResponse } = await session.call('browser_exec', {
      code: [
        'var rememberedAnswer = "From persistent exec";',
        'function named(snapshot, name) { const item = snapshot.elements.find(item => item.name === name); if (!item) throw new Error("Missing " + name); return item.ref; }',
        'await goto_url(' + JSON.stringify(base + '/other') + ');',
        'await wait_for_load();',
        'var current = await page_info();',
        'current = (await fill(named(current, "Name"), rememberedAnswer)).snapshot;',
        'await type_text(" appended");',
        'current = await page_info();',
        'if (!current.elements.find(item => item.name === "Agree").checked) current = (await click(named(current, "Agree"))).snapshot;',
        'current = (await select(named(current, "Color"), ["blue"])).snapshot;',
        'await click(named(current, "Save"), {wait_for: {text: "Saved " + rememberedAnswer + " appended"}});',
        'var protocol = await cdp("Runtime.evaluate", {expression: "document.title", returnByValue: true});',
        'print(protocol.result.value);',
        'rememberedAnswer;',
      ].join('\n'), include_screenshot: true,
    });
    assert.equal(executionResponse.isError, undefined, JSON.stringify(execution));
    assert.equal(execution.result, 'From persistent exec');
    assert.equal(execution.output, 'Browser fixture\n');
    assert(executionResponse.content.some(item => item.type === 'image'));
    snapshot = execution.snapshot;
    assert(snapshot.frames[0].text.includes('Saved From persistent exec appended'));
    assert.equal(snapshot.elements.find(item => item.name === 'Agree').checked, true);
    assert.equal(snapshot.elements.find(item => item.name === 'Color').value, 'blue');
    const persisted = await invoke('browser_exec', { code: 'rememberedAnswer' });
    assert.equal(persisted.result, 'From persistent exec');
    snapshot = persisted.snapshot;
    const switched = await invoke('browser_exec', { tab_id: tabId, code: [
      'var temporary = await new_tab(' + JSON.stringify(base + '/?exec-tab') + ');',
      'var temporaryPage = await page_info();',
      'if (temporaryPage.tab_id !== temporary.tab_id) throw new Error("Exec ignored the selected tab");',
      'await fill(named(temporaryPage, "Name"), "Only the temporary tab");',
      'await close_tab(temporary.tab_id);',
      'await select_tab(' + JSON.stringify(tabId) + ');',
      'print((await list_tabs()).length);',
    ].join('\n') });
    assert.equal(switched.output, '1\n');
    snapshot = switched.snapshot;
    assert.equal(snapshot.elements.find(item => item.name === 'Name').value, 'From persistent exec appended', 'Exec tab switches must preserve unrelated tab contents');
    const automatic = await invoke('browser_exec', { code: [
      'var autoPage = await page_info();',
      'var lastAuto = await fill(named(autoPage, "Name"), "One authoritative observation");',
      'lastAuto;',
    ].join('\n') });
    assert.equal(automatic.result.snapshot.refs_current, true);
    assert.equal(automatic.result.snapshot.snapshot_id, automatic.snapshot.snapshot_id);
    assert.equal(automatic.result.snapshot.elements, undefined, 'Exec must not serialize duplicate element lists');
    assert.equal(automatic.stats.snapshots, 2, 'The footer must reuse the verified action snapshot');
    const reused = await invoke('browser_exec', { code: 'await click(named(lastAuto.snapshot, "Save"), {wait_for:{text:"Saved One authoritative observation"}});' });
    assert(reused.snapshot.frames[0].text.includes('Saved One authoritative observation'), 'Action result refs must remain valid after the exec footer');
    const observerPage = frameObserver.contexts()[0].pages().find(page => page.url() === base + '/other');
    await observerPage.evaluate(() => { document.querySelector('#name').value = 'Changed without a DOM mutation'; });
    const propertyChange = await invoke('browser_exec', { code: 'rememberedAnswer;' });
    assert.equal(propertyChange.snapshot.elements.find(item => item.name === 'Name').value, 'Changed without a DOM mutation');
    assert.equal(propertyChange.stats.reused_snapshot, false);
    const { data: manual, response: manualResponse } = await session.call('browser_exec', { observation: 'manual', code: [
      'var manualPage = await page_info();',
      'await batch([{action:"fill",ref:named(manualPage,"Name"),text:"Manual batch"},{action:"click",ref:named(manualPage,"Save")}],{wait_for:{text:"Saved Manual batch"},include_screenshot:true});',
    ].join('\n') });
    assert.equal(manual.stats.snapshots, 2);
    assert(manualResponse.content.some(item => item.type === 'image'), 'Deferred DOM observations must still honor requested visual context');
    assert.equal(manual.result.snapshot, undefined);
    assert.equal(manual.result.completed, true);
    assert(manual.snapshot.frames[0].text.includes('Saved Manual batch'));
    const manualStale = await session.call('browser_exec', { observation: 'manual', code: 'var staleManual=await page_info(); await fill(named(staleManual,"Name"),"No replay"); await click(named(staleManual,"Save"));' });
    assert.equal(manualStale.data.error.code, 'STALE_REF', 'Manual observation must preserve ref invalidation');
    const conditional = await invoke('browser_exec', { observation: 'manual', code: [
      'await js("var gate=document.createElement(\'button\'); gate.id=\'gate\'; gate.hidden=true; gate.disabled=true; document.body.append(gate); setTimeout(()=>{gate.hidden=false;gate.disabled=false},250)");',
      'var gateReady=await wait_for_element("#gate",{state:"enabled"});',
      'if(!gateReady.wait.matched) throw new Error("Gate did not become enabled");',
      'var frameCheckpoint=await page_info(); var waitFrame=frameCheckpoint.elements.find(e=>e.name==="Frame input").frame_id;',
      'await js("document.querySelector(\'input\').disabled=true;setTimeout(()=>document.querySelector(\'input\').disabled=false,250)",{frame_id:waitFrame});',
      'var frameReady=await wait_for_element("input",{state:"enabled",frame_id:waitFrame});',
      'var iframeText=await wait_for({text:"Frame input",frame_id:waitFrame});',
      'await js("document.querySelector(\'#gate\').hidden=true");',
      'var hiddenReady=await wait_for_element("#gate",{state:"hidden"});',
      'var attachedReady=await wait_for_element("#gate",{state:"attached"});',
      'var summary=await page_info({detail:"summary"});',
      '({frameReady:frameReady.wait.matched,iframeText:iframeText.wait.matched,hidden:hiddenReady.wait.matched,attached:attachedReady.wait.matched,summary});',
    ].join('\n') });
    assert.equal(conditional.result.frameReady, true);
    assert.equal(conditional.result.iframeText, true);
    assert.equal(conditional.result.hidden, true);
    assert.equal(conditional.result.attached, true);
    assert.equal(conditional.result.summary.elements, undefined);
    assert(conditional.result.summary.viewport.width > 0);
    const conditionTimeout = await invoke('browser_exec', { observation: 'manual', code: [
      'var oncePage=await page_info();',
      'await click(named(oncePage,"Count wait"),{wait_for:{selector:"#never-created",timeout_ms:150}});',
    ].join('\n') });
    assert.equal(conditionTimeout.result.wait.matched, false);
    assert(conditionTimeout.snapshot.frames[0].text.includes('Wait clicked 1 time(s)'), 'Wait timeout must not replay input');
    const events = await invoke('browser_exec', { observation: 'manual', code: [
      'await watch_events(); await drain_events();',
      'await js("fetch(\'/data\').then(r=>r.json()).then(()=>document.querySelector(\'#result\').textContent=\'Network complete\');console.log(\'Event fixture\')");',
      'var idleResult=await wait_for_network_idle({idle_ms:200,timeout_ms:3000});',
      'var eventResult=await drain_events();',
      '({idle:idleResult,stream:eventResult});',
    ].join('\n') });
    assert.equal(events.result.idle.matched, true);
    assert(events.result.stream.events.some(event => event.type === 'response' && event.url === base + '/data' && event.status === 200));
    assert(events.result.stream.events.some(event => event.type === 'console' && event.text === 'Event fixture'));
    assert(events.snapshot.frames[0].text.includes('Network complete'), 'Network idle must wait for the real delayed response');
    const overflow = await invoke('browser_exec', { observation: 'manual', code: 'await js("for(var i=0;i<300;i++)console.log(\'Bounded event\',i)"); var boundedEvents=await drain_events({types:["console"],max_events:256}); ({dropped:boundedEvents.dropped,count:boundedEvents.events.length});' });
    assert(overflow.result.dropped > 0);
    assert(overflow.result.count <= 256);
    const metrics = await observerPage.context().newCDPSession(observerPage);
    let resized;
    try {
      await metrics.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 2, mobile: false });
      resized = await session.call('browser_screenshot', { full: true, max_dim: 480 });
    } finally {
      await metrics.send('Emulation.clearDeviceMetricsOverride'); await metrics.detach();
    }
    const jpeg = Buffer.from(resized.response.content.find(item => item.type === 'image').data, 'base64');
    let dimensions;
    for (let offset = 2; offset < jpeg.length;) {
      const marker = jpeg[offset + 1];
      const length = jpeg.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2].includes(marker)) { dimensions = { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) }; break; }
      offset += length + 2;
    }
    assert(dimensions, 'The screenshot must contain a decodable JPEG frame');
    assert(Math.max(dimensions.width, dimensions.height) <= 480);
    assert(resized.data.clip.height > conditional.result.summary.viewport.height, 'Full screenshots must include content below the viewport');
    const frameExecution = await invoke('browser_exec', { code: [
      'var framePage = await page_info();',
      'var childId = framePage.elements.find(item => item.name === "Frame input").frame_id;',
      'var childResult = await js("document.querySelector(\'input[type=file]\').type", {frame_id: childId});',
      'childResult.result;',
    ].join('\n') });
    assert.equal(frameExecution.result, 'file', 'Exec JS must evaluate in the requested iframe');
    snapshot = frameExecution.snapshot;
    const partial = await session.call('browser_exec', { code: [
      'var before = await page_info();',
      'await fill(named(before, "Name"), "Completed before stale ref");',
      'await click(named(before, "Save"));',
    ].join('\n') });
    assert.equal(partial.data.error.code, 'STALE_REF');
    assert(partial.data.steps.some(step => step.helper === 'fill' && step.completed && step.executed), 'Exec failures must retain completed browser operations');
    snapshot = await invoke('browser_snapshot');
    assert.equal(snapshot.elements.find(item => item.name === 'Name').value, 'Completed before stale ref');
    const longAnswer = 'A useful answer with enough detail. '.repeat(16);
    const { data: batch, response: batchResponse } = await session.call('browser_batch', { actions: [
      { action: 'fill', ref: find('Name'), text: longAnswer },
      { action: 'select', ref: find('Color'), values: ['blue'] },
      { action: 'click', ref: find('Save') },
    ], wait_for: { text: `Saved ${longAnswer}` }, include_screenshot: true });
    assert.equal(batchResponse.isError, undefined, JSON.stringify(batch));
    assert(batchResponse.content.some(item => item.type === 'image'), 'The final batch observation must support an inline screenshot');
    assert.equal(batch.completed, true);
    assert.equal(batch.results.length, 3);
    snapshot = batch.snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Name').value, longAnswer, 'Answers longer than 300 characters must remain verifiable');
    snapshot = (await invoke('browser_click', { ref: find('Delayed save'), wait_for: { text: 'Delayed result' } })).snapshot;
    assert(snapshot.frames[0].text.includes('Delayed result'), 'The returned action snapshot must reflect the requested asynchronous update');
    const timeoutResult = await invoke('browser_click', { ref: find('Count click'), wait_for: { text: 'Impossible text', timeout_ms: 200 } });
    assert.equal(timeoutResult.executed, true);
    assert.equal(timeoutResult.wait.matched, false);
    snapshot = timeoutResult.snapshot;
    assert(snapshot.frames[0].text.includes('Clicked 1 time(s)'), 'A wait timeout must not replay input');
    const changed = await invoke('browser_batch', { actions: [
      { action: 'click', ref: find('Change planned target') }, { action: 'click', ref: find('Bottom') },
    ] });
    assert.equal(changed.completed, false);
    assert.equal(changed.results.length, 1);
    assert.equal(changed.stopped.error.code, 'STALE_REF');
    snapshot = changed.snapshot;
    assert(!snapshot.frames[0].text.includes('Unexpected bottom click'));
    const removedBatch = await invoke('browser_batch', { actions: [
      { action: 'click', ref: find('Remove planned target') }, { action: 'click', ref: find('Changed target') },
    ] });
    assert.equal(removedBatch.results.length, 1);
    assert.equal(removedBatch.stopped.error.code, 'STALE_REF');
    snapshot = removedBatch.snapshot;
    const navigatedBatch = await invoke('browser_batch', { actions: [
      { action: 'click', ref: find('Navigate away') }, { action: 'fill', ref: find('Name'), text: 'Must not execute on a new page' },
    ] });
    assert.equal(navigatedBatch.completed, false);
    assert.equal(navigatedBatch.results.length, 1);
    assert.equal(navigatedBatch.stopped.reason, 'page_changed');
    snapshot = (await invoke('browser_navigate', { url: base })).snapshot;
    snapshot = (await invoke('browser_wait', { milliseconds: 200 })).snapshot;
    const upload = await invoke('browser_upload', { ref: find('Frame upload'), paths: [uploadPath], wait_for: { text: 'Upload received from local MCP host' } });
    assert.equal(upload.files[0].name, 'payload.txt');
    assert.equal(upload.wait.matched, true);
    snapshot = upload.snapshot;
    snapshot = (await invoke('browser_click', { ref: find('Cover frame') })).snapshot;
    const covered = await session.call('browser_click', { ref: find('Browse files') });
    assert.equal(covered.data.error.code, 'ELEMENT_NOT_ACTIONABLE', 'Paused-frame fallback must hit-test its ancestor frames');
    snapshot = await invoke('browser_snapshot');
    assert(!snapshot.frames[0].text.includes('Unexpected overlay click'), 'Covered frame input must not click a parent overlay');
    snapshot = (await invoke('browser_click', { ref: find('Uncover frame') })).snapshot;
    await writeFile(uploadPath, 'Upload received through intercepted chooser');
    const chooserClick = await invoke('browser_click', { ref: find('Browse files') });
    assert(chooserClick.file_chooser, 'Paused-frame clicks must open an interceptable chooser');
    snapshot = chooserClick.snapshot;
    const chooserUpload = await invoke('browser_upload', { paths: [uploadPath], wait_for: { text: 'Upload received through intercepted chooser' } });
    assert.equal(chooserUpload.executed, true, 'An intercepted chooser must accept files without operating a native picker');
    assert.equal(chooserUpload.wait.matched, true, 'The second upload must produce a new page update');
    snapshot = chooserUpload.snapshot;
    const cropped = await session.call('browser_screenshot', { ref: find('Save') });
    assert(cropped.data.clip.width > 0 && cropped.data.clip.height > 0);
    assert(cropped.response.content.some(item => item.type === 'image'));
    const missingFile = await session.call('browser_upload', { ref: find('Frame upload'), paths: [join(uploadDir, 'missing.txt')] });
    assert.equal(missingFile.data.error.code, 'UPLOAD_FILE_UNAVAILABLE');
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
    snapshot = (await invoke('browser_navigate', { url: `${base}/scroller` })).snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Nested bottom').in_viewport, false);
    snapshot = (await invoke('browser_scroll', { y: 10000 })).snapshot;
    assert.equal(snapshot.elements.find(element => element.name === 'Nested bottom').in_viewport, true, 'Default scrolling must move the app container when the window cannot scroll');
    snapshot = (await invoke('browser_navigate', { url: `${base}/other` })).snapshot;
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
    const execTimeout = await session.call('browser_exec', { code: [
      'var observed = await page_info();',
      'await click(observed.elements.find(item => item.name === "Count click").ref, {wait_for: {text: "Clicked 1 time(s)"}});',
      'print("Input completed");',
      'while (true) {}',
    ].join('\n'), timeout_ms: 2000 });
    assert.equal(execTimeout.data.error.code, 'EXEC_TIMEOUT', JSON.stringify(execTimeout.data));
    assert.equal(execTimeout.data.output, 'Input completed\n');
    assert(execTimeout.data.steps.some(step => step.helper === 'click' && step.completed && step.executed));
    const execRecovered = await invoke('browser_status');
    assert.equal(execRecovered.tabs.length, 2, 'Exec timeout recovery must preserve tabs');
    const recoveredTab = execRecovered.tabs.find(tab => tab.url === base + '/other');
    await invoke('browser_select_tab', { tab_id: recoveredTab.tab_id });
    const executedOnce = await invoke('browser_evaluate', { expression: 'window.clicks' });
    assert.equal(executedOnce.result, 1, 'Exec timeout recovery must never replay completed input');
    assert.equal(session.stderr(), '');
  } finally {
    await frameObserver?.close();
    await session?.client.close();
    await new Promise(resolve => site.close(resolve));
    await fixture.close();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

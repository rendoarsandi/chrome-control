import { parentPort, workerData } from 'node:worker_threads';
import { PassThrough } from 'node:stream';
import { builtinModules } from 'node:module';
import { inspect } from 'node:util';
import repl from 'node:repl';

let active;
let sequence = 0;
const pending = new Map();
const timers = new Set();
const errorData = error => ({
  code: error?.code || 'EXEC_ERROR',
  message: String(error?.message || error).slice(0, 4000),
  ...(error?.recovery ? { recovery: error.recovery } : {}),
});
const output = new PassThrough();
// REPL diagnostics use this private stream, never MCP stdout.
output.resume();
const session = repl.start({
  input: new PassThrough(), output, terminal: false, prompt: '',
  useGlobal: false, ignoreUndefined: true,
  writer: error => { active?.fail(error); return ''; },
});
const print = (...values) => {
  if (!active) return;
  const line = values.map(value => typeof value === 'string' ? value : inspect(value, {
    depth: 5, maxArrayLength: 100, maxStringLength: 2000, customInspect: false,
  })).join(' ') + '\n';
  const remaining = 20000 - active.outputLength;
  if (remaining > 0) parentPort.postMessage({ type: 'output', id: active.id, text: line.slice(0, remaining) });
  active.outputLength += Math.min(line.length, Math.max(0, remaining));
  if (line.length > remaining && !active.truncated) {
    active.truncated = true;
    parentPort.postMessage({ type: 'truncated', id: active.id });
  }
};
// The execution namespace supplies browser helpers, not ambient Node I/O.
// It runs assistant-authored code, not untrusted scripts taken from a page.
for (const name of new Set([...builtinModules.map(name => name.replace(/^node:/, '').split('/')[0]),
  'process', 'require', 'module', 'Buffer', 'fetch', 'global',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'])) {
  if (name !== 'console' && /^[A-Za-z_$][\w$]*$/.test(name)) Object.defineProperty(session.context, name, { value: undefined, configurable: false });
}
Object.defineProperties(session.context, {
  print: { value: print },
  console: { value: Object.freeze({ log: print, info: print, warn: print, error: print, debug: print }) },
  sleep: { value: milliseconds => {
    if (!active || !Number.isInteger(milliseconds) || milliseconds < 0 || milliseconds > 5000) {
      throw new Error('sleep requires an integer from zero to 5000 milliseconds.');
    }
    return new Promise(resolve => {
      const timer = setTimeout(() => { timers.delete(timer); resolve(); }, milliseconds);
      timers.add(timer);
    });
  } },
});
for (const name of workerData.helpers) Object.defineProperty(session.context, name, {
  value: (...args) => {
    if (!active) return Promise.reject(new Error('Browser helpers require an active browser_exec call.'));
    const id = ++sequence;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, execution: active.id, promise: null });
      try {
        if (JSON.stringify(args).length > 1000000) throw new Error('Browser helper arguments exceed one megabyte.');
        parentPort.postMessage({ type: 'helper', id: active.id, helper_id: id, name, args });
      }
      catch (error) { pending.delete(id); reject(error); }
    });
    if (pending.has(id)) pending.get(id).promise = promise;
    // Unawaited failures must not become uncaught exceptions in another call.
    promise.catch(() => {});
    return promise;
  },
});
const serialize = value => {
  if (value === undefined) return {};
  try {
    const text = JSON.stringify(value);
    if (text === undefined) return { result_text: String(value).slice(0, 20000) };
    return text.length > 20000
      ? { result_text: text.slice(0, 20000), result_truncated: true }
      : { result: JSON.parse(text) };
  } catch {
    return { result_text: inspect(value, { depth: 3, maxArrayLength: 50, maxStringLength: 2000, customInspect: false }).slice(0, 20000), result_truncated: true };
  }
};
parentPort.on('message', async message => {
  if (message.type === 'reply') {
    const request = pending.get(message.helper_id);
    if (!request || request.execution !== message.id) return;
    pending.delete(message.helper_id);
    if (message.error) request.reject(Object.assign(new Error(message.error.message), message.error));
    else request.resolve(message.value);
    return;
  }
  if (message.type !== 'execute' || active) return;
  const execution = { id: message.id, outputLength: 0, truncated: false };
  active = execution;
  try {
    const value = await new Promise((resolve, reject) => {
      execution.fail = reject;
      session.eval(message.code + '\n', session.context, 'browser_exec', (error, result) => error ? reject(error) : resolve(result));
    });
    // Finish browser requests started by code even if it forgot an await.
    while ([...pending.values()].some(request => request.execution === execution.id)) {
      await Promise.all([...pending.values()].filter(request => request.execution === execution.id).map(request => request.promise));
    }
    parentPort.postMessage({ type: 'done', id: execution.id, ...serialize(value) });
  } catch (error) {
    parentPort.postMessage({ type: 'done', id: execution.id, error: errorData(error) });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    active = null;
  }
});

import { Worker } from 'node:worker_threads';
import { ControlError, describeError } from './errors.mjs';

export class BrowserExecutor {
  constructor(helpers) {
    this.helpers = helpers;
    this.worker = null;
    this.active = null;
    this.sequence = 0;
    this.progress = {};
  }

  appendOutput(text) {
    const progress = this.progress;
    const remaining = 20000 - (progress.output?.length || 0);
    progress.output = (progress.output || '') + text.slice(0, Math.max(0, remaining));
    if (text.length > remaining) progress.output_truncated = true;
  }

  start() {
    if (this.worker) return;
    const worker = new Worker(new URL('./exec-worker.mjs', import.meta.url), {
      workerData: { helpers: this.helpers }, stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 },
    });
    this.worker = worker;
    worker.stdout.on('data', chunk => { if (this.active && this.worker === worker) this.appendOutput(chunk.toString()); });
    worker.stderr.on('data', chunk => { if (this.active && this.worker === worker) this.appendOutput(chunk.toString()); });
    worker.on('error', error => this.failWorker(worker, error));
    worker.on('exit', code => {
      if (this.worker === worker) this.failWorker(worker, new Error('Execution worker exited with code ' + code + '.'));
    });
    worker.on('message', message => {
      const active = this.active;
      if (this.worker !== worker || !active || message.id !== active.id) return;
      if (message.type === 'output') this.appendOutput(message.text);
      if (message.type === 'truncated') this.progress.output_truncated = true;
      if (message.type === 'observation_invalidated') active.options.onObservationInvalidation?.();
      if (message.type === 'helper') {
        active.pendingHelpers++;
        // Serialize helpers as well as whole MCP requests. Late work after a
        // timeout or script error is discarded before it can send more input.
        active.queue = active.queue.then(async () => {
          if (this.active !== active) return;
          if (this.progress.steps.length >= 100) {
            worker.postMessage({ type: 'reply', id: active.id, helper_id: message.helper_id,
              error: { code: 'EXEC_STEP_LIMIT', message: 'A browser_exec call supports at most 100 browser helpers.', recovery: 'Inspect the completed steps and continue in another call.' } });
            return;
          }
          const step = { index: this.progress.steps.length, helper: message.name };
          this.progress.steps.push(step);
          try {
            const value = await active.invoke(message.name, message.args);
            if (this.active !== active) return;
            step.completed = true;
            worker.postMessage({ type: 'reply', id: active.id, helper_id: message.helper_id, value });
          } catch (error) {
            if (this.active !== active) return;
            step.error = describeError(error);
            worker.postMessage({ type: 'reply', id: active.id, helper_id: message.helper_id, error: step.error });
          }
        }).catch(error => this.failWorker(worker, error)).finally(() => { active.pendingHelpers--; });
      }
      if (message.type === 'done') {
        clearTimeout(active.timer);
        this.active = null;
        if (message.error) {
          if (active.pendingHelpers) {
            this.progress.session_reset = true;
            this.reset();
            message.error = { code: 'EXEC_ABORTED', message: message.error.message,
              recovery: 'Code failed with browser helpers still pending. The session was reset. Inspect the page before repeating input.' };
          }
          active.reject(new ControlError(message.error.code, message.error.message,
            message.error.recovery || 'Inspect output and completed steps before repeating input. Variables persist unless session_reset is true.'));
        } else {
          const { type, id, ...value } = message;
          this.progress = { ...this.progress, ...value, completed: true };
          active.resolve({ ...this.progress });
        }
      }
    });
  }

  failWorker(worker, error) {
    if (this.worker !== worker) return;
    this.progress.session_reset = true;
    this.reset(new ControlError('EXEC_WORKER_FAILED', error.message,
      'The execution namespace was reset. Inspect the page and completed steps before trying again.'));
  }

  run(code, invoke, timeout, options = {}) {
    this.progress = { action: 'exec', output: '', steps: [] };
    this.start();
    return new Promise((resolve, reject) => {
      const active = { id: ++this.sequence, invoke, resolve, reject, options, queue: Promise.resolve(), pendingHelpers: 0 };
      this.active = active;
      active.timer = setTimeout(() => {
        this.progress.session_reset = true;
        this.reset(new ControlError('EXEC_TIMEOUT', 'Browser execution exceeded ' + timeout + ' ms.',
          'The execution namespace and browser connection were reset. Inspect the page and completed steps; input is never replayed.'));
      }, timeout);
      this.worker.postMessage({ type: 'execute', id: active.id, code,
        summarizeSnapshots: options.summarizeSnapshots, helperSources: options.helperSources || [] });
    });
  }

  reset(error = new ControlError('CONNECTION_RESET', 'The execution session was reset.', 'Inspect the page and start a new browser_exec call.')) {
    const worker = this.worker;
    this.worker = null;
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(error); }
    this.active = null;
    worker?.terminate().catch(() => {});
  }
}

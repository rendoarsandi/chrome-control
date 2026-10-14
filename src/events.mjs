import { ControlError } from './errors.mjs';

// Selected-page CDP events; no browser-global preferences, response bodies or
// headers. Explicit watching before an action avoids claiming prior coverage.
export class PageEvents {
  constructor(session) {
    this.session = session;
    this.queue = [];
    this.bytes = 0;
    this.dropped = 0;
    this.inflight = new Set();
    this.lastActivity = Date.now();
    this.closed = false;
    this.listeners = [];
    const on = (name, handler) => {
      const listener = value => { if (!this.closed) handler(value); };
      session.on(name, listener);
      this.listeners.push([name, listener]);
    };
    on('Network.requestWillBeSent', event => {
      this.lastActivity = Date.now();
      if (!['WebSocket', 'EventSource'].includes(event.type)) this.inflight.add(event.requestId);
      this.push({ type: 'request', request_id: event.requestId, url: event.request.url, method: event.request.method, resource_type: event.type });
    });
    on('Network.responseReceived', event => this.push({ type: 'response', request_id: event.requestId,
      url: event.response.url, status: event.response.status, mime_type: event.response.mimeType }));
    for (const [name, type] of [['Network.loadingFinished', 'finished'], ['Network.loadingFailed', 'failed']]) on(name, event => {
      this.lastActivity = Date.now();
      this.inflight.delete(event.requestId);
      this.push({ type, request_id: event.requestId, ...(event.errorText ? { error: event.errorText } : {}) });
    });
    on('Runtime.consoleAPICalled', event => this.push({ type: 'console', level: event.type,
      text: event.args.map(value => value.value !== undefined ? String(value.value) : value.description || value.type).join(' ').slice(0, 4000) }));
    on('Runtime.exceptionThrown', event => this.push({ type: 'exception', text: (event.exceptionDetails.exception?.description || event.exceptionDetails.text).slice(0, 4000) }));
    on('Page.frameNavigated', event => this.push({ type: 'navigation', frame_id: event.frame.id, url: event.frame.url }));
    on('Page.loadEventFired', () => this.push({ type: 'load' }));
  }

  async start() {
    await this.session.send('Network.enable');
    await this.session.send('Runtime.enable');
    await this.session.send('Page.enable');
  }

  push(event) {
    const bounded = Object.fromEntries(Object.entries(event).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 4000) : value]));
    const value = { timestamp: Date.now(), ...bounded };
    const bytes = JSON.stringify(value).length;
    this.queue.push({ value, bytes });
    this.bytes += bytes;
    while (this.queue.length > 256 || this.bytes > 262144) {
      this.bytes -= this.queue.shift().bytes;
      this.dropped++;
    }
  }

  drain({ types, max_events = 100 } = {}) {
    const events = [];
    this.queue = this.queue.filter(item => {
      if (events.length >= max_events || types && !types.includes(item.value.type)) return true;
      events.push(item.value);
      this.bytes -= item.bytes;
      return false;
    });
    const dropped = this.dropped;
    this.dropped = 0;
    return { events, dropped, remaining: this.queue.length };
  }

  async idle({ idle_ms = 500, timeout_ms = 5000 } = {}) {
    const started = Date.now();
    do {
      if (this.closed) throw new ControlError('EVENT_STREAM_CLOSED', 'The watched page disconnected.', 'Select the intended tab and call watch_events() again.');
      if (!this.inflight.size && Date.now() - Math.max(started, this.lastActivity) >= idle_ms) return { matched: true, idle_ms };
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, timeout_ms - (Date.now() - started)))));
    } while (Date.now() - started < timeout_ms);
    return { matched: false, timeout_ms, pending_requests: this.inflight.size, recovery: 'Inspect the page and drain_events(); input is not repeated.' };
  }

  close() {
    this.closed = true;
    for (const [name, listener] of this.listeners) this.session.off(name, listener);
    this.queue = [];
    this.session.detach().catch(() => {});
  }
}

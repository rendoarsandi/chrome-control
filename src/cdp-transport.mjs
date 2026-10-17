import WebSocket from 'ws';

// Playwright initializes every page reported during connection. Android can
// suspend background renderers, so hold their attachment events until the
// controller selects a target. Discovery uses browser metadata, not renderers.
export async function connectTransport(endpoint, { timeout, signal }) {
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => abort.abort(new Error('CDP connection timed out.')), timeout);
  let socket;
  try {
    let url = new URL(endpoint);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      url.pathname = `${url.pathname.replace(/\/$/, '')}/json/version`;
      const response = await fetch(url, { signal: abort.signal });
      if (!response.ok) throw new Error(`CDP discovery returned HTTP ${response.status}.`);
      const version = await response.json();
      url = new URL(version.webSocketDebuggerUrl);
    }
    abort.signal.throwIfAborted();
    socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const cancelled = () => { socket.terminate(); reject(abort.signal.reason); };
      const cleanup = () => abort.signal.removeEventListener('abort', cancelled);
      abort.signal.addEventListener('abort', cancelled, { once: true });
      socket.once('open', () => { cleanup(); resolve(); });
      socket.once('error', error => { cleanup(); reject(error); });
      socket.once('close', () => { cleanup(); reject(new Error('CDP socket closed during connection.')); });
    });
    const disconnect = () => socket.terminate();
    signal?.addEventListener('abort', disconnect, { once: true });
    socket.once('close', () => signal?.removeEventListener('abort', disconnect));
    abort.signal.throwIfAborted();
    return pageTransport(socket);
  } catch (error) {
    socket?.terminate();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

function pageTransport(socket) {
  let nextId = 0;
  let discovering = false;
  const pending = new Map();
  const deferred = new Map();
  const deferredSessions = new Set();
  const allowed = new Set();
  const publish = targetId => {
    const event = deferred.get(targetId);
    if (!event || !event.params.targetInfo.url || event.params.targetInfo.url === ':' || !allowed.has(targetId)) return false;
    deferred.delete(targetId);
    deferredSessions.delete(event.params.sessionId);
    transport.onmessage?.(event);
    return true;
  };
  const transport = {
    send(message) {
      if (!message.sessionId && message.method === 'Target.setAutoAttach' && message.params.autoAttach && !discovering) {
        discovering = true;
        internal('Target.setDiscoverTargets', { discover: true });
      }
      socket.send(JSON.stringify(message));
    },
    attachTarget(targetId) {
      allowed.add(targetId);
      publish(targetId);
    },
    close() { socket.terminate(); },
  };
  const internal = (method, params, sessionId, done = () => {}) => {
    const id = --nextId; // Playwright uses positive request IDs.
    const timer = setTimeout(() => {
      pending.delete(id);
      done({ error: { message: 'CDP target request timed out.' } });
    }, 2000);
    timer.unref();
    pending.set(id, { timer, done });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  };
  socket.on('message', data => {
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { socket.terminate(); return; }
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.done(message);
      return;
    }
    // A timed-out internal command may still reply after its callback expires.
    if (message.id < 0) return;
    if (!message.sessionId && message.method === 'Target.attachedToTarget') {
      const { targetInfo: info, sessionId, waitingForDebugger } = message.params;
      if (info.type === 'page') {
        deferred.set(info.targetId, message);
        deferredSessions.add(sessionId);
        // Only new popups of an attached page inherit attachment. Existing
        // background tabs with a historical opener remain deferred.
        if (allowed.has(info.openerId)) allowed.add(info.targetId);
        // Do not leave pages paused just because this client has not selected
        // them. This command is fire-and-forget with a bounded callback.
        if (!publish(info.targetId) && waitingForDebugger) internal('Runtime.runIfWaitingForDebugger', {}, sessionId);
        return;
      }
    }
    if (!message.sessionId && message.method === 'Target.targetInfoChanged') {
      const info = message.params.targetInfo;
      const event = deferred.get(info.targetId);
      if (event) { event.params.targetInfo = info; publish(info.targetId); }
    }
    if (!message.sessionId && message.method === 'Target.targetDestroyed') {
      const targetId = message.params.targetId;
      const event = deferred.get(targetId);
      if (event) deferredSessions.delete(event.params.sessionId);
      deferred.delete(targetId);
      allowed.delete(targetId);
    }
    if (!message.sessionId && message.method === 'Target.detachedFromTarget' && deferredSessions.delete(message.params.sessionId)) {
      deferred.delete(message.params.targetId);
      return;
    }
    if (deferredSessions.has(message.sessionId)) return;
    transport.onmessage?.(message);
  });
  socket.on('error', () => socket.terminate());
  socket.on('close', (_code, reason) => {
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    deferred.clear();
    deferredSessions.clear();
    allowed.clear();
    transport.onclose?.(reason.toString());
  });
  return transport;
}

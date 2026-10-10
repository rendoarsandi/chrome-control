import WebSocket from 'ws';

// Android can expose a native Chrome UI target with an empty URL. Playwright
// waits indefinitely for its first navigation during connectOverCDP. Leave that
// target alone and attach when Chrome advertises an actual page URL instead.
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
  const excluded = new Map();
  const excludedSessions = new Set();
  const transport = {
    send(message) {
      if (!message.sessionId && message.method === 'Target.setAutoAttach' && message.params.autoAttach && !discovering) {
        discovering = true;
        internal('Target.setDiscoverTargets', { discover: true });
      }
      socket.send(JSON.stringify(message));
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
  const attachReady = targetId => {
    const target = excluded.get(targetId);
    if (!target || target.detaching || target.attaching || !target.info.url || target.info.url === ':') return;
    target.attaching = true;
    internal('Target.attachToTarget', { targetId, flatten: true }, undefined, () => { target.attaching = false; });
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
      if (info.type === 'page' && (!info.url || info.url === ':')) {
        const target = { info, sessionId, detaching: true, attaching: false };
        excluded.set(info.targetId, target);
        excludedSessions.add(sessionId);
        if (waitingForDebugger) internal('Runtime.runIfWaitingForDebugger', {}, sessionId);
        internal('Target.detachFromTarget', { sessionId }, undefined, () => {
          if (excluded.get(info.targetId) !== target) return;
          target.detaching = false;
          attachReady(info.targetId);
        });
        return;
      }
      excluded.delete(info.targetId);
    }
    if (!message.sessionId && message.method === 'Target.targetInfoChanged') {
      const info = message.params.targetInfo;
      const target = excluded.get(info.targetId);
      if (target) { target.info = info; attachReady(info.targetId); }
    }
    if (!message.sessionId && message.method === 'Target.targetDestroyed') {
      const target = excluded.get(message.params.targetId);
      if (target) excludedSessions.delete(target.sessionId);
      excluded.delete(message.params.targetId);
    }
    if (!message.sessionId && message.method === 'Target.detachedFromTarget' && excludedSessions.delete(message.params.sessionId)) return;
    if (excludedSessions.has(message.sessionId)) return;
    transport.onmessage?.(message);
  });
  socket.on('error', () => socket.terminate());
  socket.on('close', (_code, reason) => {
    for (const request of pending.values()) clearTimeout(request.timer);
    pending.clear();
    excluded.clear();
    excludedSessions.clear();
    transport.onclose?.(reason.toString());
  });
  return transport;
}

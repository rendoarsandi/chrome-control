export class ControlError extends Error {
  constructor(code, message, recovery, details) {
    super(message);
    this.code = code;
    this.recovery = recovery;
    this.details = details;
  }
}

export function describeError(error) {
  return {
    code: error.code || (/timeout|timed out/i.test(error.message) ? 'TIMEOUT' : 'BROWSER_ERROR'),
    message: error.message,
    recovery: error.recovery || 'Call browser_snapshot for fresh state. If disconnected, call browser_status to reconnect. Do not blindly repeat a submitted action.',
    ...(error.details ? { details: error.details } : {}),
  };
}

export async function withDeadline(operation, milliseconds, timeoutError) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError || new ControlError(
          'REQUEST_TIMEOUT', `Browser request exceeded ${milliseconds} ms.`,
          'The connection was reset. Call browser_status, then inspect the page before repeating an action; it may already have executed.',
        )), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function needsReconnect(error) {
  return ['REQUEST_TIMEOUT', 'SESSION_TIMEOUT', 'SNAPSHOT_TIMEOUT', 'CDP_UNAVAILABLE', 'CDP_UNRESPONSIVE', 'CONNECTION_RESET'].includes(error.code) ||
    /browser has been closed|browser disconnected|connection closed|websocket.*(?:closed|hang up)/i.test(error.message);
}

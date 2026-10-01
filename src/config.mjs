export function readConfig(env = process.env) {
  const number = (key, fallback, min, max) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be an integer between ${min} and ${max}.`);
    }
    return value;
  };
  const endpoint = env.CHROME_CDP_URL || 'http://127.0.0.1:9222';
  const url = new URL(endpoint);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error('CHROME_CDP_URL must be an HTTP or WebSocket CDP endpoint.');
  }
  if (env.CHROME_AUTO_ADB && !['0', '1'].includes(env.CHROME_AUTO_ADB)) {
    throw new Error('CHROME_AUTO_ADB must be 0 or 1.');
  }
  return {
    endpoint,
    autoAdb: env.CHROME_AUTO_ADB !== '0',
    serial: env.ANDROID_SERIAL || undefined,
    package: env.CHROME_ANDROID_PACKAGE || 'com.android.chrome',
    socket: env.CHROME_DEVTOOLS_SOCKET || 'chrome_devtools_remote',
    actionTimeout: number('CHROME_ACTION_TIMEOUT_MS', 8000, 1000, 30000),
    requestTimeout: number('CHROME_REQUEST_TIMEOUT_MS', 30000, 10000, 60000),
  };
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ControlError } from './errors.mjs';

const execute = promisify(execFile);

export function canForward(endpoint) {
  const url = new URL(endpoint);
  return ['http:', 'ws:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

export async function forwardChrome(config, run = execute, { signal, reconnect = false } = {}) {
  const url = new URL(config.endpoint);
  if (!canForward(config.endpoint)) {
    throw new ControlError('CDP_UNAVAILABLE', 'The configured remote CDP endpoint is unreachable.',
      'Check CHROME_CDP_URL and the forwarding tunnel on the machine running this server.');
  }
  const adb = async (args) => {
    signal?.throwIfAborted();
    return (await run('adb', args, { timeout: 5000, maxBuffer: 256 * 1024, ...(signal ? { signal } : {}) })).stdout;
  };
  let serial = config.serial;
  try {
    if (!serial) {
      const output = await adb(['devices']);
      const devices = output.split(/\r?\n/).map(line => line.trim().split(/\s+/))
        .filter(parts => parts[1] === 'device').map(parts => parts[0]);
      if (devices.length !== 1) {
        throw new ControlError('ADB_DEVICE_REQUIRED',
          devices.length ? 'Multiple authorized ADB devices are connected.' : 'No authorized ADB device is connected.',
          devices.length ? 'Set ANDROID_SERIAL to the intended device serial from adb devices.' : 'Pair and connect wireless debugging, then check adb devices. See the README Termux setup.',
          { devices });
      }
      [serial] = devices;
    }
    // Wireless ports can change without changing the MCP configuration. An
    // explicitly supplied address is safe to reconnect with existing ADB keys.
    if (/^(?:\[[\da-f:]+\]|[\w.-]+):\d{1,5}$/i.test(serial)) {
      if (reconnect) await adb(['disconnect', serial]);
      await adb(['connect', serial]);
    }
    await adb(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', config.package]);
    const port = url.port || '80';
    await adb(['-s', serial, 'forward', `tcp:${port}`, `localabstract:${config.socket}`]);
    return { serial, port: Number(port) };
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError('ADB_FAILED', `ADB setup failed: ${error.message}`,
      'Check adb devices and keep Chrome open. If the wireless port changed, call browser_status with android_serial set to the current address (IP:port). Pair again only if authorization was revoked.');
  }
}

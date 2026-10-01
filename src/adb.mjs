import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ControlError } from './errors.mjs';

const execute = promisify(execFile);

export async function forwardChrome(config, run = execute) {
  const url = new URL(config.endpoint);
  if (!['http:', 'ws:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new ControlError('CDP_UNAVAILABLE', 'The configured remote CDP endpoint is unreachable.',
      'Check CHROME_CDP_URL and the forwarding tunnel on the machine running this server.');
  }
  const adb = async (args) => (await run('adb', args, { timeout: 5000, maxBuffer: 256 * 1024 })).stdout;
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
    await adb(['-s', serial, 'shell', 'monkey', '-p', config.package, '-c', 'android.intent.category.LAUNCHER', '1']);
    const port = url.port || '80';
    await adb(['-s', serial, 'forward', `tcp:${port}`, `localabstract:${config.socket}`]);
    return { serial, port: Number(port) };
  } catch (error) {
    if (error instanceof ControlError) throw error;
    throw new ControlError('ADB_FAILED', `ADB setup failed: ${error.message}`,
      'Install android-tools, open Chrome, and confirm adb devices lists an authorized device. Set ANDROID_SERIAL if needed.');
  }
}

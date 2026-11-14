import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { ControlError } from './errors.mjs';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const MIME_EXTENSION_MAP = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/wave': '.wav',
  'audio/mp4': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/flac': '.flac',
  'audio/opus': '.opus',
};

const KNOWN_MEDIA_EXT_PATTERN = /^\.(mp4|webm|ogg|ogv|mov|mp3|wav|m4a|aac|flac|opus|mkv)$/;

/**
 * Infer a local file extension from a media MIME type or URL pathname.
 */
export function inferMediaExtension(mimeType = '', mediaUrl = '') {
  const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (MIME_EXTENSION_MAP[normalizedMime]) {
    return MIME_EXTENSION_MAP[normalizedMime];
  }
  if (mediaUrl && !mediaUrl.startsWith('data:') && !mediaUrl.startsWith('blob:')) {
    try {
      const ext = extname(new URL(mediaUrl).pathname).toLowerCase();
      if (KNOWN_MEDIA_EXT_PATTERN.test(ext)) return ext;
    } catch {}
  }
  if (normalizedMime.includes('webm')) return '.webm';
  if (normalizedMime.startsWith('video/')) return '.mp4';
  if (normalizedMime.startsWith('audio/')) return '.mp3';
  return '.bin';
}

/**
 * Validate an explicit absolute output path or generate a temporary media path.
 */
export function resolveMediaOutputPath(explicitPath, mimeType, mediaUrl) {
  if (explicitPath !== undefined) {
    if (!isAbsolute(explicitPath)) {
      throw new ControlError(
        'MEDIA_PATH_INVALID',
        'Media output path must be an absolute local path.',
        'Use the full path on the machine running the MCP server.',
      );
    }
    return explicitPath;
  }
  const ext = inferMediaExtension(mimeType, mediaUrl);
  return join(tmpdir(), `chrome-control-media-${randomUUID()}${ext}`);
}

/**
 * Decode a data: URL into a bounded Buffer and MIME type.
 */
export function parseDataUrl(dataUrl, maxBytes = MAX_MEDIA_BYTES) {
  const match = /^data:([^,]*),(.*)$/s.exec(String(dataUrl || ''));
  if (!match) {
    throw new ControlError(
      'MEDIA_URL_INVALID',
      'Invalid data URL for media.',
      'Provide a valid data, blob, http, or https media URL.',
    );
  }
  const parts = match[1].split(';').map(part => part.trim()).filter(Boolean);
  const isBase64 = parts.at(-1)?.toLowerCase() === 'base64';
  const mediaParts = isBase64 ? parts.slice(0, -1) : parts;
  const mimeType = mediaParts[0]?.includes('/') ? mediaParts[0].toLowerCase() : 'application/octet-stream';
  let buffer;
  try {
    buffer = isBase64
      ? Buffer.from(match[2], 'base64')
      : Buffer.from(decodeURIComponent(match[2]), 'utf8');
  } catch (error) {
    throw new ControlError(
      'MEDIA_URL_INVALID',
      `Failed to decode media data URL: ${error.message}`,
      'Provide a valid data, blob, http, or https media URL.',
    );
  }
  if (buffer.length > maxBytes) {
    throw new ControlError(
      'MEDIA_SIZE_LIMIT',
      'Media file exceeds the 50 MiB download limit.',
      'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
    );
  }
  return { buffer, mimeType };
}

/**
 * Download an HTTP/HTTPS media resource from Node while enforcing a strict byte limit.
 */
export async function fetchMediaFromNode(mediaUrl, { pageUrl, timeoutMs = 15000, maxBytes = MAX_MEDIA_BYTES } = {}) {
  let parsed;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    throw new ControlError(
      'MEDIA_URL_INVALID',
      'Media URL is not valid.',
      'Provide an http, https, blob, or data URL.',
    );
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ControlError(
      'MEDIA_URL_INVALID',
      `Unsupported media URL protocol: ${parsed.protocol}`,
      'Provide an http, https, blob, or data URL.',
    );
  }
  const headers = {};
  if (pageUrl && /^https?:\/\//i.test(pageUrl)) {
    headers.Referer = pageUrl;
  }
  let response;
  try {
    response = await fetch(mediaUrl, {
      headers,
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    });
  } catch (error) {
    throw new ControlError(
      'MEDIA_DOWNLOAD_FAILED',
      `Failed to fetch media URL: ${error.message}`,
      'Verify the media URL is reachable or try mode: "page" or operation: "record".',
    );
  }
  if (!response.ok) {
    response.body?.cancel().catch(() => {});
    throw new ControlError(
      'MEDIA_DOWNLOAD_FAILED',
      `Media request failed with HTTP ${response.status}.`,
      'Try mode: "page" if the media requires browser cookies, or operation: "record".',
      { status: response.status, url: mediaUrl },
    );
  }
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    response.body?.cancel().catch(() => {});
    throw new ControlError(
      'MEDIA_SIZE_LIMIT',
      'Media file exceeds the 50 MiB download limit.',
      'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
    );
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new ControlError(
            'MEDIA_SIZE_LIMIT',
            'Media file exceeds the 50 MiB download limit.',
            'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
          );
        }
        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new ControlError(
        'MEDIA_SIZE_LIMIT',
        'Media file exceeds the 50 MiB download limit.',
        'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
      );
    }
    chunks.push(Buffer.from(bytes));
  }
  const buffer = Buffer.concat(chunks);
  const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  return { buffer, mimeType };
}

/**
 * Browser-evaluated helper: collect all <video>/<audio> descriptors and cues in a frame.
 */
export function collectFrameMedia({ mediaType = 'any' } = {}) {
  const selector = mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'audio' : 'video, audio';
  const roots = [document];
  const candidates = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    candidates.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  const items = [];
  for (const element of new Set(candidates)) {
    const tag = element.tagName.toLowerCase();
    const sources = Array.from(element.querySelectorAll('source'))
      .map(source => ({ src: source.src || source.getAttribute('src') || '', type: source.type || '' }))
      .filter(source => source.src);
    const src = element.currentSrc || element.getAttribute('src') || sources[0]?.src || '';
    const tracks = Array.from(element.querySelectorAll('track')).map(track => ({
      kind: track.kind || '',
      label: track.label || '',
      srclang: track.srclang || '',
      src: track.src || '',
    }));
    const cues = [];
    if (element.textTracks) {
      for (const track of Array.from(element.textTracks)) {
        if (!track.cues) continue;
        for (const cue of Array.from(track.cues)) {
          if (cues.length >= 200) break;
          cues.push({
            kind: track.kind || '',
            language: track.language || '',
            label: track.label || '',
            start: Number.isFinite(cue.startTime) ? Math.round(cue.startTime * 1000) / 1000 : null,
            end: Number.isFinite(cue.endTime) ? Math.round(cue.endTime * 1000) / 1000 : null,
            text: String(cue.text || '').slice(0, 1000),
          });
        }
      }
    }
    items.push({
      index: items.length,
      tag,
      src,
      sources,
      poster: tag === 'video' ? (element.poster || '') : '',
      duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
      current_time: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : 0,
      paused: Boolean(element.paused),
      muted: Boolean(element.muted),
      ended: Boolean(element.ended),
      playback_rate: element.playbackRate,
      ready_state: element.readyState,
      width: tag === 'video' ? (element.videoWidth || 0) : 0,
      height: tag === 'video' ? (element.videoHeight || 0) : 0,
      is_blob: src.startsWith('blob:'),
      tracks,
      ...(cues.length ? { cues } : {}),
    });
  }
  return items;
}

/**
 * Browser-evaluated helper: return matching <video>/<audio> elements in DOM/shadow order.
 */
export function findFrameMediaElements({ mediaType = 'any' } = {}) {
  const selector = mediaType === 'video' ? 'video' : mediaType === 'audio' ? 'audio' : 'video, audio';
  const roots = [document];
  const candidates = [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    candidates.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return Array.from(new Set(candidates));
}

/**
 * Browser-evaluated helper: read basic metadata for one resolved <video>/<audio> element.
 */
export function inspectElementMedia(element) {
  const sources = Array.from(element.querySelectorAll('source'))
    .map(source => ({ src: source.src || source.getAttribute('src') || '', type: source.type || '' }))
    .filter(source => source.src);
  const src = element.currentSrc || element.getAttribute('src') || sources[0]?.src || '';
  const tracks = Array.from(element.querySelectorAll('track')).map(track => ({
    kind: track.kind || '',
    label: track.label || '',
    srclang: track.srclang || '',
    src: track.src || '',
  }));
  return {
    tag: element.tagName.toLowerCase(),
    src,
    sources,
    tracks,
    duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
    current_time: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : 0,
    paused: Boolean(element.paused),
    muted: Boolean(element.muted),
    ended: Boolean(element.ended),
  };
}

/**
 * Browser-evaluated helper: fetch a media or blob URL inside the page context.
 */
export async function fetchMediaInPage({ mediaUrl, maxBytes }) {
  try {
    const response = await fetch(mediaUrl, { credentials: 'include' });
    if (!response.ok) {
      return { ok: false, status: response.status, error: `HTTP ${response.status}` };
    }
    const contentLength = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return { ok: false, size_exceeded: true, bytes: contentLength, error: 'Media file exceeds the download byte limit.' };
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      return { ok: false, size_exceeded: true, bytes: buffer.byteLength, error: 'Media file exceeds the download byte limit.' };
    }
    const bytes = new Uint8Array(buffer);
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x4000) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x4000)));
    }
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
    return { ok: true, mime_type: mimeType, bytes: bytes.length, data_base64: btoa(parts.join('')) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Browser-evaluated helper: record a live stream from a <video>/<audio> element via MediaRecorder.
 */
export async function recordElementMedia(element, { durationMs = 5000, maxBytes = MAX_MEDIA_BYTES, playIfPaused = true, audioOnly = false } = {}) {
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, code: 'MEDIA_RECORD_UNSUPPORTED', message: 'MediaRecorder is not supported in this browser.' };
  }
  const capture = element.captureStream || element.mozCaptureStream;
  if (typeof capture !== 'function') {
    return { ok: false, code: 'MEDIA_RECORD_UNSUPPORTED', message: 'captureStream is not supported for this media element.' };
  }
  const wasPaused = element.paused;
  let startedPlayback = false;
  if (playIfPaused && wasPaused) {
    try {
      await element.play();
      startedPlayback = true;
    } catch {}
  }
  let rawStream;
  let stream;
  try {
    rawStream = capture.call(element);
    stream = rawStream;
  } catch (error) {
    if (startedPlayback && !element.paused) element.pause();
    return { ok: false, code: 'MEDIA_RECORD_FAILED', message: error?.message || 'Failed to capture media stream.' };
  }
  try {
    if (audioOnly) {
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) {
        return { ok: false, code: 'MEDIA_NO_AUDIO_TRACK', message: 'No audio track is available on this media element.' };
      }
      stream = new MediaStream(audioTracks);
    }
    if (!stream.getTracks().length) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 400);
        const onTrack = () => { clearTimeout(timer); resolve(); };
        stream.addEventListener('addtrack', onTrack, { once: true });
      });
    }
    if (!stream.getTracks().length) {
      return { ok: false, code: 'MEDIA_EMPTY_STREAM', message: 'The media element produced no active audio or video tracks.' };
    }
    const isAudio = audioOnly || element.tagName === 'AUDIO';
    const candidates = isAudio
      ? ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
      : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const chosenMime = candidates.find(type => MediaRecorder.isTypeSupported(type)) || '';
    const recorder = chosenMime ? new MediaRecorder(stream, { mimeType: chosenMime }) : new MediaRecorder(stream);
    const chunks = [];
    let totalBytes = 0;
    let sizeExceeded = false;
    const blob = await new Promise((resolve, reject) => {
      let timer;
      const finish = () => {
        if (recorder.state !== 'inactive') {
          try { recorder.stop(); } catch {}
        }
      };
      const onEnded = () => finish();
      element.addEventListener('ended', onEnded, { once: true });
      recorder.ondataavailable = event => {
        if (event.data && event.data.size > 0) {
          totalBytes += event.data.size;
          if (totalBytes > maxBytes) {
            sizeExceeded = true;
            finish();
            return;
          }
          chunks.push(event.data);
        }
      };
      recorder.onerror = event => {
        clearTimeout(timer);
        element.removeEventListener('ended', onEnded);
        reject(new Error(event?.error?.message || 'MediaRecorder error'));
      };
      recorder.onstop = () => {
        clearTimeout(timer);
        element.removeEventListener('ended', onEnded);
        const fallbackMime = isAudio ? 'audio/webm' : 'video/webm';
        resolve(new Blob(chunks, { type: recorder.mimeType || chosenMime || fallbackMime }));
      };
      timer = setTimeout(finish, durationMs);
      recorder.start(250);
    });
    if (sizeExceeded || blob.size > maxBytes) {
      return { ok: false, code: 'MEDIA_SIZE_LIMIT', message: 'Recorded media exceeds the 50 MiB size limit.' };
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x4000) {
      parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x4000)));
    }
    const mimeType = (blob.type || (isAudio ? 'audio/webm' : 'video/webm')).split(';')[0].trim().toLowerCase();
    return {
      ok: true,
      mime_type: mimeType,
      bytes: bytes.length,
      data_base64: btoa(parts.join('')),
      current_time: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : 0,
      duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
    };
  } catch (error) {
    return { ok: false, code: 'MEDIA_RECORD_FAILED', message: error?.message || String(error) };
  } finally {
    if (rawStream) {
      for (const track of rawStream.getTracks()) {
        try { track.stop(); } catch {}
      }
    }
    if (startedPlayback && !element.paused) {
      try { element.pause(); } catch {}
    }
  }
}

/**
 * Browser-evaluated helper: control playback, seek, mute, or speed of a <video>/<audio> element.
 */
export async function controlElementMedia(element, { controlAction, currentTime, muted, playbackRate } = {}) {
  if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
    element.currentTime = currentTime;
  }
  if (typeof muted === 'boolean') {
    element.muted = muted;
  }
  if (typeof playbackRate === 'number' && Number.isFinite(playbackRate)) {
    element.playbackRate = playbackRate;
  }
  if (controlAction === 'play') {
    await element.play();
  } else if (controlAction === 'pause') {
    element.pause();
  } else if (controlAction === 'mute') {
    element.muted = true;
  } else if (controlAction === 'unmute') {
    element.muted = false;
  }
  return {
    tag: element.tagName.toLowerCase(),
    src: element.currentSrc || element.getAttribute('src') || '',
    current_time: Number.isFinite(element.currentTime) ? Math.round(element.currentTime * 1000) / 1000 : 0,
    duration: Number.isFinite(element.duration) ? Math.round(element.duration * 1000) / 1000 : null,
    paused: Boolean(element.paused),
    muted: Boolean(element.muted),
    ended: Boolean(element.ended),
    playback_rate: element.playbackRate,
  };
}

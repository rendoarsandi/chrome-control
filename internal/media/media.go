package media

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/errs"
)

const MaxMediaBytes = 50 * 1024 * 1024

var mimeExtensionMap = map[string]string{
	"video/mp4":        ".mp4",
	"video/webm":       ".webm",
	"video/ogg":        ".ogv",
	"video/quicktime":  ".mov",
	"video/x-matroska": ".mkv",
	"audio/mpeg":       ".mp3",
	"audio/mp3":        ".mp3",
	"audio/webm":       ".webm",
	"audio/ogg":        ".ogg",
	"audio/wav":        ".wav",
	"audio/x-wav":      ".wav",
	"audio/wave":       ".wav",
	"audio/mp4":        ".m4a",
	"audio/x-m4a":      ".m4a",
	"audio/m4a":        ".m4a",
	"audio/aac":        ".aac",
	"audio/flac":       ".flac",
	"audio/opus":       ".opus",
}

var knownMediaExtPattern = regexp.MustCompile(`^\.(mp4|webm|ogg|ogv|mov|mp3|wav|m4a|aac|flac|opus|mkv)$`)

// InferMediaExtension infers a local file extension from MIME type or URL pathname.
func InferMediaExtension(mimeType, mediaURL string) string {
	norm := strings.ToLower(strings.TrimSpace(strings.SplitN(mimeType, ";", 2)[0]))
	if ext, ok := mimeExtensionMap[norm]; ok {
		return ext
	}
	if mediaURL != "" && !strings.HasPrefix(mediaURL, "data:") && !strings.HasPrefix(mediaURL, "blob:") {
		if u, err := url.Parse(mediaURL); err == nil {
			ext := strings.ToLower(filepath.Ext(u.Path))
			if knownMediaExtPattern.MatchString(ext) {
				return ext
			}
		}
	}
	if strings.Contains(norm, "webm") {
		return ".webm"
	}
	if strings.HasPrefix(norm, "video/") {
		return ".mp4"
	}
	if strings.HasPrefix(norm, "audio/") {
		return ".mp3"
	}
	return ".bin"
}

// ResolveMediaOutputPath validates an explicit absolute path or creates a temp filename.
func ResolveMediaOutputPath(explicitPath, mimeType, mediaURL string) (string, error) {
	if explicitPath != "" {
		if !filepath.IsAbs(explicitPath) {
			return "", errs.New(
				"MEDIA_PATH_INVALID",
				"Media output path must be an absolute local path.",
				"Use the full path on the machine running the MCP server.",
				nil,
			)
		}
		return explicitPath, nil
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	ext := InferMediaExtension(mimeType, mediaURL)
	return filepath.Join(os.TempDir(), fmt.Sprintf("chrome-control-media-%s%s", hex.EncodeToString(b[:]), ext)), nil
}

// ParseDataURL decodes a data: URL into bounded bytes and MIME type.
func ParseDataURL(dataURL string, maxBytes int) ([]byte, string, error) {
	if maxBytes <= 0 {
		maxBytes = MaxMediaBytes
	}
	if !strings.HasPrefix(dataURL, "data:") {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Invalid data URL for media.", "Provide a valid data, blob, http, or https media URL.", nil)
	}
	rest := dataURL[len("data:"):]
	comma := strings.IndexByte(rest, ',')
	if comma < 0 {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Invalid data URL for media.", "Provide a valid data, blob, http, or https media URL.", nil)
	}
	meta := rest[:comma]
	payload := rest[comma+1:]
	parts := strings.Split(meta, ";")
	isBase64 := false
	var mediaParts []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			mediaParts = append(mediaParts, p)
		}
	}
	if len(mediaParts) > 0 && strings.EqualFold(mediaParts[len(mediaParts)-1], "base64") {
		isBase64 = true
		mediaParts = mediaParts[:len(mediaParts)-1]
	}
	mimeType := "application/octet-stream"
	if len(mediaParts) > 0 && strings.Contains(mediaParts[0], "/") {
		mimeType = strings.ToLower(mediaParts[0])
	}

	var data []byte
	var err error
	if isBase64 {
		data, err = base64.StdEncoding.DecodeString(payload)
		if err != nil {
			data, err = base64.RawStdEncoding.DecodeString(strings.TrimSpace(payload))
		}
	} else {
		var decoded string
		decoded, err = url.PathUnescape(payload)
		data = []byte(decoded)
	}
	if err != nil {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Failed to decode media data URL: "+err.Error(), "Provide a valid data, blob, http, or https media URL.", nil)
	}
	if len(data) > maxBytes {
		return nil, "", errs.New("MEDIA_SIZE_LIMIT", "Media file exceeds the 50 MiB download limit.", `Use operation: "record" with a bounded duration_ms to capture a shorter clip.`, nil)
	}
	return data, mimeType, nil
}

// FetchMediaHTTP downloads an HTTP/HTTPS media resource with strict byte bounds.
func FetchMediaHTTP(ctx context.Context, mediaURL, pageURL string, timeout time.Duration, maxBytes int) ([]byte, string, error) {
	if maxBytes <= 0 {
		maxBytes = MaxMediaBytes
	}
	if timeout < time.Second {
		timeout = 15 * time.Second
	}
	parsed, err := url.Parse(mediaURL)
	if err != nil || parsed.Host == "" {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Media URL is not valid.", "Provide an http, https, blob, or data URL.", nil)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Unsupported media URL protocol: "+parsed.Scheme+":", "Provide an http, https, blob, or data URL.", nil)
	}

	tctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(tctx, http.MethodGet, mediaURL, nil)
	if err != nil {
		return nil, "", errs.New("MEDIA_URL_INVALID", "Media URL is not valid.", "Provide an http, https, blob, or data URL.", nil)
	}
	if strings.HasPrefix(strings.ToLower(pageURL), "http://") || strings.HasPrefix(strings.ToLower(pageURL), "https://") {
		req.Header.Set("Referer", pageURL)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, "", errs.New("MEDIA_DOWNLOAD_FAILED", "Failed to fetch media URL: "+err.Error(), `Verify the media URL is reachable or try mode: "page" or operation: "record".`, nil)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", errs.New("MEDIA_DOWNLOAD_FAILED", fmt.Sprintf("Media request failed with HTTP %d.", resp.StatusCode), `Try mode: "page" if the media requires browser cookies, or operation: "record".`, map[string]any{"status": resp.StatusCode, "url": mediaURL})
	}
	if resp.ContentLength > int64(maxBytes) {
		return nil, "", errs.New("MEDIA_SIZE_LIMIT", "Media file exceeds the 50 MiB download limit.", `Use operation: "record" with a bounded duration_ms to capture a shorter clip.`, nil)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, int64(maxBytes)+1))
	if err != nil {
		return nil, "", errs.New("MEDIA_DOWNLOAD_FAILED", "Failed to read media response: "+err.Error(), `Try mode: "page" or operation: "record".`, nil)
	}
	if len(data) > maxBytes {
		return nil, "", errs.New("MEDIA_SIZE_LIMIT", "Media file exceeds the 50 MiB download limit.", `Use operation: "record" with a bounded duration_ms to capture a shorter clip.`, nil)
	}
	mimeType := strings.ToLower(strings.TrimSpace(strings.SplitN(resp.Header.Get("Content-Type"), ";", 2)[0]))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return data, mimeType, nil
}

// CollectFrameMediaJS collects all <video>/<audio> descriptors and cues in a frame.
const CollectFrameMediaJS = `function(opts) {
  const mediaType = (opts && opts.mediaType) || 'any';
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
}`

// FindFrameMediaElementsJS returns matching <video>/<audio> elements in DOM/shadow order.
const FindFrameMediaElementsJS = `function(opts) {
  const mediaType = (opts && opts.mediaType) || 'any';
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
}`

// InspectElementMediaJS reads metadata for a single <video>/<audio> element.
const InspectElementMediaJS = `function() {
  const element = this;
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
}`

// FetchMediaInPageJS fetches a media or blob URL inside the page context.
const FetchMediaInPageJS = `async function(opts) {
  const { mediaUrl, maxBytes } = opts;
  try {
    const response = await fetch(mediaUrl, { credentials: 'include' });
    if (!response.ok) {
      return { ok: false, status: response.status, error: 'HTTP ' + response.status };
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
}`

// RecordElementMediaJS records a live stream from a <video>/<audio> element via MediaRecorder.
const RecordElementMediaJS = `async function(opts) {
  const element = this;
  const { durationMs = 5000, maxBytes = 52428800, playIfPaused = true, audioOnly = false } = opts || {};
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
}`

// ControlElementMediaJS controls playback, seek, mute, or speed of a <video>/<audio> element.
const ControlElementMediaJS = `async function(opts) {
  const element = this;
  const { controlAction, currentTime, muted, playbackRate } = opts || {};
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
}`

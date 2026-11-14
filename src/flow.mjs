import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { ControlError } from './errors.mjs';

const FLOW_VERSION = 1;
const MAX_CAPTURED_REQUESTS = 64;
const MAX_CAPTURE_BODY_BYTES = 524288;
const MAX_REPLAY_BODY_BYTES = 2 * 1024 * 1024;
const FLOW_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const PARAM_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const TELEMETRY_PATH_MARKERS = [
  '/collect', '/track', '/beacon', '/analytics', '/pixel',
  '/telemetry', '/metrics', '/log', '/rum', '/sentry',
];
const DROPPED_HEADERS = new Set([
  'cookie', 'host', 'content-length', 'connection', 'accept-encoding',
  'x-client-ip', 'x-forwarded-for', 'x-real-ip', 'forwarded',
  'traceparent', 'tracestate', 'x-request-id', 'request-id',
  'x-amzn-trace-id', 'sentry-trace', 'baggage', 'cf-connecting-ip', 'true-client-ip',
]);
const BROWSER_SET_HEADERS = new Set([
  'user-agent', 'referer', 'origin', 'accept-language', 'priority', 'dnt',
]);
const PRIORITY_ARRAY_KEYS = [
  'items', 'results', 'data', 'crates', 'records', 'entries', 'nodes', 'list', 'hits',
];

export function isTelemetryUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return TELEMETRY_PATH_MARKERS.some(
      marker => path === marker || path.startsWith(`${marker}/`) || path.endsWith(marker),
    );
  } catch {
    return false;
  }
}

export function classifyHeader(name) {
  const lower = String(name).toLowerCase();
  if (lower === 'authorization' || lower === 'proxy-authorization' || lower.includes('token') || lower.includes('csrf')) {
    return 'credential';
  }
  if (DROPPED_HEADERS.has(lower)) return 'dropped';
  if (BROWSER_SET_HEADERS.has(lower) || lower.startsWith('sec-')) return 'browser';
  return 'kept';
}

function scalarType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function signature(value, depth = 3) {
  if (Array.isArray(value) && depth > 0) {
    return { array: value.length > 0 ? signature(value[0], depth - 1) : null };
  }
  if (value !== null && typeof value === 'object' && depth > 0) {
    const obj = {};
    for (const key of Object.keys(value).sort()) {
      obj[key] = signature(value[key], depth - 1);
    }
    return { object: obj };
  }
  return { scalar: scalarType(value) };
}

export function signatureMatches(recorded, current, path = '$') {
  if (!recorded || typeof recorded !== 'object') return { matched: true };
  if (Object.hasOwn(recorded, 'object')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { matched: false, drift: `${path}: expected object, got ${scalarType(current)}` };
    }
    for (const [key, expectedChild] of Object.entries(recorded.object)) {
      if (!Object.hasOwn(current, key)) {
        return { matched: false, drift: `${path}.${key}: missing key` };
      }
      const check = signatureMatches(expectedChild, current[key], `${path}.${key}`);
      if (!check.matched) return check;
    }
    return { matched: true };
  }
  if (Object.hasOwn(recorded, 'array')) {
    if (!Array.isArray(current)) {
      return { matched: false, drift: `${path}: expected array, got ${scalarType(current)}` };
    }
    if (recorded.array === null || current.length === 0) return { matched: true };
    return signatureMatches(recorded.array, current[0], `${path}[0]`);
  }
  if (Object.hasOwn(recorded, 'scalar')) {
    const actual = scalarType(current);
    if (recorded.scalar !== actual) {
      return { matched: false, drift: `${path}: expected ${recorded.scalar}, got ${actual}` };
    }
  }
  return { matched: true };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstObjectKeys(items) {
  const first = items.find(isPlainObject);
  return first ? Object.keys(first) : [];
}

export function detectOutputShape(body) {
  if (Array.isArray(body)) {
    return { array_path: '', item_fields: firstObjectKeys(body) };
  }
  if (isPlainObject(body)) {
    const keys = Object.keys(body);
    const orderedKeys = [
      ...PRIORITY_ARRAY_KEYS.filter(key => keys.includes(key)),
      ...keys.filter(key => !PRIORITY_ARRAY_KEYS.includes(key)),
    ];
    for (const key of orderedKeys) {
      if (Array.isArray(body[key]) && body[key].some(isPlainObject)) {
        return { array_path: key, item_fields: firstObjectKeys(body[key]) };
      }
    }
    for (const key of orderedKeys) {
      if (Array.isArray(body[key])) {
        return { array_path: key, item_fields: firstObjectKeys(body[key]) };
      }
    }
    return { array_path: null, item_fields: keys };
  }
  return { array_path: null, item_fields: [] };
}

function readField(item, field) {
  if (Object.hasOwn(item, field)) return { found: true, value: item[field] };
  if (!field.includes('.')) return { found: false };
  let current = item;
  for (const part of field.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) {
      return { found: false };
    }
    current = current[part];
  }
  return { found: true, value: current };
}

export function projectFlowOutput(body, { array_path, fields, limit } = {}) {
  let list;
  if (array_path === '' && Array.isArray(body)) list = body;
  else if (array_path && isPlainObject(body) && Array.isArray(body[array_path])) list = body[array_path];
  else list = [body];

  const total = list.length;
  const fieldList = typeof fields === 'string'
    ? fields.split(',').map(part => part.trim()).filter(Boolean)
    : Array.isArray(fields)
      ? fields.map(part => String(part).trim()).filter(Boolean)
      : [];

  const sliced = Number.isInteger(limit) && limit > 0 ? list.slice(0, limit) : list;
  const items = fieldList.length === 0
    ? sliced
    : sliced.map(item => {
      if (!isPlainObject(item)) return item;
      const picked = {};
      for (const field of fieldList) {
        const result = readField(item, field);
        if (result.found) picked[field] = result.value;
      }
      return picked;
    });

  return { items, count: items.length, total };
}

export function normalizeParams(params = {}) {
  const normalized = {};
  if (Array.isArray(params)) {
    for (const item of params) {
      const text = String(item);
      const sep = text.indexOf('=');
      if (sep <= 0) {
        throw new ControlError('FLOW_PARAM_INVALID', `Invalid parameter specification: "${text}".`, 'Use key=value pairs or an object such as { q: "terminal" }.');
      }
      const key = text.slice(0, sep).trim();
      if (!PARAM_NAME_PATTERN.test(key)) {
        throw new ControlError('FLOW_PARAM_INVALID', `Invalid parameter name: "${key}".`, 'Use 1–64 letters, digits, underscores, or hyphens.');
      }
      normalized[key] = text.slice(sep + 1);
    }
    return normalized;
  }
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (!PARAM_NAME_PATTERN.test(key)) {
        throw new ControlError('FLOW_PARAM_INVALID', `Invalid parameter name: "${key}".`, 'Use 1–64 letters, digits, underscores, or hyphens.');
      }
      if (value !== undefined && value !== null) normalized[key] = String(value);
    }
  }
  return normalized;
}

function templatizeString(text, swaps, isUrl) {
  if (typeof text !== 'string' || !text || swaps.length === 0) return text;
  let segments = [{ text, locked: false }];
  for (const [name, example] of swaps) {
    if (!example) continue;
    const candidates = isUrl
      ? [...new Set([encodeURIComponent(example), example.replace(/ /g, '+'), example])].sort((a, b) => b.length - a.length)
      : [example];
    for (const needle of candidates) {
      if (!needle) continue;
      const next = [];
      for (const seg of segments) {
        if (seg.locked || !seg.text.includes(needle)) {
          next.push(seg);
          continue;
        }
        const parts = seg.text.split(needle);
        for (let i = 0; i < parts.length; i++) {
          if (parts[i]) next.push({ text: parts[i], locked: false });
          if (i < parts.length - 1) next.push({ text: `{{${name}}}`, locked: true });
        }
      }
      segments = next;
    }
  }
  return segments.map(seg => seg.text).join('');
}

function bindString(template, values, defaults, isUrl) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{([A-Za-z0-9_-]+)\}\}/g, (_match, name) => {
    const raw = Object.hasOwn(values, name) ? values[name] : Object.hasOwn(defaults, name) ? defaults[name] : undefined;
    if (raw === undefined) {
      throw new ControlError('FLOW_PARAM_REQUIRED', `Missing required flow parameter: ${name}.`, `Pass params: { ${name}: "..." } to browser_flow run.`);
    }
    return isUrl ? encodeURIComponent(String(raw)) : String(raw);
  });
}

function isFirstPartyUrl(requestUrl, pageUrl) {
  let req;
  try { req = new URL(requestUrl); }
  catch { return false; }
  if (!['http:', 'https:'].includes(req.protocol)) return false;
  if (!pageUrl) return true;
  let page;
  try { page = new URL(pageUrl); }
  catch { return true; }
  if (!['http:', 'https:'].includes(page.protocol)) return true;
  if (req.origin === page.origin) return true;
  const baseHost = page.hostname.replace(/^(?:www|app|m)\./, '');
  return req.hostname === baseHost || req.hostname.endsWith(`.${baseHost}`) || baseHost.endsWith(`.${req.hostname}`);
}

export class FlowCapture {
  constructor(session) {
    this.session = session;
    this.requests = new Map();
    this.orderedIds = [];
    this.pendingBodies = new Set();
    this.secrets = new Set();
    this.typed = [];
    this.seq = 0;
    this.closed = false;
    this.listeners = [];

    const on = (event, handler) => {
      const wrapped = payload => { if (!this.closed) handler(payload); };
      session.on(event, wrapped);
      this.listeners.push([event, wrapped]);
    };

    on('Network.requestWillBeSent', event => {
      if (!['XHR', 'Fetch'].includes(event.type)) return;
      const url = event.request?.url;
      if (!url || isTelemetryUrl(url)) return;
      const entry = {
        id: `r${++this.seq}`,
        requestId: event.requestId,
        method: (event.request.method || 'GET').toUpperCase(),
        url,
        resourceType: event.type,
        requestHeaders: { ...(event.request.headers || {}) },
        requestBody: event.request.postData ?? null,
        status: null,
        mimeType: '',
        responseBody: null,
        responseJson: undefined,
        finished: false,
        timestamp: Date.now(),
      };
      this.requests.set(event.requestId, entry);
      this.orderedIds.push(event.requestId);
      while (this.orderedIds.length > MAX_CAPTURED_REQUESTS) {
        this.requests.delete(this.orderedIds.shift());
      }
    });

    on('Network.responseReceived', event => {
      const entry = this.requests.get(event.requestId);
      if (!entry) return;
      entry.status = event.response?.status ?? null;
      entry.mimeType = event.response?.mimeType || '';
    });

    on('Network.loadingFinished', event => {
      const entry = this.requests.get(event.requestId);
      if (!entry) return;
      entry.finished = true;
      const okStatus = entry.status !== null && entry.status >= 200 && entry.status < 300;
      const maybeJson = !entry.mimeType || entry.mimeType.toLowerCase().includes('json');
      if (!okStatus || !maybeJson) return;

      const task = (async () => {
        try {
          if (this.closed) return;
          const result = await this.session.send('Network.getResponseBody', { requestId: event.requestId });
          if (!result || typeof result.body !== 'string') return;
          const raw = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : result.body;
          if (Buffer.byteLength(raw, 'utf8') > MAX_CAPTURE_BODY_BYTES) return;
          const parsed = JSON.parse(raw);
          entry.responseBody = raw;
          entry.responseJson = parsed;
        } catch {
          // Response body unavailable or non-JSON; omit from flow candidates.
        }
      })();
      this.pendingBodies.add(task);
      task.finally(() => this.pendingBodies.delete(task));
    });
  }

  async start() {
    await this.session.send('Network.enable');
  }

  reset() {
    this.requests.clear();
    this.orderedIds = [];
    this.secrets.clear();
    this.typed = [];
  }

  noteInput(text, isPassword) {
    if (typeof text !== 'string' || !text) return;
    if (isPassword) this.secrets.add(text);
    else if (!this.typed.includes(text)) this.typed.push(text);
  }

  async candidates(pageUrl = '') {
    if (this.pendingBodies.size > 0) {
      await Promise.all([...this.pendingBodies]);
    }
    const items = [];
    for (const reqId of this.orderedIds) {
      const entry = this.requests.get(reqId);
      if (!entry || entry.responseJson === undefined) continue;
      if (!isFirstPartyUrl(entry.url, pageUrl)) continue;
      items.push(entry);
    }
    return items;
  }

  close() {
    this.closed = true;
    for (const [event, handler] of this.listeners) this.session.off(event, handler);
    this.listeners = [];
    this.requests.clear();
    this.orderedIds = [];
    this.secrets.clear();
    this.typed = [];
    this.session.detach().catch(() => {});
  }
}

function summarizeFlow(flow) {
  return {
    name: flow.name,
    origin: flow.origin,
    method: flow.method,
    url_template: flow.url_template,
    params: flow.params.map(param => param.name),
    item_fields: flow.item_fields,
    had_credentials: Boolean(flow.had_credentials),
    ...(flow.description ? { description: flow.description } : {}),
    inputSchema: flow.inputSchema,
  };
}

function validateFlowObject(flow) {
  if (!flow || flow.version !== FLOW_VERSION || !FLOW_NAME_PATTERN.test(flow.name || '') || typeof flow.url_template !== 'string') {
    throw new ControlError('FLOW_INVALID', 'Flow definition file is invalid or uses an unsupported version.', 'Capture and save a fresh flow with browser_flow.');
  }
  return flow;
}

export class FlowStore {
  constructor(flowDir) {
    this.flowDir = flowDir || null;
    this.flows = new Map();
    this.loadedDir = false;
  }

  validateName(name) {
    if (typeof name !== 'string' || !FLOW_NAME_PATTERN.test(name)) {
      throw new ControlError('FLOW_NAME_INVALID', 'Flow name must be 1–64 letters, digits, underscores, or hyphens.', 'Pass a flow name such as "crates" or "search-items".');
    }
  }

  validatePath(filePath) {
    if (typeof filePath !== 'string' || !isAbsolute(filePath)) {
      throw new ControlError('FLOW_PATH_INVALID', 'Flow file path must be an absolute local path.', 'Provide an absolute path on the machine running the MCP server.');
    }
  }

  async ensureLoaded() {
    if (!this.flowDir || this.loadedDir) return;
    this.loadedDir = true;
    let names;
    try { names = await readdir(this.flowDir); }
    catch { return; }
    for (const file of names) {
      if (!file.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.flowDir, file), 'utf8'));
        if (parsed?.version === FLOW_VERSION && FLOW_NAME_PATTERN.test(parsed.name || '')) {
          this.flows.set(parsed.name, parsed);
        }
      } catch {
        // Ignore unreadable or malformed files in flowDir.
      }
    }
  }

  async loadFromPath(filePath) {
    this.validatePath(filePath);
    let raw;
    try { raw = await readFile(filePath, 'utf8'); }
    catch {
      throw new ControlError('FLOW_FILE_UNAVAILABLE', `Cannot read flow file: ${filePath}`, 'Check the path and file permissions on the MCP server host.');
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      throw new ControlError('FLOW_INVALID', `Flow file is not valid JSON: ${filePath}`, 'Inspect the file or save a fresh flow.');
    }
    const flow = validateFlowObject(parsed);
    this.flows.set(flow.name, flow);
    return flow;
  }

  async get(name, path) {
    await this.ensureLoaded();
    if (name && this.flows.has(name)) return this.flows.get(name);
    if (path) {
      const flow = await this.loadFromPath(path);
      if (!name || flow.name === name) return flow;
    }
    return null;
  }

  async buildAndSave({ name, description, pageUrl, candidates, secrets = [], requestId, params = {}, path }) {
    this.validateName(name);
    if (path !== undefined) this.validatePath(path);
    await this.ensureLoaded();

    if (!candidates.length) {
      throw new ControlError('FLOW_NO_CANDIDATE', 'No first-party JSON API requests were captured on this tab.', 'Call browser_flow({ operation: "capture" }), trigger the page search or API action, and then save.');
    }

    const paramMap = normalizeParams(params);
    const paramEntries = Object.entries(paramMap).filter(([, value]) => value.length > 0);
    let selected;
    if (requestId) {
      selected = candidates.find(c => c.id === requestId || c.requestId === requestId);
      if (!selected) {
        throw new ControlError('FLOW_NO_CANDIDATE', `Captured request "${requestId}" was not found among JSON candidates.`, 'Call browser_flow({ operation: "status" }) to inspect available candidate IDs.');
      }
    } else if (paramEntries.length > 0) {
      const matchesExample = (candidate, value) => {
        const haystacks = [candidate.url, candidate.requestBody || '', ...Object.values(candidate.requestHeaders || {})];
        const encoded = encodeURIComponent(value);
        const plusEncoded = value.replace(/ /g, '+');
        return haystacks.some(h => h.includes(value) || h.includes(encoded) || h.includes(plusEncoded));
      };
      selected = [...candidates].reverse().find(c => paramEntries.every(([, val]) => matchesExample(c, val)))
        || [...candidates].reverse().find(c => paramEntries.some(([, val]) => matchesExample(c, val)))
        || candidates.at(-1);
    } else {
      selected = candidates.at(-1);
    }

    for (const secret of secrets) {
      if (!secret) continue;
      const encoded = encodeURIComponent(secret);
      const body = selected.requestBody || '';
      if (selected.url.includes(secret) || selected.url.includes(encoded) || body.includes(secret) || body.includes(encoded)) {
        throw new ControlError('FLOW_SECRET_DETECTED', 'Cannot save a flow whose request contains a value typed into a password field.', 'Do not capture password login requests as replayable flows.');
      }
    }

    let hadCredentials = false;
    const keptHeaders = {};
    for (const [headerName, headerValue] of Object.entries(selected.requestHeaders || {})) {
      const kind = classifyHeader(headerName);
      if (kind === 'credential') {
        hadCredentials = true;
      } else if (kind === 'kept') {
        keptHeaders[headerName] = String(headerValue);
      }
    }

    const swaps = Object.entries(paramMap)
      .filter(([, value]) => value.length > 0)
      .sort((a, b) => b[1].length - a[1].length);

    const urlTemplate = templatizeString(selected.url, swaps, true);
    const templatedHeaders = {};
    for (const [k, v] of Object.entries(keptHeaders)) {
      templatedHeaders[k] = templatizeString(v, swaps, false);
    }
    const bodyTemplate = selected.requestBody != null
      ? templatizeString(selected.requestBody, swaps, false)
      : null;

    let origin;
    try { origin = new URL(pageUrl || selected.url).origin; }
    catch { origin = new URL(selected.url).origin; }

    const paramList = Object.entries(paramMap).map(([paramName, example]) => ({ name: paramName, example }));
    const { array_path, item_fields } = detectOutputShape(selected.responseJson);
    const responseSignature = signature(selected.responseJson);
    const inputSchema = {
      type: 'object',
      properties: Object.fromEntries(paramList.map(p => [p.name, { type: 'string', default: p.example }])),
      required: [],
    };

    const flow = {
      version: FLOW_VERSION,
      name,
      origin,
      start_url: pageUrl || selected.url,
      ...(description ? { description } : {}),
      created_at: new Date().toISOString(),
      method: selected.method,
      url_template: urlTemplate,
      headers: templatedHeaders,
      body_template: bodyTemplate,
      had_credentials: hadCredentials,
      params: paramList,
      array_path,
      item_fields,
      signature: responseSignature,
      inputSchema,
    };

    this.flows.set(name, flow);
    const targetPath = path || (this.flowDir ? join(this.flowDir, `${name}.json`) : null);
    if (targetPath) {
      if (!path && this.flowDir) await mkdir(this.flowDir, { recursive: true });
      await writeFile(targetPath, JSON.stringify(flow, null, 2) + '\n', 'utf8');
    }

    return {
      saved: true,
      ...summarizeFlow(flow),
      captured_request_id: selected.id,
      ...(targetPath ? { path: targetPath } : {}),
    };
  }

  async list({ origin, path } = {}) {
    await this.ensureLoaded();
    if (path !== undefined) {
      this.validatePath(path);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) {
        for (const file of await readdir(path)) {
          if (file.endsWith('.json')) await this.loadFromPath(join(path, file)).catch(() => {});
        }
      } else if (info?.isFile()) {
        await this.loadFromPath(path);
      } else {
        throw new ControlError('FLOW_FILE_UNAVAILABLE', `Cannot read flow path: ${path}`, 'Check the path on the MCP server host.');
      }
    }
    let filterOrigin;
    if (origin) {
      try { filterOrigin = new URL(origin).origin; }
      catch { filterOrigin = origin; }
    }
    const flows = [...this.flows.values()]
      .filter(flow => !filterOrigin || flow.origin === filterOrigin)
      .map(summarizeFlow);
    return { flows };
  }

  async hintsForUrl(url) {
    let origin;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) return [];
      origin = parsed.origin;
    } catch {
      return [];
    }
    await this.ensureLoaded();
    const matches = [];
    for (const flow of this.flows.values()) {
      if (flow.origin !== origin) continue;
      matches.push({
        ...summarizeFlow(flow),
        hint: `Call browser_flow({ operation: "run", name: "${flow.name}", params: { ... } }) instead of driving the DOM.`,
      });
    }
    return matches;
  }

  async remove(name, path) {
    this.validateName(name);
    if (path !== undefined) this.validatePath(path);
    await this.ensureLoaded();
    const existed = this.flows.delete(name);
    const targetPath = path || (this.flowDir ? join(this.flowDir, `${name}.json`) : null);
    let removedFile = false;
    if (targetPath) {
      try {
        await unlink(targetPath);
        removedFile = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (!existed && !removedFile) {
      throw new ControlError('FLOW_NOT_FOUND', `No saved flow named "${name}".`, 'Call browser_flow({ operation: "list" }) to inspect available flows.');
    }
    return { deleted: true, name };
  }

  async run({ name, params = {}, fields, limit, mode = 'auto', page, getPage, timeout = 8000, path } = {}) {
    if (!name && !path) {
      throw new ControlError('FLOW_NAME_INVALID', 'Provide a flow name or path to run.', 'Call browser_flow({ operation: "list" }) to inspect available flows.');
    }
    if (name) this.validateName(name);
    const flow = await this.get(name, path);
    if (!flow) {
      throw new ControlError('FLOW_NOT_FOUND', `No saved flow named "${name || path}".`, 'Call browser_flow({ operation: "list" }) to inspect available flows, or capture and save a new flow.');
    }

    const started = Date.now();
    const provided = normalizeParams(params);
    const defaults = Object.fromEntries((flow.params || []).map(p => [p.name, p.example]).filter(([, v]) => v !== undefined));

    const boundUrl = bindString(flow.url_template, provided, defaults, true);
    let parsedUrl;
    try { parsedUrl = new URL(boundUrl); }
    catch {
      throw new ControlError('FLOW_URL_INVALID', `Bound flow URL is invalid: ${boundUrl}`, 'Check the supplied parameter values and flow template.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new ControlError('FLOW_URL_INVALID', 'Flow replay only supports http and https URLs.', 'Save flows targeting http or https endpoints.');
    }

    const boundHeaders = {};
    for (const [k, v] of Object.entries(flow.headers || {})) {
      if (classifyHeader(k) === 'kept') boundHeaders[k] = bindString(v, provided, defaults, false);
    }
    const hasBody = flow.body_template != null && !['GET', 'HEAD'].includes(flow.method.toUpperCase());
    const boundBody = hasBody ? bindString(flow.body_template, provided, defaults, false) : undefined;
    const isWriteMethod = !['GET', 'HEAD', 'OPTIONS'].includes(flow.method.toUpperCase());

    const tiers = mode === 'http'
      ? ['http']
      : mode === 'page'
        ? ['page']
        : flow.had_credentials
          ? ['page']
          : ['http', 'page'];

    let lastFailure = null;
    for (let i = 0; i < tiers.length; i++) {
      const tier = tiers[i];
      const canFallback = i + 1 < tiers.length;
      let status;
      let text;

      if (tier === 'http') {
        try {
          const response = await fetch(boundUrl, {
            method: flow.method,
            headers: boundHeaders,
            ...(boundBody !== undefined ? { body: boundBody } : {}),
            signal: AbortSignal.timeout(timeout),
          });
          status = response.status;
          text = await response.text();
        } catch (error) {
          lastFailure = new ControlError('FLOW_HTTP_ERROR', `Flow HTTP request failed: ${error.message}`, 'Retry with mode: "page" on an open tab for this origin if the endpoint requires browser context.');
          if (canFallback) continue;
          throw lastFailure;
        }
      } else {
        const activePage = page || (getPage ? await getPage() : null);
        if (!activePage) {
          throw lastFailure || new ControlError('FLOW_PAGE_REQUIRED', 'Replaying this flow requires an open browser tab.', `Select or open a tab on ${flow.origin} and call browser_flow({ operation: "run", name: "${flow.name}" }).`);
        }
        let pageOrigin;
        try { pageOrigin = new URL(activePage.url()).origin; }
        catch { pageOrigin = ''; }
        if (pageOrigin && pageOrigin !== flow.origin && !isFirstPartyUrl(boundUrl, activePage.url())) {
          throw new ControlError('FLOW_ORIGIN_MISMATCH', `Selected tab origin (${pageOrigin}) does not match flow origin (${flow.origin}).`, `Navigate or select a tab on ${flow.origin} before running with mode: "page".`);
        }
        const response = await activePage.evaluate(async req => {
          const res = await fetch(req.url, {
            method: req.method,
            headers: req.headers,
            credentials: 'include',
            ...(req.body !== undefined ? { body: req.body } : {}),
          });
          return { status: res.status, text: await res.text() };
        }, { url: boundUrl, method: flow.method, headers: boundHeaders, body: boundBody });
        status = response.status;
        text = response.text;
      }

      if (Buffer.byteLength(text, 'utf8') > MAX_REPLAY_BODY_BYTES) {
        throw new ControlError('FLOW_RESPONSE_LIMIT', 'Flow response exceeded the 2 MiB limit.', 'Use more specific parameters or limit the query result.');
      }

      const authRejected = status === 401 || status === 403;
      if (authRejected && canFallback) {
        lastFailure = new ControlError('FLOW_HTTP_ERROR', `Flow HTTP request returned status ${status}.`, 'Run on a logged-in tab with mode: "page".');
        continue;
      }
      if (status < 200 || status >= 300) {
        throw new ControlError('FLOW_HTTP_ERROR', `Flow request failed with HTTP ${status}.`, 'Verify flow parameters or capture a fresh flow.');
      }

      let parsedJson;
      try {
        parsedJson = JSON.parse(text);
      } catch {
        if (canFallback && !isWriteMethod) {
          lastFailure = new ControlError('FLOW_RESPONSE_INVALID', 'Flow HTTP response was not valid JSON.', 'The endpoint may require browser session context; try mode: "page".');
          continue;
        }
        throw new ControlError('FLOW_RESPONSE_INVALID', 'Flow response was not valid JSON.', 'Inspect the site or capture a fresh flow.');
      }

      const sigCheck = signatureMatches(flow.signature, parsedJson);
      if (!sigCheck.matched && canFallback && !isWriteMethod) {
        lastFailure = new ControlError('FLOW_SIGNATURE_DRIFT', `Flow response structure changed: ${sigCheck.drift}`, 'Capture and save a fresh flow for this endpoint.');
        continue;
      }

      const projected = projectFlowOutput(parsedJson, { array_path: flow.array_path, fields, limit });
      return {
        flow: flow.name,
        origin: flow.origin,
        request: { method: flow.method, url: boundUrl },
        tier,
        status,
        verified: sigCheck.matched,
        ...(!sigCheck.matched ? { drift: sigCheck.drift } : {}),
        elapsed_ms: Date.now() - started,
        ...projected,
      };
    }

    throw lastFailure || new ControlError('FLOW_RUN_FAILED', 'Flow replay could not complete.', 'Capture and save a fresh flow.');
  }
}

import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { canForward, forwardChrome } from './adb.mjs';
import { connectTransport } from './cdp-transport.mjs';
import {
  collectDOM,
  diffSnapshots,
  formatCompactElements,
  mountAnnotations,
  observationStamp,
  scrollDOM,
  unmountAnnotations,
} from './dom.mjs';
import { ControlError, describeError, withDeadline } from './errors.mjs';
import { PageEvents } from './events.mjs';
import { FlowCapture, FlowStore } from './flow.mjs';
import {
  MAX_MEDIA_BYTES,
  collectFrameMedia,
  controlElementMedia,
  fetchMediaFromNode,
  fetchMediaInPage,
  findFrameMediaElements,
  inspectElementMedia,
  parseDataUrl,
  recordElementMedia,
  resolveMediaOutputPath,
} from './media.mjs';

// Handle release is housekeeping, never a prerequisite for the next request.
const release = handle => { handle?.dispose().catch(() => {}); };
const DEFAULT_SNAPSHOT_KEY = JSON.stringify({ viewport_only: false, scope: null, filter: null, roles: null, include_bbox: false, format: 'json' });
const UPLOAD_MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.rtf': 'application/rtf', '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};
const identity = node => JSON.stringify({
  tag: node.tagName, type: node.getAttribute('type'), label: node.getAttribute('aria-label'),
  text: ['BUTTON', 'A', 'SUMMARY'].includes(node.tagName) || node.getAttribute('role') === 'button' ? node.textContent : null,
  value: ['radio', 'checkbox'].includes(node.type) ? node.value : null,
});

export class BrowserController {
  constructor(chromium, config, { repairForward = false, flowStore } = {}) {
    this.chromium = chromium;
    this.config = config;
    this.browser = null;
    this.selected = null;
    this.pages = new Map();
    this.dialogs = new Map();
    this.fileChoosers = new Map();
    this.downloads = new Map();
    this.refs = new Map();
    this.handles = [];
    this.sequence = 0;
    this.prefix = randomUUID().slice(0, 8);
    this.stopped = false;
    this.abort = new AbortController();
    this.repairForward = repairForward;
    this.cdp = null;
    this.execSessions = new Map();
    this.targets = new Map();
    this.titles = new Map();
    this.tabInfo = new Map();
    this.targetTabs = new Map();
    this.transport = null;
    this.outcome = {};
    this.lastSnapshot = null;
    this.lastSnapshotByTab = new Map();
    this.snapshotFilterKey = DEFAULT_SNAPSHOT_KEY;
    this.snapshotFrames = [];
    this.snapshotCount = 0;
    this.eventStreams = new Map();
    this.flowCaptures = new Map();
    this.flowStore = flowStore || new FlowStore(config.flowDir);
    this.routes = new Map();
  }

  assertActive() {
    if (this.stopped) throw new ControlError('CONNECTION_RESET', 'This browser connection was reset.',
      'Call browser_status and select the intended tab again. Old element refs are invalid.');
  }

  noteInput(action, tabId) {
    this.assertActive();
    this.outcome = this.outcome.action === 'batch'
      ? { ...this.outcome, current_action: action, may_have_executed: true }
      : { action, ...(tabId ? { tab_id: tabId } : {}), may_have_executed: true };
  }

  async connect() {
    this.assertActive();
    if (this.browser?.isConnected()) return this.browser;
    await this.clearRefs();
    this.pages.clear();
    this.dialogs.clear();
    this.fileChoosers.clear();
    this.downloads.clear();
    this.lastSnapshotByTab.clear();
    this.targets.clear();
    this.titles.clear();
    this.tabInfo = new Map();
    this.targetTabs = new Map();
    this.transport = null;
    this.cdp = null;
    this.selected = null;
    for (const stream of this.eventStreams.values()) stream.close();
    this.eventStreams.clear();
    for (const capture of this.flowCaptures.values()) capture.close();
    this.flowCaptures.clear();
    this.routes.clear();
    for (const session of this.execSessions.values()) session.detach().catch(() => {});
    this.execSessions.clear();
    const open = async timeout => {
      this.assertActive();
      const started = Date.now();
      const transport = await connectTransport(this.config.endpoint, { timeout, signal: this.abort.signal });
      let browser;
      try {
        this.assertActive();
        browser = await this.chromium.connectOverCDP(transport, { timeout: Math.max(1, timeout - (Date.now() - started)), noDefaults: true });
      } catch (error) {
        transport.close();
        error.cdpConnected = true;
        throw error;
      }
      if (this.stopped) {
        browser.close().catch(() => {});
        this.assertActive();
      }
      this.transport = transport;
      return browser;
    };
    let forwarded = false;
    if (this.repairForward && this.config.autoAdb && canForward(this.config.endpoint)) {
      await forwardChrome(this.config, undefined, { signal: this.abort.signal, reconnect: true });
      forwarded = true;
      this.repairForward = false;
    }
    try {
      this.browser = await open(5000);
    } catch (error) {
      this.assertActive();
      if (!this.config.autoAdb) {
        throw new ControlError('CDP_UNAVAILABLE', `Could not connect to Chrome: ${error.message}`,
          'Check CHROME_CDP_URL. For Android, keep Chrome foregrounded with the screen unlocked and forward its debugging socket with adb.');
      }
      if (!forwarded) await forwardChrome(this.config, undefined, { signal: this.abort.signal });
      // Chrome's debugging socket may take a moment to become ready after wake.
      const until = Date.now() + 6000;
      let lastError = error;
      while (!this.browser && Date.now() < until) {
        this.assertActive();
        try { this.browser = await open(Math.min(5000, until - Date.now())); }
        catch (error) {
          lastError = error;
          this.assertActive();
          if (Date.now() < until) await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
      if (!this.browser) {
        const unresponsive = lastError.cdpConnected || /<ws connected>/i.test(lastError.message);
        throw new ControlError(unresponsive ? 'CDP_UNRESPONSIVE' : 'CDP_UNAVAILABLE',
          `ADB forwarding completed, but Chrome ${unresponsive ? 'did not finish CDP initialization' : 'is still unreachable'}: ${lastError.message}`,
          'Keep Chrome foregrounded with the screen unlocked, then call browser_status with reconnect: true. Check the current wireless debugging port and Chrome debugging socket.',
          { phase: unresponsive ? 'initializing_chrome' : 'connecting', endpoint: this.config.endpoint });
      }
    }
    this.assertActive();
    for (const context of this.browser.contexts()) context.setDefaultTimeout(this.config.actionTimeout);
    return this.browser;
  }

  async clearRefs() {
    this.lastSnapshot = null;
    this.snapshotFrames = [];
    this.refs.clear();
    const handles = this.handles.splice(0);
    handles.forEach(release);
  }

  async disconnect() {
    this.stopped = true;
    this.abort.abort();
    const browser = this.browser;
    this.browser = null;
    // For a CDP connection Browser.close disconnects Playwright, preserving Chrome and its tabs.
    await this.clearRefs();
    this.pages.clear();
    this.dialogs.clear();
    for (const chooser of this.fileChoosers.values()) release(chooser.element());
    this.fileChoosers.clear();
    this.downloads.clear();
    this.lastSnapshotByTab.clear();
    this.targets.clear();
    this.titles.clear();
    this.tabInfo?.clear();
    this.targetTabs?.clear();
    this.transport = null;
    this.selected = null;
    for (const stream of this.eventStreams.values()) stream.close();
    this.eventStreams.clear();
    for (const capture of this.flowCaptures.values()) capture.close();
    this.flowCaptures.clear();
    this.routes.clear();
    for (const session of this.execSessions.values()) session.detach().catch(() => {});
    this.execSessions.clear();
    await withDeadline(() => browser?.close(), 1000).catch(() => {});
  }

  register(page, targetId) {
    this.assertActive();
    for (const [id, candidate] of this.pages) if (candidate === page) return id;
    const id = this.targetTabs.get(targetId);
    if (!id) throw new ControlError('TAB_UNAVAILABLE', 'The page no longer has a live Chrome target.', 'Call browser_tabs and select an available tab.');
    this.pages.set(id, page);
    this.targets.set(page, targetId);
    page.on('dialog', dialog => this.dialogs.set(page, dialog));
    page.on('download', download => {
      const list = this.downloads.get(page) || [];
      const record = {
        download_id: `dl_${this.prefix}_${++this.sequence}`,
        tab_id: id,
        url: download.url(),
        suggested_filename: download.suggestedFilename(),
        status: 'pending',
        created_at: Date.now(),
        download,
      };
      list.push(record);
      while (list.length > 20) list.shift();
      this.downloads.set(page, list);
      download.path().then(
        filePath => { record.path = filePath; record.status = 'completed'; },
        error => { record.status = 'failed'; record.error = error?.message || String(error); },
      );
    });
    page.on('close', () => {
      this.dialogs.delete(page); this.fileChoosers.delete(page); this.downloads.delete(page);
      this.lastSnapshotByTab.delete(id);
      this.eventStreams.get(page)?.close(); this.eventStreams.delete(page);
      this.flowCaptures.get(page)?.close(); this.flowCaptures.delete(page);
      this.routes.delete(page);
    });
    page.on('framedetached', frame => {
      this.execSessions.get(frame)?.detach().catch(() => {});
      this.execSessions.delete(frame);
    });
    return id;
  }

  async syncPages() {
    const browser = await this.connect();
    this.assertActive();
    if (!this.cdp) this.cdp = await browser.newBrowserCDPSession();
    const { targetInfos } = await withDeadline(() => this.cdp.send('Target.getTargets'), 2000,
      new ControlError('SESSION_TIMEOUT', 'Chrome did not answer a browser metadata request.',
        'Call browser_status with reconnect: true. Keep Chrome foregrounded and the screen unlocked.'));
    this.assertActive();
    const available = targetInfos.filter(info => info.type === 'page' && info.url && info.url !== ':');
    const targetIds = new Set(available.map(info => info.targetId));
    for (const [targetId, id] of this.targetTabs) if (!targetIds.has(targetId)) {
      this.targetTabs.delete(targetId);
      this.tabInfo.delete(id);
    }
    for (const info of available) {
      let id = this.targetTabs.get(info.targetId);
      if (!id) {
        id = `tab_${this.prefix}_${++this.sequence}`;
        this.targetTabs.set(info.targetId, id);
      }
      this.tabInfo.set(id, info);
    }
    const live = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
    for (const [id, page] of this.pages) if (!live.includes(page)) {
      this.pages.delete(id);
      this.targets.delete(page);
      this.titles.delete(page);
    }
    for (const page of live) if (!this.targets.has(page)) {
      let session;
      try {
        await withDeadline(async () => {
          session = await page.context().newCDPSession(page);
          const { targetInfo } = await session.send('Target.getTargetInfo');
          this.assertActive();
          if (this.targetTabs.has(targetInfo.targetId)) this.register(page, targetInfo.targetId);
        }, 1500);
      } finally { session?.detach().catch(() => {}); }
    }
    if (!this.tabInfo.has(this.selected)) this.selected = null;
    if (this.tabInfo.size === 1 && !this.selected) this.selected = this.tabInfo.keys().next().value;
    return [...this.tabInfo.values()];
  }

  async tabs() {
    await this.syncPages();
    return [...this.tabInfo].map(([id, info]) => ({ tab_id: id, url: info.url,
      title: this.dialogs.has(this.pages.get(id)) ? '(dialog open)' : info.title || '(loading)', selected: this.selected === id }));
  }

  async page(tabId, { activate = false } = {}) {
    const live = await this.syncPages();
    const id = tabId || this.selected;
    if (!id || !this.tabInfo.has(id)) {
      const tabs = live.length ? await this.tabs() : [];
      throw new ControlError(tabs.length ? 'TAB_SELECTION_REQUIRED' : 'NO_TABS',
        tabs.length ? 'Select a tab explicitly before controlling it.' : 'Chrome has no open web page targets.',
        tabs.length ? 'Call browser_tabs, then browser_select_tab with a tab_id. You can also pass tab_id to a tool.' : 'Open a tab in Chrome or call browser_new_tab.',
        { tabs });
    }
    if (activate || !this.pages.has(id)) {
      const targetId = this.tabInfo.get(id).targetId;
      // Browser-level activation wakes Android's selected renderer before
      // Playwright starts waiting for its Page/Runtime initialization replies.
      await this.cdp.send('Target.activateTarget', { targetId });
      this.assertActive();
    }
    if (!this.pages.has(id)) {
      const targetId = this.tabInfo.get(id).targetId;
      this.transport.attachTarget(targetId);
      await withDeadline(async () => {
        while (!this.pages.has(id)) {
          this.assertActive();
          await this.syncPages();
          if (!this.tabInfo.has(id)) throw new ControlError('TAB_UNAVAILABLE', 'The selected tab closed before attachment.', 'Call browser_tabs and select an available tab.');
          if (!this.pages.has(id)) await new Promise(resolve => setTimeout(resolve, 50));
        }
      }, this.config.actionTimeout, new ControlError('SESSION_TIMEOUT', 'The selected tab did not initialize before the deadline.',
        'Keep Chrome foregrounded and the screen unlocked, then reconnect and select the intended tab. Other tabs have not been closed.', { tab_id: id }));
    }
    return { page: this.pages.get(id), id };
  }

  async selectTab(tabId) {
    const { page, id } = await this.page(tabId, { activate: true });
    await page.bringToFront();
    this.assertActive();
    this.selected = id;
    return this.snapshot({ tab_id: id });
  }

  async newTab(url = 'about:blank') {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new ControlError('NO_CONTEXT', 'Chrome has no browser context.', 'Open Chrome and call browser_status.');
    this.noteInput('new_tab');
    if (!this.cdp) this.cdp = await browser.newBrowserCDPSession();
    // Creating about:blank and then navigating can strand an Android native
    // empty target before Playwright has a Page. Request the final URL first.
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    this.outcome.executed = true;
    await this.cdp.send('Target.activateTarget', { targetId });
    this.assertActive();
    this.transport.attachTarget(targetId);
    const page = await withDeadline(async () => {
      while (true) {
        this.assertActive();
        await this.tabs();
        for (const candidate of context.pages()) {
          if (this.targets.get(candidate) === targetId) return candidate;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }, this.config.actionTimeout, new ControlError('SESSION_TIMEOUT',
      'Chrome created a tab, but did not expose its page before the deadline.',
      'Call browser_status and inspect the tab list before trying again. Keep Chrome foregrounded and the screen unlocked.',
      { target_id: targetId }));
    this.assertActive();
    this.selected = this.register(page);
    this.outcome = { ...this.outcome, tab_id: this.selected, executed: true };
    if (url !== 'about:blank') await page.waitForLoadState('domcontentloaded', { timeout: this.config.actionTimeout });
    this.assertActive();
    await page.bringToFront();
    return this.snapshot({});
  }

  async closeTab(tabId) {
    const { page } = await this.page(tabId);
    await this.clearRefs();
    this.noteInput('close_tab', tabId);
    await page.close({ runBeforeUnload: false });
    this.outcome.executed = true;
    return { closed_tab_id: tabId, tabs: await this.tabs() };
  }

  async readFrame(frame, limits, milliseconds) {
    const handles = [];
    let expired = false;
    const timeoutError = new ControlError('FRAME_TIMEOUT', 'This frame did not answer the snapshot request.',
      'Keep Chrome foregrounded with the screen unlocked, then inspect again.');
    const retain = handle => {
      if (expired || this.stopped) { release(handle); throw timeoutError; }
      handles.push(handle);
      return handle;
    };
    try {
      return await withDeadline(async () => {
        const handle = retain(await frame.evaluateHandle(collectDOM, limits));
        const dataHandle = retain(await handle.getProperty('data'));
        const data = await dataHandle.jsonValue();
        if (expired) throw timeoutError;
        this.assertActive();
        const nodes = retain(await handle.getProperty('nodes'));
        release(dataHandle);
        return { handle, nodes, data };
      }, milliseconds, timeoutError);
    } catch (error) {
      expired = true;
      handles.forEach(release);
      throw error;
    }
  }

  async snapshot({
    tab_id,
    max_elements = 160,
    max_text = 12000,
    mode = 'dom',
    format = 'json',
    viewport_only = false,
    scope,
    filter,
    roles,
    include_bbox = false,
  } = {}) {
    const { page, id } = await this.page(tab_id);
    this.snapshotCount++;
    if (this.dialogs.has(page)) {
      await this.clearRefs();
      return this.lastSnapshot = { tab_id: id, url: page.url(), dialog: this.dialogInfo(page), frames: [], elements: [], recovery: 'Call browser_handle_dialog to accept or dismiss this dialog before interacting with the page.' };
    }
    if (mode === 'aria') {
      await this.clearRefs();
      const snapshotId = `snapshot_${this.prefix}_${++this.sequence}`;
      const rawAria = await withDeadline(
        () => page.ariaSnapshot({ timeout: Math.min(this.config.actionTimeout, 5000) }),
        Math.min(this.config.actionTimeout, this.config.requestTimeout - 1000),
        new ControlError('SNAPSHOT_TIMEOUT', 'The selected tab did not answer the accessibility snapshot request.',
          'Call browser_status with reconnect: true, then select the intended tab.', { tab_id: id }),
      );
      this.assertActive();
      const title = await page.title().catch(() => this.titles.get(page) || '(loading)');
      this.titles.set(page, title);
      const savedFlows = await this.flowStore.hintsForUrl(page.url());
      return {
        tab_id: id, snapshot_id: snapshotId, mode: 'aria', url: page.url(), title,
        aria_tree: rawAria.slice(0, max_text),
        ...(rawAria.length > max_text ? { aria_truncated: true } : {}),
        ...(savedFlows.length ? { saved_flows: savedFlows } : {}),
        frames: [], elements: [],
      };
    }
    const filterKey = JSON.stringify({
      viewport_only: Boolean(viewport_only),
      scope: scope || null,
      filter: filter || null,
      roles: roles?.length ? roles : null,
      include_bbox: Boolean(include_bbox),
      format,
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.clearRefs();
      const snapshotId = `snapshot_${this.prefix}_${++this.sequence}`;
      const frames = [];
      const warnings = [];
      let remainingElements = max_elements;
      let remainingText = max_text;
      const pageFrames = page.frames();
      const elements = [];
      let title = this.titles.get(page) || '(loading)';
      let challenge = null;
      let anyScopeMatched = !scope;
      const until = Date.now() + Math.min(this.config.actionTimeout, this.config.requestTimeout - 1000);
      let retry = false;
      for (const [index, frame] of pageFrames.slice(0, 25).entries()) {
        const frameId = `frame_${index}`;
        const remaining = until - Date.now();
        if (remaining <= 0 && frame !== page.mainFrame()) {
          warnings.push({ message: 'Snapshot time budget exhausted; remaining frames were skipped.' });
          break;
        }
        try {
          const { handle, nodes, data } = await this.readFrame(frame,
            {
              maxElements: remainingElements,
              maxText: remainingText,
              viewportOnly: Boolean(viewport_only),
              scope: scope || null,
              filter: filter || null,
              roles: roles?.length ? roles : null,
              includeBbox: Boolean(include_bbox),
            },
            Math.max(1, Math.min(remaining, frame === page.mainFrame() ? this.config.actionTimeout : 1500)));
          this.assertActive();
          this.handles.push(handle, nodes);
          if (data.scope_matched !== false) anyScopeMatched = true;
          if (!challenge && data.challenge) challenge = { ...data.challenge, frame_id: frameId };
          const frameLabels = [];
          if (frame === page.mainFrame()) { title = data.title; this.titles.set(page, title); }
          for (const item of data.elements) {
            const shortId = `e${elements.length + 1}`;
            const ref = `${snapshotId}:${shortId}`;
            this.refs.set(ref, { nodes, index: item.index, page, tabId: id });
            frameLabels.push(shortId);
            const { index: nodeIndex, ...description } = item;
            elements.push({ ref, frame_id: frameId, ...description });
          }
          this.snapshotFrames.push({ frame, nodes, stamp: data.stamp, labels: frameLabels });
          frames.push({ frame_id: frameId, url: frame.url(), name: frame.name(), text: data.text, text_truncated: data.text_truncated, elements_truncated: data.elements_truncated });
          remainingElements -= data.elements.length;
          remainingText -= data.text.length;
        } catch (error) {
          if (frame === page.mainFrame() && attempt === 0 && /context|navigation|detached/i.test(error.message)) {
            retry = true;
            break;
          }
          if (frame === page.mainFrame()) {
            if (error.code === 'FRAME_TIMEOUT') throw new ControlError('SNAPSHOT_TIMEOUT', 'The selected tab did not answer the snapshot request.',
              'Call browser_status with reconnect: true, then select the intended tab. Keep Chrome foregrounded with the screen unlocked.', { tab_id: id });
            throw error;
          }
          warnings.push({ frame_id: frameId, error: error.message, ...('code' in error ? { code: error.code, recovery: error.recovery } : {}) });
        }
      }
      if (retry) {
        await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
        continue;
      }
      if (scope && !anyScopeMatched) {
        warnings.push({ code: 'SCOPE_NOT_FOUND', message: `No element matched scope selector "${scope}".` });
      }
      if (pageFrames.length > 25) warnings.push({ message: 'Only the first 25 frames were inspected.' });
      let ariaFields = {};
      if (mode === 'both') {
        try {
          const rawAria = await withDeadline(
            () => page.ariaSnapshot({ timeout: Math.min(this.config.actionTimeout, 3000) }),
            Math.min(this.config.actionTimeout, 3000),
          );
          ariaFields = {
            aria_tree: rawAria.slice(0, max_text),
            ...(rawAria.length > max_text ? { aria_truncated: true } : {}),
          };
        } catch (error) {
          warnings.push({ message: `Accessibility tree unavailable: ${error.message}` });
        }
      }
      const savedFlows = await this.flowStore.hintsForUrl(page.url());
      const humanInteraction = challenge ? {
        ...challenge,
        recovery: 'Human verification is required. Pause automation, ask the user to complete this challenge directly in Chrome, and then call browser_snapshot to resume.',
      } : null;
      const baseRecord = {
        tab_id: id, snapshot_id: snapshotId, ...(mode === 'both' ? { mode } : {}), url: page.url(), title,
        frames, ...ariaFields,
        ...(savedFlows.length ? { saved_flows: savedFlows } : {}),
        ...(humanInteraction ? { human_interaction_required: humanInteraction } : {}),
        ...(warnings.length ? { warnings } : {}),
      };
      this.snapshotFilterKey = filterKey;
      const fullRecord = {
        ...baseRecord,
        elements,
        reference_help: 'Use ref values from this snapshot. A new snapshot or action invalidates earlier references. Offscreen elements are scrolled into view during interaction.',
      };
      this.lastSnapshotByTab.set(id, fullRecord);
      if (format === 'compact') {
        const compactRecord = {
          ...baseRecord,
          format: 'compact',
          element_count: elements.length,
          elements_text: formatCompactElements(elements),
        };
        this.lastSnapshot = compactRecord;
        return compactRecord;
      }
      return this.lastSnapshot = fullRecord;
    }
  }

  async currentSnapshot(tabId) {
    const cached = this.lastSnapshot;
    if (!cached || this.snapshotFilterKey !== DEFAULT_SNAPSHOT_KEY) return null;
    const { page, id } = await this.page(tabId);
    if (cached.tab_id !== id || cached.url !== page.url()) return null;
    if (cached.dialog) return this.dialogs.has(page) ? cached : null;
    if (this.dialogs.has(page) || this.snapshotFrames.length !== page.frames().length) return null;
    try {
      for (const { frame, nodes, stamp } of this.snapshotFrames) {
        if (frame.isDetached() || stamp !== await withDeadline(() => nodes.evaluate(observationStamp), 500)) return null;
      }
      return cached === this.lastSnapshot ? cached : null;
    } catch { return null; }
  }

  async summary(tabId) {
    const { page, id } = await this.page(tabId);
    if (this.dialogs.has(page)) return { tab_id: id, url: page.url(), dialog: this.dialogInfo(page) };
    return { tab_id: id, url: page.url(), ...await page.evaluate(() => ({ title: document.title,
      viewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY },
      page: { width: document.scrollingElement?.scrollWidth || innerWidth, height: document.scrollingElement?.scrollHeight || innerHeight } })) };
  }

  async events(tabId) {
    const { page, id } = await this.page(tabId);
    const wasWatching = this.eventStreams.has(page);
    if (!wasWatching) {
      const session = await page.context().newCDPSession(page);
      if (this.stopped) { session.detach().catch(() => {}); this.assertActive(); }
      const stream = new PageEvents(session);
      this.eventStreams.set(page, stream);
      try { await stream.start(); this.assertActive(); }
      catch (error) { stream.close(); this.eventStreams.delete(page); throw error; }
    }
    return { id, stream: this.eventStreams.get(page), newly_started: !wasWatching };
  }

  async route({ tab_id, operation = 'add', pattern, route_action = 'fulfill', status = 200, body = '', content_type = 'text/plain', headers = {}, error_code = 'failed' } = {}) {
    const { page, id } = await this.page(tab_id);
    const entries = this.routes.get(page) || [];
    const serialize = list => list.map(({ handler: _handler, ...meta }) => meta);
    if (operation === 'list') return { tab_id: id, routes: serialize(entries) };
    if (operation === 'remove') {
      const removed = [];
      const remaining = [];
      for (const entry of entries) {
        if (!pattern || entry.pattern === pattern) removed.push(entry);
        else remaining.push(entry);
      }
      if (removed.length) this.noteInput('route', id);
      for (const entry of removed) await page.unroute(entry.pattern, entry.handler);
      if (removed.length) this.outcome.executed = true;
      if (remaining.length) this.routes.set(page, remaining);
      else this.routes.delete(page);
      return { tab_id: id, removed: removed.length, routes: serialize(remaining) };
    }
    if (!pattern) {
      throw new ControlError('ROUTE_PATTERN_REQUIRED', 'A URL pattern is required to add a route.',
        'Provide a glob pattern such as "**/api/*" or "*://example.com/*".');
    }
    if (entries.length >= 50) {
      throw new ControlError('ROUTE_LIMIT', 'At most 50 active routes are supported per tab.',
        'Remove unused routes with operation: "remove".');
    }
    const handler = async route => {
      try {
        if (route_action === 'abort') await route.abort(error_code);
        else if (route_action === 'continue') await route.continue({ headers: { ...route.request().headers(), ...headers } });
        else await route.fulfill({ status, contentType: content_type, body, headers });
      } catch {}
    };
    this.noteInput('route', id);
    await page.route(pattern, handler);
    this.outcome.executed = true;
    const entry = {
      pattern, route_action,
      ...(route_action === 'fulfill' ? { status, content_type, body_bytes: Buffer.byteLength(body) } : {}),
      ...(route_action === 'abort' ? { error_code } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      handler,
    };
    const updated = [...entries, entry];
    this.routes.set(page, updated);
    return { tab_id: id, added: pattern, routes: serialize(updated) };
  }

  async pdf({ tab_id, path, landscape = false, print_background = true, scale = 1, prefer_css_page_size = false } = {}) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is open in this tab.', 'Read browser_snapshot, then call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    if (path !== undefined && !isAbsolute(path)) {
      throw new ControlError('PDF_PATH_INVALID', 'PDF output path must be an absolute local path.',
        'Use the full path on the machine running the MCP server.');
    }
    let session;
    try {
      session = await page.context().newCDPSession(page);
      this.assertActive();
      let data;
      try {
        ({ data } = await withDeadline(() => session.send('Page.printToPDF', {
          landscape, printBackground: print_background, scale, preferCSSPageSize: prefer_css_page_size,
        }), this.config.actionTimeout));
      } catch (error) {
        if (/PrintToPDF is not implemented|printing is not available/i.test(error.message)) {
          throw new ControlError('PDF_UNSUPPORTED', 'This Chrome build does not support CDP Page.printToPDF.',
            'Use browser_screenshot with full: true on Android Chrome builds that disable headless PDF printing.');
        }
        throw error;
      }
      this.assertActive();
      const buffer = Buffer.from(data, 'base64');
      if (path) {
        await writeFile(path, buffer);
        return { tab_id: id, url: page.url(), path, bytes: buffer.length };
      }
      if (buffer.length > 10 * 1024 * 1024) {
        throw new ControlError('PDF_SIZE_LIMIT', 'Generated PDF exceeds 10 MiB.',
          'Pass an absolute path to save large PDFs to disk.');
      }
      return { tab_id: id, url: page.url(), bytes: buffer.length, data_base64: data };
    } finally {
      session?.detach().catch(() => {});
    }
  }

  async flow(args = {}) {
    const operation = args.operation || 'list';
    if (operation === 'list') {
      return this.flowStore.list({ origin: args.origin, path: args.path });
    }
    if (operation === 'delete') {
      return this.flowStore.remove(args.name, args.path);
    }
    if (operation === 'run') {
      let page = null;
      if (args.mode === 'page') {
        page = (await this.page(args.tab_id)).page;
      } else if (args.mode !== 'http' && this.browser?.isConnected() && (args.tab_id || this.selected)) {
        try { page = (await this.page(args.tab_id)).page; } catch {}
      }
      return this.flowStore.run({
        name: args.name,
        params: args.params,
        fields: args.fields,
        limit: args.limit,
        mode: args.mode || 'auto',
        page,
        getPage: args.mode === 'http' ? undefined : async () => (await this.page(args.tab_id)).page,
        timeout: this.config.actionTimeout,
        path: args.path,
      });
    }

    const { page, id } = await this.page(args.tab_id);
    if (operation === 'capture') {
      const existing = this.flowCaptures.get(page);
      if (existing) {
        if (args.reset !== false) existing.reset();
        return { tab_id: id, capturing: true, newly_started: false, url: page.url() };
      }
      const session = await page.context().newCDPSession(page);
      if (this.stopped) { session.detach().catch(() => {}); this.assertActive(); }
      const capture = new FlowCapture(session);
      this.flowCaptures.set(page, capture);
      try { await capture.start(); this.assertActive(); }
      catch (error) { capture.close(); this.flowCaptures.delete(page); throw error; }
      return { tab_id: id, capturing: true, newly_started: true, url: page.url() };
    }
    if (operation === 'stop') {
      const existing = this.flowCaptures.get(page);
      const wasCapturing = Boolean(existing);
      if (existing) {
        existing.close();
        this.flowCaptures.delete(page);
      }
      return { tab_id: id, capturing: false, was_capturing: wasCapturing };
    }
    if (operation === 'status') {
      const capture = this.flowCaptures.get(page);
      const candidates = capture ? await capture.candidates(page.url()) : [];
      return {
        tab_id: id,
        capturing: Boolean(capture),
        url: page.url(),
        candidates: candidates.map(c => ({
          id: c.id,
          method: c.method,
          url: c.url,
          status: c.status,
          has_body: c.requestBody != null,
        })),
      };
    }
    if (operation === 'save') {
      const capture = this.flowCaptures.get(page);
      if (!capture) {
        throw new ControlError('FLOW_CAPTURE_INACTIVE', 'Flow capture is not active on this tab.', 'Call browser_flow({ operation: "capture" }) before triggering the request, then save.');
      }
      const candidates = await capture.candidates(page.url());
      const saved = await this.flowStore.buildAndSave({
        name: args.name,
        description: args.description,
        pageUrl: page.url(),
        candidates,
        secrets: [...capture.secrets],
        requestId: args.request_id,
        params: args.params,
        path: args.path,
      });
      return { tab_id: id, ...saved };
    }
    throw new ControlError('FLOW_OPERATION_INVALID', `Unknown flow operation: ${operation}`, 'Use capture, stop, status, save, run, list, or delete.');
  }

  async findMediaElement(page, { mediaType = 'any', index = 0 } = {}) {
    let remaining = index;
    for (const frame of page.frames().slice(0, 25)) {
      let listHandle;
      try {
        listHandle = await frame.evaluateHandle(findFrameMediaElements, { mediaType });
        const lenHandle = await listHandle.getProperty('length');
        const count = await lenHandle.jsonValue();
        release(lenHandle);
        if (remaining < count) {
          const itemHandle = await listHandle.getProperty(String(remaining));
          const element = itemHandle.asElement();
          if (element) return element;
          release(itemHandle);
        }
        remaining -= count;
      } catch {
        // Ignore detached or unreachable child frames during media discovery.
      } finally {
        release(listHandle);
      }
    }
    return null;
  }

  async resolveMediaTarget(page, args) {
    const operation = args.operation || 'download';
    if (args.ref) {
      const rawTarget = await this.target(args.ref, page);
      try {
        const info = await rawTarget.evaluate(node => {
          const media = (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') ? node : node.querySelector('video, audio');
          if (media) return { kind: 'media', isSelf: media === node };
          if (node.tagName === 'A' && node.href) return { kind: 'link', href: node.href };
          return { kind: 'invalid' };
        });
        if (info.kind === 'media') {
          if (info.isSelf) {
            const frame = await rawTarget.ownerFrame().catch(() => page.mainFrame());
            return { element: rawTarget, directUrl: null, frame: frame || page.mainFrame() };
          }
          const resolvedHandle = await rawTarget.evaluateHandle(node => node.querySelector('video, audio'));
          const element = resolvedHandle.asElement();
          if (!element) {
            release(resolvedHandle);
            throw new ControlError('MEDIA_TARGET_INVALID', 'The target media element could not be resolved.', 'Inspect a fresh browser_snapshot and try again.');
          }
          const frame = await element.ownerFrame().catch(() => page.mainFrame());
          release(rawTarget);
          return { element, directUrl: null, frame: frame || page.mainFrame() };
        }
        release(rawTarget);
        if (info.kind === 'link' && operation === 'download') {
          return { element: null, directUrl: info.href, frame: page.mainFrame() };
        }
        throw new ControlError(
          'MEDIA_TARGET_INVALID',
          'The selected element is not a video, audio, player container, or media link.',
          'Select a video or audio ref from browser_snapshot or omit ref to match media on the page.',
        );
      } catch (error) {
        release(rawTarget);
        throw error;
      }
    }
    if (args.url && operation === 'download') {
      let resolved;
      try {
        resolved = new URL(args.url, page.url() || undefined);
      } catch {
        throw new ControlError('MEDIA_URL_INVALID', 'Media URL is not valid.', 'Provide a valid http, https, blob, or data URL.');
      }
      if (!['http:', 'https:', 'blob:', 'data:'].includes(resolved.protocol)) {
        throw new ControlError('MEDIA_URL_INVALID', `Unsupported media URL protocol: ${resolved.protocol}`, 'Provide an http, https, blob, or data URL.');
      }
      return { element: null, directUrl: resolved.href, frame: page.mainFrame() };
    }
    const element = await this.findMediaElement(page, { mediaType: args.media_type || 'any', index: args.index ?? 0 });
    if (!element) {
      throw new ControlError(
        'MEDIA_NOT_FOUND',
        'No matching video or audio element was found on the page.',
        'Inspect the page with browser_snapshot or pass a direct media url.',
      );
    }
    const frame = await element.ownerFrame().catch(() => page.mainFrame());
    return { element, directUrl: null, frame: frame || page.mainFrame() };
  }

  async media(args = {}) {
    const operation = args.operation || 'download';
    const { page, id } = await this.page(args.tab_id);
    if (this.dialogs.has(page)) {
      throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is open in this tab.', 'Read browser_snapshot, then call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    }
    if (['download', 'record'].includes(operation) && args.path !== undefined && !isAbsolute(args.path)) {
      throw new ControlError(
        'MEDIA_PATH_INVALID',
        'Media output path must be an absolute local path.',
        'Use the full path on the machine running the MCP server.',
      );
    }
    if (operation === 'inspect') {
      const media = [];
      const warnings = [];
      for (const [frameIndex, frame] of page.frames().slice(0, 25).entries()) {
        const frameId = `frame_${frameIndex}`;
        try {
          const items = await withDeadline(
            () => frame.evaluate(collectFrameMedia, { mediaType: args.media_type || 'any' }),
            frame === page.mainFrame() ? this.config.actionTimeout : 1500,
          );
          for (const item of items) {
            media.push({ ...item, index: media.length, frame_id: frameId });
          }
        } catch (error) {
          if (frame === page.mainFrame()) throw error;
          warnings.push({ frame_id: frameId, error: error.message });
        }
      }
      return { tab_id: id, url: page.url(), media, ...(warnings.length ? { warnings } : {}) };
    }

    const { element, directUrl, frame } = await this.resolveMediaTarget(page, args);
    try {
      const recordClip = async () => {
        if (!element) {
          throw new ControlError(
            'MEDIA_ELEMENT_REQUIRED',
            'Recording requires a video or audio element on the page.',
            'Omit url or pass a video or audio ref from browser_snapshot.',
          );
        }
        const durationMs = args.duration_ms ?? 5000;
        this.noteInput('media', id);
        const recorded = await withDeadline(
          () => element.evaluate(recordElementMedia, {
            durationMs,
            maxBytes: MAX_MEDIA_BYTES,
            playIfPaused: args.play_if_paused !== false,
            audioOnly: Boolean(args.audio_only),
          }),
          Math.max(durationMs + 5000, this.config.actionTimeout),
        );
        this.assertActive();
        if (!recorded?.ok) {
          throw new ControlError(
            recorded?.code || 'MEDIA_RECORD_FAILED',
            recorded?.message || 'Failed to record media stream.',
            'Ensure the media element can play without cross-origin restrictions, or pass a direct media URL for download.',
          );
        }
        this.outcome.executed = true;
        const buffer = Buffer.from(recorded.data_base64, 'base64');
        const outputPath = resolveMediaOutputPath(args.path, recorded.mime_type, '');
        await writeFile(outputPath, buffer);
        return {
          tab_id: id,
          url: page.url(),
          method: 'record',
          path: outputPath,
          mime_type: recorded.mime_type,
          bytes: buffer.length,
          duration_ms: durationMs,
          current_time: recorded.current_time,
          duration: recorded.duration,
        };
      };

      if (operation === 'control') {
        if (args.control_action === 'seek' && args.current_time === undefined) {
          throw new ControlError('MEDIA_ARGUMENTS_INVALID', 'Provide current_time when control_action is "seek".', 'Pass current_time in seconds.');
        }
        if (args.control_action === 'rate' && args.playback_rate === undefined) {
          throw new ControlError('MEDIA_ARGUMENTS_INVALID', 'Provide playback_rate when control_action is "rate".', 'Pass playback_rate (for example 1.5).');
        }
        this.noteInput('media', id);
        const state = await element.evaluate(controlElementMedia, {
          controlAction: args.control_action,
          currentTime: args.current_time,
          muted: args.muted,
          playbackRate: args.playback_rate,
        });
        this.assertActive();
        this.outcome.executed = true;
        return { tab_id: id, url: page.url(), executed: true, media: state };
      }

      if (operation === 'record') {
        return await recordClip();
      }

      if (operation === 'download') {
        const mode = args.mode || 'auto';
        if (mode === 'record') {
          return await recordClip();
        }
        const meta = element ? await element.evaluate(inspectElementMedia) : null;
        const mediaUrl = directUrl || meta?.src || '';
        if (!mediaUrl) {
          if (element && mode === 'auto') {
            return await recordClip();
          }
          throw new ControlError(
            'MEDIA_URL_MISSING',
            'The media element has no downloadable source URL.',
            'Use operation: "record" to capture live playback from the element.',
          );
        }
        if (mediaUrl.startsWith('data:')) {
          const { buffer, mimeType } = parseDataUrl(mediaUrl);
          const outputPath = resolveMediaOutputPath(args.path, mimeType, '');
          await writeFile(outputPath, buffer);
          return {
            tab_id: id,
            url: page.url(),
            media_url: mediaUrl.slice(0, 200),
            method: 'data',
            path: outputPath,
            mime_type: mimeType,
            bytes: buffer.length,
            ...(meta?.tracks?.length ? { tracks: meta.tracks } : {}),
          };
        }
        if (mediaUrl.startsWith('blob:')) {
          if (mode === 'fetch') {
            throw new ControlError(
              'MEDIA_MODE_INVALID',
              'Blob URLs can only be fetched inside the browser page or recorded.',
              'Use mode: "auto", mode: "page", or operation: "record".',
            );
          }
          const pageRes = await (frame || page.mainFrame()).evaluate(fetchMediaInPage, { mediaUrl, maxBytes: MAX_MEDIA_BYTES });
          this.assertActive();
          if (pageRes?.ok) {
            const buffer = Buffer.from(pageRes.data_base64, 'base64');
            const outputPath = resolveMediaOutputPath(args.path, pageRes.mime_type, mediaUrl);
            await writeFile(outputPath, buffer);
            return {
              tab_id: id,
              url: page.url(),
              media_url: mediaUrl,
              method: 'page',
              path: outputPath,
              mime_type: pageRes.mime_type,
              bytes: buffer.length,
              ...(meta?.tracks?.length ? { tracks: meta.tracks } : {}),
            };
          }
          if (element && mode === 'auto') {
            return await recordClip();
          }
          if (pageRes?.size_exceeded) {
            throw new ControlError(
              'MEDIA_SIZE_LIMIT',
              'Media file exceeds the 50 MiB download limit.',
              'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
            );
          }
          throw new ControlError(
            'MEDIA_DOWNLOAD_FAILED',
            pageRes?.error || 'Could not download blob media URL.',
            'Use operation: "record" to capture MediaSource or live playback.',
          );
        }

        let downloadResult;
        if (mode === 'page' || mode === 'auto') {
          const pageRes = await (frame || page.mainFrame()).evaluate(fetchMediaInPage, { mediaUrl, maxBytes: MAX_MEDIA_BYTES });
          this.assertActive();
          if (pageRes?.ok) {
            downloadResult = {
              buffer: Buffer.from(pageRes.data_base64, 'base64'),
              mimeType: pageRes.mime_type,
              method: 'page',
            };
          } else if (pageRes?.size_exceeded) {
            throw new ControlError(
              'MEDIA_SIZE_LIMIT',
              'Media file exceeds the 50 MiB download limit.',
              'Use operation: "record" with a bounded duration_ms to capture a shorter clip.',
            );
          } else if (mode === 'page') {
            throw new ControlError(
              'MEDIA_DOWNLOAD_FAILED',
              `In-page media fetch failed: ${pageRes?.error || 'unknown error'}`,
              'Try mode: "auto" or mode: "fetch" for cross-origin media, or operation: "record".',
            );
          }
        }
        if (!downloadResult) {
          const nodeRes = await fetchMediaFromNode(mediaUrl, {
            pageUrl: page.url(),
            timeoutMs: Math.min(20000, Math.max(2000, this.config.requestTimeout - 2000)),
          });
          this.assertActive();
          downloadResult = { ...nodeRes, method: 'fetch' };
        }
        const outputPath = resolveMediaOutputPath(args.path, downloadResult.mimeType, mediaUrl);
        await writeFile(outputPath, downloadResult.buffer);
        return {
          tab_id: id,
          url: page.url(),
          media_url: mediaUrl,
          method: downloadResult.method,
          path: outputPath,
          mime_type: downloadResult.mimeType,
          bytes: downloadResult.buffer.length,
          ...(meta?.tracks?.length ? { tracks: meta.tracks } : {}),
        };
      }

      throw new ControlError('MEDIA_OPERATION_INVALID', `Unknown media operation: ${operation}`, 'Use download, record, inspect, or control.');
    } finally {
      release(element);
    }
  }

  async target(ref, page) {
    const entry = this.refs.get(ref);
    if (!entry || entry.page !== page) {
      throw new ControlError('STALE_REF', 'The element reference is outdated or belongs to another tab.', 'Call browser_snapshot on the intended tab and use a ref from that result.');
    }
    let handle;
    try {
      handle = await entry.nodes.getProperty(String(entry.index));
      const element = handle.asElement();
      if (element && await element.evaluate(node => node.isConnected)) return element;
    } catch {
      // A manual navigation destroys the snapshot's JavaScript context.
    }
    release(handle);
    throw new ControlError('STALE_REF', 'The element was removed or the page navigated.', 'Call browser_snapshot and choose a fresh reference.');
  }

  dialogInfo(page) {
    const dialog = this.dialogs.get(page);
    return dialog ? { type: dialog.type(), message: dialog.message(), default_value: dialog.defaultValue() } : undefined;
  }

  async handleDialog({ tab_id, accept, prompt_text }) {
    const { page, id } = await this.page(tab_id);
    const dialog = this.dialogs.get(page);
    if (!dialog) throw new ControlError('NO_DIALOG', 'There is no pending JavaScript dialog in this tab.', 'Call browser_snapshot to inspect the page.');
    this.dialogs.delete(page);
    this.noteInput('handle_dialog', id);
    try {
      if (accept) await dialog.accept(prompt_text);
      else await dialog.dismiss();
      this.outcome.executed = true;
    } catch (error) {
      if (!this.dialogs.has(page)) this.dialogs.set(page, dialog);
      throw error;
    }
    await page.waitForTimeout(250);
    this.assertActive();
    return { accepted: accept, snapshot: await this.snapshot({ tab_id: id }) };
  }

  async untilDialog(page, operation) {
    let listener;
    const opened = new Promise(resolve => {
      listener = () => resolve();
      page.once('dialog', listener);
    });
    try {
      // CDP input calls can remain pending until a dialog closes. Return the
      // dialog immediately so the next tool call can handle it explicitly.
      await Promise.race([Promise.resolve().then(operation), opened]);
    } finally {
      page.off('dialog', listener);
    }
  }

  async isRenderingRunning(target) {
    return target.evaluate(() => new Promise(resolve => {
      const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
      const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 150);
    }));
  }

  async resolvePausedPoint(page, target) {
    // Sample geometry using timers instead of animation frames. Only return
    // coordinates when the same retained node is visible, enabled and uncovered.
    const measured = await target.evaluate(async node => {
      node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const describeHit = hit => hit ? {
        tag: hit.tagName.toLowerCase(),
        ...(hit.id ? { id: hit.id } : {}),
        ...(hit.getAttribute?.('role') ? { role: hit.getAttribute('role') } : {}),
        ...((hit.innerText || hit.getAttribute?.('aria-label') || '').trim()
          ? { text: (hit.innerText || hit.getAttribute?.('aria-label') || '').trim().slice(0, 120) }
          : {}),
      } : undefined;
      const measure = () => {
        if (!node.isConnected) return { ok: false, reason: 'detached' };
        if (node.matches(':disabled') || node.closest('[aria-disabled="true"], [inert]')) return { ok: false, reason: 'disabled' };
        if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { ok: false, reason: 'hidden' };
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return { ok: false, reason: 'zero_size' };
        const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
        const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
        if (right <= left || bottom <= top) return { ok: false, reason: 'outside_viewport' };
        const x = (left + right) / 2, y = (top + bottom) / 2;
        let hit = document.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
          const child = hit.shadowRoot.elementFromPoint(x, y);
          if (!child || child === hit) break;
          hit = child;
        }
        if (!hit || !(hit === node || node.contains(hit))) return { ok: false, reason: 'covered', covered_by: describeHit(hit) };
        return { ok: true, x, y, left: box.left, top: box.top, width: box.width, height: box.height };
      };
      const first = measure();
      if (!first.ok) return first;
      await new Promise(resolve => setTimeout(resolve, 75));
      const second = measure();
      if (!second.ok) return second;
      const stable = ['x', 'y', 'left', 'top', 'width', 'height'].every(key => first[key] === second[key]);
      return stable ? second : { ok: false, reason: 'moving' };
    });
    if (!measured?.ok) {
      const covered = measured?.covered_by;
      const reason = covered
        ? `The target is covered by <${covered.tag}${covered.role ? ` role="${covered.role}"` : ''}>${covered.text ? ` ("${covered.text}")` : ''} while Chrome rendering is paused.`
        : 'The target is hidden, disabled, covered or moving while Chrome rendering is paused.';
      throw new ControlError('ELEMENT_NOT_ACTIONABLE', reason,
        covered
          ? 'Dismiss or scroll past the covering element, then inspect a fresh snapshot before trying again.'
          : 'Bring Chrome to the foreground and keep the screen unlocked. Inspect a fresh snapshot or screenshot before trying again.',
        { ...(measured?.reason ? { reason: measured.reason } : {}), ...(covered ? { covered_by: covered } : {}) });
    }
    let nativePoint = measured;
    const frame = await target.ownerFrame();
    if (frame !== page.mainFrame()) {
      const box = await target.boundingBox();
      if (!box || Math.abs(box.width - measured.width) > 0.5 || Math.abs(box.height - measured.height) > 0.5) {
        throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'Cannot safely map this paused frame into viewport coordinates.', 'Keep Chrome foregrounded and inspect a fresh screenshot. Transformed frames require visual interaction.');
      }
      nativePoint = { x: box.x + measured.x - measured.left, y: box.y + measured.y - measured.top };
      for (let current = frame; current?.parentFrame(); current = current.parentFrame()) {
        const parent = current.parentFrame();
        const host = await current.frameElement();
        let parentHost;
        try {
          let origin = { x: 0, y: 0 };
          if (parent !== page.mainFrame()) {
            parentHost = await parent.frameElement();
            const bounds = await parentHost.boundingBox();
            const geometry = await parentHost.evaluate(node => ({ width: node.offsetWidth, height: node.offsetHeight, left: node.clientLeft, top: node.clientTop }));
            if (!bounds || Math.abs(bounds.width - geometry.width) > 0.5 || Math.abs(bounds.height - geometry.height) > 0.5) {
              throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'A paused ancestor frame is transformed or hidden.', 'Keep Chrome foregrounded and inspect a screenshot before using coordinates.');
            }
            origin = { x: bounds.x + geometry.left, y: bounds.y + geometry.top };
          }
          const check = await host.evaluate((node, point) => {
            if (!node.isConnected || getComputedStyle(node).transform !== 'none' || point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) {
              return { uncovered: false };
            }
            let hit = document.elementFromPoint(point.x, point.y);
            while (hit?.shadowRoot) {
              const next = hit.shadowRoot.elementFromPoint(point.x, point.y);
              if (!next || next === hit) break;
              hit = next;
            }
            if (hit === node) return { uncovered: true };
            return {
              uncovered: false,
              covered_by: hit ? {
                tag: hit.tagName.toLowerCase(),
                ...(hit.id ? { id: hit.id } : {}),
                ...(hit.getAttribute?.('role') ? { role: hit.getAttribute('role') } : {}),
                ...((hit.innerText || hit.getAttribute?.('aria-label') || '').trim()
                  ? { text: (hit.innerText || hit.getAttribute?.('aria-label') || '').trim().slice(0, 120) }
                  : {}),
              } : undefined,
            };
          }, { x: nativePoint.x - origin.x, y: nativePoint.y - origin.y });
          if (!check.uncovered) {
            throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'A paused iframe is outside the viewport or covered at the requested point.',
              check.covered_by
                ? 'Dismiss or scroll past the covering element in the parent page, then inspect a fresh snapshot.'
                : 'Bring Chrome foreground and inspect a fresh snapshot or screenshot.',
              check.covered_by ? { reason: 'covered', covered_by: check.covered_by } : undefined);
          }
        } finally { release(host); release(parentHost); }
      }
    }
    return nativePoint;
  }

  async click(page, target, timeout, { button = 'left', click_count = 1, modifiers = [] } = {}) {
    // Android may suspend rendering while CDP evaluation and timers still work.
    // Detect this before sending input; never retry a click that may have executed.
    const framesRunning = await this.isRenderingRunning(target);
    if (framesRunning) {
      this.noteInput('click', this.register(page));
      try {
        return await target.click({ timeout, noWaitAfter: true, button, clickCount: click_count, modifiers });
      } catch (error) {
        if (/intercepts pointer events/i.test(error.message)) {
          throw new ControlError('ELEMENT_NOT_ACTIONABLE', error.message,
            'Another element (such as a modal, cookie banner, or sticky header) is covering this target. Dismiss or scroll past it, then inspect a fresh snapshot.',
            { reason: 'covered' });
        }
        throw error;
      }
    }
    const nativePoint = await this.resolvePausedPoint(page, target);
    this.noteInput('click', this.register(page));
    for (const mod of modifiers) await page.keyboard.down(mod);
    try {
      await page.mouse.click(nativePoint.x, nativePoint.y, { button, clickCount: click_count });
    } finally {
      for (const mod of [...modifiers].reverse()) await page.keyboard.up(mod).catch(() => {});
    }
  }

  async hover(page, target, timeout) {
    const framesRunning = await this.isRenderingRunning(target);
    if (framesRunning) {
      this.noteInput('hover', this.register(page));
      return target.hover({ timeout });
    }
    const nativePoint = await this.resolvePausedPoint(page, target);
    this.noteInput('hover', this.register(page));
    await page.mouse.move(nativePoint.x, nativePoint.y);
  }

  async fillTarget(page, target, text, timeout, { slowly = false, press_enter = false } = {}) {
    const framesRunning = await this.isRenderingRunning(target);
    if (framesRunning) {
      if (slowly) {
        await target.click({ timeout, noWaitAfter: true });
        await target.fill('', { timeout });
        if (text) await target.pressSequentially(text, { delay: 20, timeout });
      } else {
        await target.fill(text, { timeout });
      }
      if (press_enter) await target.press('Enter', { timeout, noWaitAfter: true });
      return;
    }
    const updated = await target.evaluate((node, value) => {
      if (!node.isConnected || node.matches(':disabled') || node.closest('[aria-disabled="true"], [inert]')) return false;
      node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      node.focus();
      if (node.isContentEditable) {
        node.textContent = value;
      } else {
        const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(node, value);
        else node.value = value;
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, text);
    if (!updated) {
      throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'The input target is detached or disabled while Chrome rendering is paused.',
        'Bring Chrome foreground and inspect a fresh snapshot before trying again.');
    }
    if (press_enter) await page.keyboard.press('Enter');
  }

  async selectTarget(target, values, timeout) {
    const framesRunning = await this.isRenderingRunning(target);
    if (framesRunning) {
      await target.selectOption(values, { timeout });
      return;
    }
    const matched = await target.evaluate((node, wanted) => {
      if (!node.isConnected || node.tagName !== 'SELECT' || node.matches(':disabled')) return false;
      const set = new Set(wanted);
      let any = false;
      for (const option of Array.from(node.options)) {
        const hit = set.has(option.value) || set.has(option.label) || set.has(option.textContent?.trim());
        option.selected = hit;
        if (hit) {
          any = true;
          if (!node.multiple) break;
        }
      }
      if (any) {
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return any;
    }, values);
    if (!matched) {
      throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'Could not select the requested option(s) while Chrome rendering is paused.',
        'Verify option values or labels from a fresh snapshot.');
    }
  }

  async drag(page, id, args, sourceTarget, timeout) {
    let destTarget;
    try {
      const srcBox = await (async () => {
        await sourceTarget.evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }));
        return sourceTarget.boundingBox();
      })();
      if (!srcBox || srcBox.width <= 0 || srcBox.height <= 0) {
        throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'The drag source element is not visible.', 'Scroll the element into view and inspect a fresh snapshot.');
      }
      const startX = srcBox.x + srcBox.width / 2;
      const startY = srcBox.y + srcBox.height / 2;
      let endX;
      let endY;
      if (args.target_ref) {
        destTarget = await this.target(args.target_ref, page);
        await destTarget.evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }));
        const dstBox = await destTarget.boundingBox();
        if (!dstBox || dstBox.width <= 0 || dstBox.height <= 0) {
          throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'The drag target element is not visible.', 'Scroll the target element into view and inspect a fresh snapshot.');
        }
        endX = dstBox.x + dstBox.width / 2;
        endY = dstBox.y + dstBox.height / 2;
      } else {
        if (args.dx === undefined && args.dy === undefined) {
          throw new ControlError('DRAG_TARGET_REQUIRED', 'Provide target_ref or dx/dy pixel offset for drag.', 'Pass target_ref for drag-and-drop, or dx/dy for dragging a slider or swiping.');
        }
        endX = startX + (args.dx ?? 0);
        endY = startY + (args.dy ?? 0);
      }
      this.noteInput('drag', id);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: args.steps ?? 8 });
      await page.mouse.up();
    } finally {
      release(destTarget);
    }
  }

  async action(name, args) {
    const { page, id } = await this.page(args.tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog to accept or dismiss it.', { dialog: this.dialogInfo(page) });
    const beforeTabIds = new Set(this.tabInfo.keys());
    const beforeDownloads = (this.downloads.get(page) || []).length;
    const prevSnapshot = name !== 'wait' ? this.lastSnapshotByTab.get(id) : null;
    let target;
    try {
      const refValue = args.ref || args.source_ref;
      if (refValue) target = await this.target(refValue, page);
      await this.perform(page, id, name, args, target);
      if (name !== 'wait') this.outcome.executed = true;
    } catch (error) {
      if (error.code === 'STALE_REF') throw error;
      await this.clearRefs();
      if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'The action opened a blocking JavaScript dialog.', 'Call browser_handle_dialog. Inspect the page before repeating the action.', { action: name, may_have_executed: true, dialog: this.dialogInfo(page) });
      throw error;
    } finally {
      release(target);
    }
    if (!(name === 'wait' && args.snapshot === false)) await this.clearRefs();
    return this.observe(page, id, { action: name, executed: true }, args.wait_for, name === 'wait', args.snapshot !== false, {
      beforeTabIds, beforeDownloads, prevSnapshot,
    });
  }

  async perform(page, id, name, args, target, timeout = this.config.actionTimeout) {
    const chooser = fileChooser => this.fileChoosers.set(page, fileChooser);
    if (name === 'click') page.on('filechooser', chooser);
    try {
      await this.untilDialog(page, async () => {
        this.assertActive();
        if (!['click', 'hover', 'drag', 'wait'].includes(name)) this.noteInput(name, id);
        switch (name) {
          case 'click': await this.click(page, target, timeout, args); break;
          case 'hover': await this.hover(page, target, timeout); break;
          case 'drag': await this.drag(page, id, args, target, timeout); break;
          case 'fill': {
            const capture = this.flowCaptures.get(page);
            const isPassword = capture ? await target.evaluate(node => node.tagName === 'INPUT' && node.type === 'password').catch(() => false) : false;
            await this.fillTarget(page, target, args.text, timeout, { slowly: args.slowly, press_enter: args.press_enter });
            capture?.noteInput(args.text, isPassword);
            break;
          }
          case 'select': await this.selectTarget(target, args.values, timeout); break;
          case 'press':
            if (target) await target.press(args.key, { timeout, noWaitAfter: true });
            else await page.keyboard.press(args.key);
            break;
          case 'scroll':
            if (args.into_view && !target) throw new ControlError('REF_REQUIRED', 'into_view requires an element ref.', 'Choose a current element ref from browser_snapshot.');
            if (args.into_view) await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
            else if (target) await target.evaluate((node, { x, y }) => node.scrollBy({ left: x, top: y, behavior: 'instant' }), args);
            else await page.evaluate(scrollDOM, { x: args.x, y: args.y });
            break;
          case 'navigate': await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout }); break;
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout }); break;
          case 'forward': await page.goForward({ waitUntil: 'domcontentloaded', timeout }); break;
          case 'reload': await page.reload({ waitUntil: 'domcontentloaded', timeout }); break;
          case 'wait': if (!args.wait_for) await page.waitForTimeout(args.milliseconds); break;
          case 'tap': await page.mouse.click(args.x, args.y); break;
          default: throw new Error(`Unknown action: ${name}`);
        }
      });
      // Allow asynchronous file-chooser events to arrive before interception is
      // removed. User clicks outside a tool call retain the native picker.
      if (name === 'click') await page.waitForTimeout(100);
    } finally { if (name === 'click') page.off('filechooser', chooser); }
  }

  async waitFor(page, condition, tabId) {
    const timeout = Math.min(condition.timeout_ms ?? 5000, Math.max(5000, this.config.requestTimeout - 2000));
    const started = Date.now();
    const hasDomCondition = condition.text !== undefined || condition.text_absent !== undefined || condition.url !== undefined || condition.selector !== undefined;
    if (hasDomCondition) {
      const frame = condition.frame_id ? page.frames()[Number(condition.frame_id.replace('frame_', ''))] : page.mainFrame();
      if (!frame) throw new ControlError('FRAME_UNAVAILABLE', 'The wait frame no longer exists.', 'Inspect page_info() and use a current frame_id.');
      try {
        const handle = await frame.waitForFunction(({ text, text_absent, url, selector, state = 'visible' }) => {
          const collectText = () => {
            const parts = [document.body?.innerText || ''];
            const roots = [document];
            for (let i = 0; i < roots.length; i++) {
              for (const el of roots[i].querySelectorAll('*')) {
                if (el.shadowRoot) {
                  roots.push(el.shadowRoot);
                  parts.push(Array.from(el.shadowRoot.children).map(child => child.innerText || '').join('\n'));
                }
              }
            }
            return parts.join('\n');
          };
          const body = (text !== undefined || text_absent !== undefined) ? collectText() : '';
          let ready = true;
          if (selector) {
            const node = document.querySelector(selector);
            const box = node?.getBoundingClientRect();
            const visible = !!(node && box.width && box.height &&
              (node.checkVisibility ? node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : getComputedStyle(node).display !== 'none'));
            ready = state === 'attached' ? !!node : state === 'hidden' ? !visible :
              state === 'enabled' ? visible && !node.matches(':disabled') && !node.closest('[aria-disabled="true"],[inert]') : visible;
          }
          return (text === undefined || body.includes(text)) &&
            (text_absent === undefined || !body.includes(text_absent)) &&
            (url === undefined || location.href.includes(url)) && ready;
        }, condition, { polling: 100, timeout });
        release(handle);
      } catch (error) {
        this.assertActive();
        if (error.name !== 'TimeoutError') throw error;
        return { matched: false, timeout_ms: timeout, recovery: 'Inspect the returned snapshot. The action is not repeated when a condition times out.' };
      }
    }
    if (condition.network_idle) {
      const remaining = Math.max(100, timeout - (Date.now() - started));
      const { stream } = await this.events(tabId || this.selected);
      const idle = await stream.idle({ idle_ms: condition.idle_ms ?? 500, timeout_ms: remaining });
      if (!idle.matched) return idle;
    }
    return { matched: true };
  }

  async observe(page, id, output, condition, alreadyWaited = false, includeSnapshot = true, meta = {}) {
    output.tab_id = id;
    if (!this.dialogs.has(page) && !this.fileChoosers.has(page)) {
      if (condition) {
        try { output.wait = await this.waitFor(page, condition, id); }
        catch (error) { output.wait_error = describeError(error); }
      } else if (!alreadyWaited && includeSnapshot) await page.waitForTimeout(150);
    }
    this.assertActive();
    const chooser = this.fileChoosers.get(page);
    if (chooser) output.file_chooser = { multiple: chooser.isMultiple(), recovery: 'Call browser_upload with local file paths. The native file picker was intercepted.' };
    if (meta.beforeTabIds) {
      try {
        await this.syncPages();
        const opened = [];
        for (const [tabId, info] of this.tabInfo) {
          if (!meta.beforeTabIds.has(tabId)) {
            opened.push({ tab_id: tabId, url: info.url, title: info.title || '(loading)' });
          }
        }
        if (opened.length) {
          output.new_tabs = opened;
          output.new_tabs_hint = 'A new tab opened. Call browser_select_tab with its tab_id to inspect or interact with it.';
        }
      } catch {}
    }
    if (typeof meta.beforeDownloads === 'number') {
      const allDownloads = this.downloads.get(page) || [];
      const recent = allDownloads.slice(meta.beforeDownloads).map(({ download: _dl, ...info }) => info);
      if (recent.length) {
        output.downloads = recent;
        output.downloads_hint = 'A file download started. Call browser_downloads to inspect or save it to a specific local path.';
      }
    }
    if (!includeSnapshot) return { ...output, refs_invalidated: !this.lastSnapshot };
    try {
      const snap = await this.snapshot({ tab_id: id });
      const changes = meta.prevSnapshot ? diffSnapshots(meta.prevSnapshot, this.lastSnapshotByTab.get(id)) : null;
      return { ...output, ...(changes ? { changes } : {}), snapshot: snap };
    } catch (error) {
      return { ...output, observation_error: describeError(error), recovery: 'Inspect the page before repeating any completed actions.' };
    }
  }

  async batch({ tab_id, actions, wait_for, snapshot }) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog.');
    const beforeTabIds = new Set(this.tabInfo.keys());
    const beforeDownloads = (this.downloads.get(page) || []).length;
    const prevSnapshot = this.lastSnapshotByTab.get(id);
    const targets = [];
    const results = [];
    let stop;
    let navigated = false;
    const watchedFrames = new Set([page.mainFrame()]);
    const onNavigation = frame => { if (watchedFrames.has(frame)) navigated = true; };
    const onPopup = () => { navigated = true; };
    const until = Date.now() + Math.max(1, this.config.requestTimeout - Math.min(this.config.actionTimeout, this.config.requestTimeout / 3) - 2000);
    try {
      // Resolve the entire plan against one observed snapshot before any input.
      // Retained nodes cannot silently become positional matches on a new page.
      for (const action of actions) {
        const node = action.ref ? await this.target(action.ref, page) : null;
        targets.push({ node, signature: node ? await node.evaluate(identity) : null });
        if (node) watchedFrames.add(await node.ownerFrame());
      }
      page.on('framenavigated', onNavigation);
      page.on('popup', onPopup);
      for (const [index, action] of actions.entries()) {
        this.assertActive();
        if (navigated || this.dialogs.has(page) || this.fileChoosers.has(page)) {
          stop = { index, reason: navigated ? 'page_changed' : this.dialogs.has(page) ? 'dialog_open' : 'file_chooser_open' };
          break;
        }
        if (Date.now() >= until) { stop = { index, reason: 'time_budget' }; break; }
        const { node, signature } = targets[index];
        this.outcome = { action: 'batch', tab_id: id, action_index: index, executed: results.length > 0, results: [...results] };
        try {
          if (node && (!await node.evaluate(node => node.isConnected) || await node.evaluate(identity) !== signature)) {
            throw new ControlError('STALE_REF', 'A planned element was removed or changed after an earlier action.', 'Inspect the returned snapshot and plan the remaining actions again.');
          }
          await this.perform(page, id, action.action, action, node, Math.min(this.config.actionTimeout, until - Date.now()));
          this.outcome.executed = true;
          results.push({ index, action: action.action, executed: true });
          this.outcome = { action: 'batch', tab_id: id, executed: true, results: [...results] };
          if (index < actions.length - 1) await page.waitForTimeout(100);
        } catch (error) {
          stop = { index, reason: 'action_error', error: describeError(error), ...(this.outcome.may_have_executed ? { may_have_executed: true } : {}) };
          break;
        }
      }
    } finally {
      page.off('framenavigated', onNavigation);
      page.off('popup', onPopup);
      targets.forEach(({ node }) => release(node));
    }
    await this.clearRefs();
    return this.observe(page, id, { action: 'batch', executed: results.length > 0, completed: results.length === actions.length, results, ...(stop ? { stopped: stop } : {}) }, wait_for, false, snapshot !== false, {
      beforeTabIds, beforeDownloads, prevSnapshot,
    });
  }

  async upload({ tab_id, ref, paths, wait_for, snapshot }) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog.');
    const chooser = !ref && this.fileChoosers.get(page);
    if (!ref && !chooser) throw new ControlError('FILE_INPUT_REQUIRED', 'No file input reference or intercepted file chooser is available.', 'Use a file_input ref from browser_snapshot or click Browse files, then call browser_upload.');
    const target = ref ? await this.target(ref, page) : chooser.element();
    try {
      const input = await target.evaluate(node => ({ file: node.tagName === 'INPUT' && node.type === 'file', multiple: node.multiple, attached: node.isConnected }));
      if (!input.file || !input.attached) throw new ControlError('FILE_INPUT_REQUIRED', 'The upload target is not a connected file input.', 'Inspect a fresh snapshot and choose the correct file_input ref.');
      if (paths.length > 1 && !input.multiple) throw new ControlError('FILE_COUNT_INVALID', 'This input accepts only one file.', 'Provide one file path for this upload control.');
      let total = 0;
      const files = [];
      for (const path of paths) {
        if (!isAbsolute(path)) throw new ControlError('UPLOAD_PATH_INVALID', 'Upload paths must be absolute local paths.', 'Use the full path on the machine running the MCP server.');
        let metadata;
        try { metadata = await stat(path); }
        catch { throw new ControlError('UPLOAD_FILE_UNAVAILABLE', `Cannot read local file: ${path}`, 'Check the path and file permissions on the MCP server host.'); }
        total += metadata.size;
        if (!metadata.isFile() || metadata.size > 20 * 1024 * 1024 || total > 50 * 1024 * 1024) {
          throw new ControlError('UPLOAD_FILE_LIMIT', 'Uploads require regular files up to 20 MiB each and 50 MiB total.', 'Choose smaller files and upload at most ten files per call.');
        }
        const buffer = await readFile(path);
        if (buffer.length !== metadata.size) throw new ControlError('UPLOAD_FILE_CHANGED', 'An upload file changed while being read.', 'Finish saving the file before uploading it.');
        const mimeType = UPLOAD_MIME_TYPES[extname(path).toLowerCase()] || 'application/octet-stream';
        files.push({ name: basename(path), mimeType, buffer });
      }
      // Payloads work when Chrome and this Node process have different filesystems.
      this.noteInput('upload', id);
      await target.setInputFiles(files, { timeout: this.config.actionTimeout });
      this.assertActive();
      this.outcome.executed = true;
      this.fileChoosers.delete(page);
      if (chooser) release(target);
      await this.clearRefs();
      return this.observe(page, id, { action: 'upload', executed: true, files: files.map(file => ({ name: file.name, size: file.buffer.length })) }, wait_for, false, snapshot !== false);
    } finally { if (ref) release(target); }
  }

  async screenshot({ tab_id, ref, full = false, max_dim, annotate = false } = {}) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is open in this tab.', 'Read browser_snapshot, then call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    let target;
    const annotatedFrames = [];
    let annotatedMeta = {};
    try {
      if (ref && full) throw new ControlError('SCREENSHOT_SCOPE_INVALID', 'Choose an element crop or a full page screenshot.', 'Use ref for a crop, or full: true without ref.');
      let clip;
      if (ref) {
        target = await this.target(ref, page);
        await target.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
        const box = await target.boundingBox();
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        if (box) {
          const x = Math.max(0, box.x), y = Math.max(0, box.y);
          clip = { x, y, width: Math.min(viewport.width, box.x + box.width) - x, height: Math.min(viewport.height, box.y + box.height) - y };
        }
        if (!clip || clip.width <= 0 || clip.height <= 0) throw new ControlError('ELEMENT_NOT_VISIBLE', 'The screenshot target has no visible viewport area.', 'Scroll its parent into view and inspect a fresh snapshot.');
      }
      if (annotate) {
        if (!this.lastSnapshot || this.lastSnapshot.tab_id !== id || !this.snapshotFrames.length) {
          await this.snapshot({ tab_id: id });
        }
        let annotatedCount = 0;
        for (const entry of this.snapshotFrames) {
          if (entry.frame.isDetached() || !entry.labels?.length) continue;
          try {
            const count = await entry.nodes.evaluate(mountAnnotations, entry.labels);
            annotatedFrames.push(entry.frame);
            annotatedCount += Number(count) || 0;
          } catch {}
        }
        annotatedMeta = { annotated: true, snapshot_id: this.lastSnapshot?.snapshot_id, annotated_count: annotatedCount };
      }
      if (full || max_dim) {
        let session;
        try {
          session = await page.context().newCDPSession(page);
          const { cssContentSize: content, contentSize, cssVisualViewport: viewport } = await session.send('Page.getLayoutMetrics');
          const capture = clip ? { ...clip, x: clip.x + viewport.pageX, y: clip.y + viewport.pageY } :
            full ? { x: content.x, y: content.y, width: content.width, height: content.height } :
              { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight };
          const scale = Math.min(1, (max_dim || 16384) / Math.max(capture.width, capture.height));
          const deviceScale = contentSize.width / content.width || 1;
          const { data } = await withDeadline(() => session.send('Page.captureScreenshot', {
            format: 'jpeg', quality: 70, captureBeyondViewport: full, clip: { ...capture, scale: scale / deviceScale },
          }), this.config.actionTimeout);
          this.assertActive();
          return { tab_id: id, url: page.url(), clip: capture, scale, full, ...annotatedMeta, data };
        } finally { session?.detach().catch(() => {}); }
      }
      const data = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', fullPage: false, ...(clip ? { clip } : {}), timeout: this.config.actionTimeout });
      return { tab_id: id, url: page.url(), ...(clip ? { clip } : {}), ...annotatedMeta, data: data.toString('base64') };
    } finally {
      for (const frame of annotatedFrames) {
        await frame.evaluate(unmountAnnotations).catch(() => {});
      }
      release(target);
    }
  }

  async listOrSaveDownloads({ tab_id, operation = 'list', download_id, path } = {}) {
    const { page, id } = await this.page(tab_id);
    const records = this.downloads.get(page) || [];
    const serialize = item => {
      const { download: _dl, ...meta } = item;
      return meta;
    };
    if (operation === 'list') {
      return { tab_id: id, downloads: records.map(serialize) };
    }
    if (operation === 'save') {
      if (!path || !isAbsolute(path)) {
        throw new ControlError('DOWNLOAD_PATH_INVALID', 'Download output path must be an absolute local path.', 'Use the full path on the machine running the MCP server.');
      }
      const record = download_id
        ? records.find(item => item.download_id === download_id)
        : records.at(-1);
      if (!record) {
        throw new ControlError('DOWNLOAD_NOT_FOUND', 'No captured download was found for this tab.', 'Click a download link first, then call browser_downloads({ operation: "list" }).');
      }
      await withDeadline(() => record.download.saveAs(path), this.config.actionTimeout);
      this.assertActive();
      record.saved_path = path;
      record.status = 'completed';
      return { tab_id: id, saved: true, path, download: serialize(record) };
    }
    throw new ControlError('DOWNLOAD_OPERATION_INVALID', `Unknown download operation: ${operation}`, 'Use "list" or "save".');
  }

  async cookies({ tab_id, operation = 'get', name, value, url, domain, path, http_only, secure, same_site, expires } = {}) {
    const { page, id } = await this.page(tab_id);
    let session;
    try {
      session = await page.context().newCDPSession(page);
      this.assertActive();
      if (operation === 'get') {
        const targetUrl = url || page.url();
        const params = targetUrl && /^https?:\/\//i.test(targetUrl) ? { urls: [targetUrl] } : {};
        const { cookies = [] } = await withDeadline(() => session.send('Network.getCookies', params), this.config.actionTimeout);
        const filtered = name ? cookies.filter(c => c.name === name) : cookies;
        return {
          tab_id: id,
          url: targetUrl,
          cookies: filtered.slice(0, 200).map(c => ({
            name: c.name, value: c.value, domain: c.domain, path: c.path,
            http_only: Boolean(c.httpOnly), secure: Boolean(c.secure),
            ...(c.sameSite ? { same_site: c.sameSite } : {}),
            ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
            session: Boolean(c.session),
          })),
          truncated: filtered.length > 200,
        };
      }
      if (operation === 'set') {
        if (!name || value === undefined) {
          throw new ControlError('COOKIE_ARGUMENTS_INVALID', 'Cookie name and value are required for operation: "set".', 'Pass both name and value.');
        }
        const targetUrl = url || (!domain ? page.url() : undefined);
        this.noteInput('cookies', id);
        const { success } = await withDeadline(() => session.send('Network.setCookie', {
          name, value,
          ...(targetUrl ? { url: targetUrl } : {}),
          ...(domain ? { domain } : {}),
          ...(path ? { path } : {}),
          ...(typeof http_only === 'boolean' ? { httpOnly: http_only } : {}),
          ...(typeof secure === 'boolean' ? { secure } : {}),
          ...(same_site ? { sameSite: same_site } : {}),
          ...(typeof expires === 'number' ? { expires } : {}),
        }), this.config.actionTimeout);
        this.outcome.executed = true;
        return { tab_id: id, set: Boolean(success), name };
      }
      if (operation === 'delete') {
        if (!name) {
          throw new ControlError('COOKIE_ARGUMENTS_INVALID', 'Cookie name is required for operation: "delete".', 'Pass the cookie name to delete.');
        }
        const targetUrl = url || (!domain ? page.url() : undefined);
        this.noteInput('cookies', id);
        await withDeadline(() => session.send('Network.deleteCookies', {
          name,
          ...(targetUrl ? { url: targetUrl } : {}),
          ...(domain ? { domain } : {}),
          ...(path ? { path } : {}),
        }), this.config.actionTimeout);
        this.outcome.executed = true;
        return { tab_id: id, deleted: true, name };
      }
      if (operation === 'clear') {
        this.noteInput('cookies', id);
        await withDeadline(() => session.send('Network.clearBrowserCookies'), this.config.actionTimeout);
        this.outcome.executed = true;
        return { tab_id: id, cleared: true };
      }
      throw new ControlError('COOKIE_OPERATION_INVALID', `Unknown cookie operation: ${operation}`, 'Use "get", "set", "delete", or "clear".');
    } finally {
      session?.detach().catch(() => {});
    }
  }

  async evaluate({ expression, tab_id, frame_id, snapshot }) {
    const { page, id } = await this.page(tab_id);
    const frame = frame_id ? page.frames()[Number(frame_id.replace('frame_', ''))] : page.mainFrame();
    if (!frame) throw new ControlError('FRAME_UNAVAILABLE', 'This frame is no longer available.', 'Inspect a fresh snapshot and choose a current frame_id.');
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking evaluation.', 'Call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    await this.clearRefs();
    this.noteInput('evaluate', id);
    const result = await frame.evaluate(expression);
    this.assertActive();
    this.outcome.executed = true;
    const serialized = JSON.stringify(result ?? null);
    const output = { tab_id: id, executed: true, ...(serialized.length > 20000 ? { result_text: serialized.slice(0, 20000), truncated: true } : { result: result ?? null }) };
    if (snapshot === false) return { ...output, refs_invalidated: true };
    try { return { ...output, snapshot: await this.snapshot({ tab_id: id }) }; }
    catch (error) { return { ...output, observation_error: describeError(error), recovery: 'Evaluation executed, but its snapshot failed. Inspect the page before repeating it.' }; }
  }

  async execCDP({ tab_id, frame_id, method, params = {} }) {
    const { page, id } = await this.page(tab_id);
    const frame = frame_id ? page.frames()[Number(frame_id.replace('frame_', ''))] : page.mainFrame();
    if (!frame) throw new ControlError('FRAME_UNAVAILABLE', 'This frame is no longer available.', 'Inspect page_info() and choose a current frame_id.');
    if (/^(Browser|Target)\./.test(method)) throw new ControlError('CDP_SCOPE_INVALID', 'CDP commands are scoped to the selected web page.', 'Use list_tabs(), new_tab(), select_tab() and close_tab() for tab management.');
    if (!this.execSessions.has(frame)) {
      let session;
      try { session = await page.context().newCDPSession(frame === page.mainFrame() ? page : frame); }
      catch (error) {
        if (/does not have a separate CDP session/.test(error.message)) throw new ControlError('FRAME_CDP_UNAVAILABLE',
          'This iframe shares its parent CDP session.', 'Use js(expression, {frame_id}) for this iframe, or leave frame_id unset for page-scoped CDP commands.');
        throw error;
      }
      if (this.stopped) { session.detach().catch(() => {}); this.assertActive(); }
      this.execSessions.set(frame, session);
    }
    this.noteInput('cdp', id);
    const result = await this.execSessions.get(frame).send(method, params);
    this.assertActive();
    this.outcome.executed = true;
    await this.clearRefs();
    if (JSON.stringify(result).length > 1000000) throw new ControlError('CDP_RESULT_LIMIT', 'CDP returned more than one megabyte.', 'Request a smaller protocol result.');
    return result;
  }
}

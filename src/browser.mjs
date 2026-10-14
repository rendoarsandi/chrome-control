import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { canForward, forwardChrome } from './adb.mjs';
import { connectTransport } from './cdp-transport.mjs';
import { collectDOM, observationStamp, scrollDOM } from './dom.mjs';
import { ControlError, describeError, withDeadline } from './errors.mjs';
import { PageEvents } from './events.mjs';

// Handle release is housekeeping, never a prerequisite for the next request.
const release = handle => { handle?.dispose().catch(() => {}); };
const identity = node => JSON.stringify({
  tag: node.tagName, type: node.getAttribute('type'), label: node.getAttribute('aria-label'),
  text: ['BUTTON', 'A', 'SUMMARY'].includes(node.tagName) || node.getAttribute('role') === 'button' ? node.textContent : null,
  value: ['radio', 'checkbox'].includes(node.type) ? node.value : null,
});

export class BrowserController {
  constructor(chromium, config, { repairForward = false } = {}) {
    this.chromium = chromium;
    this.config = config;
    this.browser = null;
    this.selected = null;
    this.pages = new Map();
    this.dialogs = new Map();
    this.fileChoosers = new Map();
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
    this.outcome = {};
    this.lastSnapshot = null;
    this.snapshotFrames = [];
    this.snapshotCount = 0;
    this.eventStreams = new Map();
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
    this.targets.clear();
    this.titles.clear();
    this.cdp = null;
    this.selected = null;
    for (const stream of this.eventStreams.values()) stream.close();
    this.eventStreams.clear();
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
    this.targets.clear();
    this.titles.clear();
    this.selected = null;
    for (const stream of this.eventStreams.values()) stream.close();
    this.eventStreams.clear();
    for (const session of this.execSessions.values()) session.detach().catch(() => {});
    this.execSessions.clear();
    await withDeadline(() => browser?.close(), 1000).catch(() => {});
  }

  register(page) {
    this.assertActive();
    for (const [id, candidate] of this.pages) if (candidate === page) return id;
    const id = `tab_${this.prefix}_${++this.sequence}`;
    this.pages.set(id, page);
    page.on('dialog', dialog => this.dialogs.set(page, dialog));
    page.on('close', () => {
      this.dialogs.delete(page); this.fileChoosers.delete(page);
      this.eventStreams.get(page)?.close(); this.eventStreams.delete(page);
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
    const live = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
    for (const [id, page] of this.pages) if (!live.includes(page)) {
      this.pages.delete(id);
      this.targets.delete(page);
      this.titles.delete(page);
    }
    if (!this.pages.has(this.selected)) this.selected = null;
    if (live.length === 1 && !this.selected) this.selected = this.register(live[0]);
    live.forEach(page => this.register(page));
    return live;
  }

  async tabs() {
    const live = await this.syncPages();
    const metadataTimeout = new ControlError('SESSION_TIMEOUT', 'Chrome did not answer a browser metadata request.',
      'Call browser_status with reconnect: true. Keep Chrome foregrounded and the screen unlocked.');
    const { targetInfos } = await withDeadline(async () => {
      if (!this.cdp) this.cdp = await this.browser.newBrowserCDPSession();
      this.assertActive();
      return this.cdp.send('Target.getTargets');
    }, 2000, metadataTimeout);
    return Promise.all(live.map(async page => {
      const id = this.register(page);
      if (!this.targets.has(page)) {
        let session;
        let expired = false;
        try {
          const info = await withDeadline(async () => {
            session = await page.context().newCDPSession(page);
            try {
              if (expired) throw metadataTimeout;
              this.assertActive();
              return await session.send('Target.getTargetInfo');
            } finally { session.detach().catch(() => {}); }
          }, 1500, metadataTimeout);
          this.assertActive();
          this.targets.set(page, info.targetInfo.targetId);
        } catch { /* A closing target may not expose metadata yet. */ }
        finally { expired = true; session?.detach().catch(() => {}); }
      }
      this.assertActive();
      const info = targetInfos.find(target => target.targetId === this.targets.get(page));
      const title = info?.title ?? this.titles.get(page) ?? '(loading)';
      return { tab_id: id, url: page.url(), title: this.dialogs.has(page) ? '(dialog open)' : title, selected: this.selected === id };
    }));
  }

  async page(tabId) {
    const live = await this.syncPages();
    const id = tabId || this.selected;
    if (!id || !this.pages.has(id)) {
      const tabs = live.length ? await this.tabs() : [];
      throw new ControlError(tabs.length ? 'TAB_SELECTION_REQUIRED' : 'NO_TABS',
        tabs.length ? 'Select a tab explicitly before controlling it.' : 'Chrome has no open web page targets.',
        tabs.length ? 'Call browser_tabs, then browser_select_tab with a tab_id. You can also pass tab_id to a tool.' : 'Open a tab in Chrome or call browser_new_tab.',
        { tabs });
    }
    return { page: this.pages.get(id), id };
  }

  async selectTab(tabId) {
    const { page, id } = await this.page(tabId);
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

  async snapshot({ tab_id, max_elements = 160, max_text = 12000 } = {}) {
    const { page, id } = await this.page(tab_id);
    this.snapshotCount++;
    if (this.dialogs.has(page)) {
      await this.clearRefs();
      return this.lastSnapshot = { tab_id: id, url: page.url(), dialog: this.dialogInfo(page), frames: [], elements: [], recovery: 'Call browser_handle_dialog to accept or dismiss this dialog before interacting with the page.' };
    }
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
            { maxElements: remainingElements, maxText: remainingText },
            Math.max(1, Math.min(remaining, frame === page.mainFrame() ? this.config.actionTimeout : 1500)));
          this.assertActive();
          this.handles.push(handle, nodes);
          this.snapshotFrames.push({ frame, nodes, stamp: data.stamp });
          if (frame === page.mainFrame()) { title = data.title; this.titles.set(page, title); }
          for (const item of data.elements) {
            const ref = `${snapshotId}:e${elements.length + 1}`;
            this.refs.set(ref, { nodes, index: item.index, page, tabId: id });
            const { index: nodeIndex, ...description } = item;
            elements.push({ ref, frame_id: frameId, ...description });
          }
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
      if (pageFrames.length > 25) warnings.push({ message: 'Only the first 25 frames were inspected.' });
      return this.lastSnapshot = {
        tab_id: id, snapshot_id: snapshotId, url: page.url(), title,
        frames, elements, ...(warnings.length ? { warnings } : {}),
        reference_help: 'Use ref values from this snapshot. A new snapshot or action invalidates earlier references. Offscreen elements are scrolled into view during interaction.',
      };
    }
  }

  async currentSnapshot(tabId) {
    const cached = this.lastSnapshot;
    if (!cached) return null;
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
    if (!this.eventStreams.has(page)) {
      const session = await page.context().newCDPSession(page);
      if (this.stopped) { session.detach().catch(() => {}); this.assertActive(); }
      const stream = new PageEvents(session);
      this.eventStreams.set(page, stream);
      try { await stream.start(); this.assertActive(); }
      catch (error) { stream.close(); this.eventStreams.delete(page); throw error; }
    }
    return { id, stream: this.eventStreams.get(page) };
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

  async click(page, target, timeout) {
    // Android may suspend rendering while CDP evaluation and timers still work.
    // Detect this before sending input; never retry a click that may have executed.
    const framesRunning = await target.evaluate(() => new Promise(resolve => {
      const frame = requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
      const timer = setTimeout(() => { cancelAnimationFrame(frame); resolve(false); }, 150);
    }));
    if (framesRunning) {
      this.noteInput('click', this.register(page));
      return target.click({ timeout, noWaitAfter: true });
    }
    // Sample geometry using timers instead of animation frames. Only send native
    // mouse input when the same retained node is visible, enabled and uncovered.
    const point = await target.evaluate(async node => {
      node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      const measure = () => {
        if (!node.isConnected || node.matches(':disabled') || node.closest('[aria-disabled="true"], [inert]')) return null;
        if (!node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
        const box = node.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return null;
        const left = Math.max(0, box.left), right = Math.min(innerWidth, box.right);
        const top = Math.max(0, box.top), bottom = Math.min(innerHeight, box.bottom);
        if (right <= left || bottom <= top) return null;
        const x = (left + right) / 2, y = (top + bottom) / 2;
        let hit = document.elementFromPoint(x, y);
        while (hit?.shadowRoot) {
          const child = hit.shadowRoot.elementFromPoint(x, y);
          if (!child || child === hit) break;
          hit = child;
        }
        if (!hit || !(hit === node || node.contains(hit))) return null;
        return { x, y, left: box.left, top: box.top, width: box.width, height: box.height };
      };
      const first = measure();
      if (!first) return null;
      await new Promise(resolve => setTimeout(resolve, 75));
      const second = measure();
      return second && Object.keys(first).every(key => first[key] === second[key]) ? second : null;
    });
    if (!point) {
      throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'The target is hidden, disabled, covered or moving while Chrome rendering is paused.',
        'Bring Chrome to the foreground and keep the screen unlocked. Inspect a fresh snapshot or screenshot before trying again.');
    }
    let nativePoint = point;
    const frame = await target.ownerFrame();
    if (frame !== page.mainFrame()) {
      // Playwright's CDP bounding box is expressed in the top-level viewport.
      // Check every ancestor frame at that exact point, not at its center:
      // an overlay may cover only the part containing the requested control.
      const box = await target.boundingBox();
      if (!box || Math.abs(box.width - point.width) > 0.5 || Math.abs(box.height - point.height) > 0.5) {
        throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'Cannot safely map this paused frame into viewport coordinates.', 'Keep Chrome foregrounded and inspect a fresh screenshot. Transformed frames require visual interaction.');
      }
      nativePoint = { x: box.x + point.x - point.left, y: box.y + point.y - point.top };
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
          const uncovered = await host.evaluate((node, point) => {
            if (!node.isConnected || getComputedStyle(node).transform !== 'none' || point.x < 0 || point.y < 0 || point.x >= innerWidth || point.y >= innerHeight) return false;
            let hit = document.elementFromPoint(point.x, point.y);
            while (hit?.shadowRoot) {
              const next = hit.shadowRoot.elementFromPoint(point.x, point.y);
              if (!next || next === hit) break;
              hit = next;
            }
            return hit === node;
          }, { x: nativePoint.x - origin.x, y: nativePoint.y - origin.y });
          if (!uncovered) throw new ControlError('ELEMENT_NOT_ACTIONABLE', 'A paused iframe is outside the viewport or covered at the requested point.', 'Bring Chrome foreground and inspect a fresh snapshot or screenshot.');
        } finally { release(host); release(parentHost); }
      }
    }
    this.noteInput('click', this.register(page));
    await page.mouse.click(nativePoint.x, nativePoint.y);
  }

  async action(name, args) {
    const { page, id } = await this.page(args.tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog to accept or dismiss it.', { dialog: this.dialogInfo(page) });
    let target;
    try {
      if (args.ref) target = await this.target(args.ref, page);
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
    await this.clearRefs();
    return this.observe(page, id, { action: name, executed: true }, args.wait_for, name === 'wait', args.snapshot !== false);
  }

  async perform(page, id, name, args, target, timeout = this.config.actionTimeout) {
    const chooser = fileChooser => this.fileChoosers.set(page, fileChooser);
    if (name === 'click') page.on('filechooser', chooser);
    try {
      await this.untilDialog(page, async () => {
        this.assertActive();
        if (!['click', 'wait'].includes(name)) this.noteInput(name, id);
        switch (name) {
          case 'click': await this.click(page, target, timeout); break;
          case 'fill': await target.fill(args.text, { timeout }); break;
          case 'select': await target.selectOption(args.values, { timeout }); break;
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

  async waitFor(page, condition) {
    const timeout = condition.timeout_ms ?? 5000;
    const frame = condition.frame_id ? page.frames()[Number(condition.frame_id.replace('frame_', ''))] : page.mainFrame();
    if (!frame) throw new ControlError('FRAME_UNAVAILABLE', 'The wait frame no longer exists.', 'Inspect page_info() and use a current frame_id.');
    try {
      const handle = await frame.waitForFunction(({ text, text_absent, url, selector, state = 'visible' }) => {
        const body = document.body?.innerText || '';
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
      return { matched: true };
    } catch (error) {
      this.assertActive();
      if (error.name !== 'TimeoutError') throw error;
      return { matched: false, timeout_ms: timeout, recovery: 'Inspect the returned snapshot. The action is not repeated when a condition times out.' };
    }
  }

  async observe(page, id, output, condition, alreadyWaited = false, includeSnapshot = true) {
    output.tab_id = id;
    if (!this.dialogs.has(page) && !this.fileChoosers.has(page)) {
      if (condition) {
        try { output.wait = await this.waitFor(page, condition); }
        catch (error) { output.wait_error = describeError(error); }
      } else if (!alreadyWaited && includeSnapshot) await page.waitForTimeout(150);
    }
    this.assertActive();
    const chooser = this.fileChoosers.get(page);
    if (chooser) output.file_chooser = { multiple: chooser.isMultiple(), recovery: 'Call browser_upload with local file paths. The native file picker was intercepted.' };
    if (!includeSnapshot) return { ...output, refs_invalidated: !this.lastSnapshot };
    try {
      return { ...output, snapshot: await this.snapshot({ tab_id: id }) };
    } catch (error) {
      return { ...output, observation_error: describeError(error), recovery: 'Inspect the page before repeating any completed actions.' };
    }
  }

  async batch({ tab_id, actions, wait_for, snapshot }) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog.');
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
    return this.observe(page, id, { action: 'batch', executed: results.length > 0, completed: results.length === actions.length, results, ...(stop ? { stopped: stop } : {}) }, wait_for, false, snapshot !== false);
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
        const mimeType = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json' })[extname(path).toLowerCase()] || 'application/octet-stream';
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

  async screenshot({ tab_id, ref, full = false, max_dim } = {}) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is open in this tab.', 'Read browser_snapshot, then call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    let target;
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
          return { tab_id: id, url: page.url(), clip: capture, scale, full, data };
        } finally { session?.detach().catch(() => {}); }
      }
      const data = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', fullPage: false, ...(clip ? { clip } : {}), timeout: this.config.actionTimeout });
      return { tab_id: id, url: page.url(), ...(clip ? { clip } : {}), data: data.toString('base64') };
    } finally { release(target); }
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

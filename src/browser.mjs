import { randomUUID } from 'node:crypto';
import { canForward, forwardChrome } from './adb.mjs';
import { collectDOM } from './dom.mjs';
import { ControlError, describeError, withDeadline } from './errors.mjs';

// Handle release is housekeeping, never a prerequisite for the next request.
const release = handle => { handle?.dispose().catch(() => {}); };

export class BrowserController {
  constructor(chromium, config, { repairForward = false } = {}) {
    this.chromium = chromium;
    this.config = config;
    this.browser = null;
    this.selected = null;
    this.pages = new Map();
    this.dialogs = new Map();
    this.refs = new Map();
    this.handles = [];
    this.sequence = 0;
    this.prefix = randomUUID().slice(0, 8);
    this.stopped = false;
    this.abort = new AbortController();
    this.repairForward = repairForward;
    this.cdp = null;
    this.targets = new Map();
    this.titles = new Map();
    this.outcome = {};
  }

  assertActive() {
    if (this.stopped) throw new ControlError('CONNECTION_RESET', 'This browser connection was reset.',
      'Call browser_status and select the intended tab again. Old element refs are invalid.');
  }

  noteInput(action, tabId) {
    this.assertActive();
    this.outcome = { action, ...(tabId ? { tab_id: tabId } : {}), may_have_executed: true };
  }

  async connect() {
    this.assertActive();
    if (this.browser?.isConnected()) return this.browser;
    await this.clearRefs();
    this.pages.clear();
    this.dialogs.clear();
    this.targets.clear();
    this.titles.clear();
    this.cdp = null;
    this.selected = null;
    const open = async timeout => {
      this.assertActive();
      const browser = await this.chromium.connectOverCDP(this.config.endpoint, { timeout, noDefaults: true });
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
        const unresponsive = /<ws connected>/i.test(lastError.message);
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
    this.targets.clear();
    this.titles.clear();
    this.selected = null;
    await withDeadline(() => browser?.close(), 1000).catch(() => {});
  }

  register(page) {
    this.assertActive();
    for (const [id, candidate] of this.pages) if (candidate === page) return id;
    const id = `tab_${this.prefix}_${++this.sequence}`;
    this.pages.set(id, page);
    page.on('dialog', dialog => this.dialogs.set(page, dialog));
    page.on('close', () => this.dialogs.delete(page));
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
    const page = await context.newPage();
    this.assertActive();
    this.selected = this.register(page);
    this.outcome = { ...this.outcome, tab_id: this.selected, executed: true };
    if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.actionTimeout });
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
    if (this.dialogs.has(page)) {
      await this.clearRefs();
      return { tab_id: id, url: page.url(), dialog: this.dialogInfo(page), frames: [], elements: [], recovery: 'Call browser_handle_dialog to accept or dismiss this dialog before interacting with the page.' };
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
      return {
        tab_id: id, snapshot_id: snapshotId, url: page.url(), title,
        frames, elements, ...(warnings.length ? { warnings } : {}),
        reference_help: 'Use ref values from this snapshot. A new snapshot or action invalidates earlier references. Offscreen elements are scrolled into view during interaction.',
      };
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
    if (await target.ownerFrame() !== page.mainFrame()) {
      throw new ControlError('ANIMATION_FRAMES_PAUSED', 'Chrome is not rendering this frame.',
        'Bring Chrome to the foreground and keep the screen unlocked, then take a fresh snapshot before clicking.');
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
    this.noteInput('click', this.register(page));
    await page.mouse.click(point.x, point.y);
  }

  async action(name, args) {
    const { page, id } = await this.page(args.tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog to accept or dismiss it.', { dialog: this.dialogInfo(page) });
    let target;
    try {
      if (args.ref) target = await this.target(args.ref, page);
      const timeout = this.config.actionTimeout;
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
            if (target) await target.evaluate((node, { x, y }) => node.scrollBy({ left: x, top: y, behavior: 'instant' }), { x: args.x, y: args.y });
            else await page.evaluate(({ x, y }) => window.scrollBy({ left: x, top: y, behavior: 'instant' }), { x: args.x, y: args.y });
            break;
          case 'navigate': await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout }); break;
          case 'back': await page.goBack({ waitUntil: 'domcontentloaded', timeout }); break;
          case 'wait': await page.waitForTimeout(args.milliseconds); break;
          case 'tap': await page.mouse.click(args.x, args.y); break;
          default: throw new Error(`Unknown action: ${name}`);
        }
      });
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
    // Let immediate DOM updates settle; the snapshot is evidence, not a claim of task completion.
    if (name !== 'wait') await page.waitForTimeout(250);
    this.assertActive();
    try {
      return { action: name, executed: true, snapshot: await this.snapshot({ tab_id: id }) };
    } catch (error) {
      return { action: name, executed: true, observation_error: describeError(error), recovery: 'The action executed, but its snapshot failed. Inspect the page before repeating the action.' };
    }
  }

  async screenshot(tabId) {
    const { page, id } = await this.page(tabId);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is open in this tab.', 'Read browser_snapshot, then call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    const data = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', fullPage: false, timeout: this.config.actionTimeout });
    return { tab_id: id, url: page.url(), data: data.toString('base64') };
  }

  async evaluate({ expression, tab_id }) {
    const { page, id } = await this.page(tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking evaluation.', 'Call browser_handle_dialog.', { dialog: this.dialogInfo(page) });
    await this.clearRefs();
    this.noteInput('evaluate', id);
    const result = await page.evaluate(expression);
    this.assertActive();
    this.outcome.executed = true;
    const serialized = JSON.stringify(result ?? null);
    const output = { tab_id: id, executed: true, ...(serialized.length > 20000 ? { result_text: serialized.slice(0, 20000), truncated: true } : { result: result ?? null }) };
    try { return { ...output, snapshot: await this.snapshot({ tab_id: id }) }; }
    catch (error) { return { ...output, observation_error: describeError(error), recovery: 'Evaluation executed, but its snapshot failed. Inspect the page before repeating it.' }; }
  }
}

import { randomUUID } from 'node:crypto';
import { forwardChrome } from './adb.mjs';
import { collectDOM } from './dom.mjs';
import { ControlError, describeError } from './errors.mjs';

export class BrowserController {
  constructor(chromium, config) {
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
  }

  async connect() {
    if (this.stopped) throw new Error('This browser connection was reset.');
    if (this.browser?.isConnected()) return this.browser;
    await this.clearRefs();
    this.pages.clear();
    this.dialogs.clear();
    this.selected = null;
    const open = () => this.chromium.connectOverCDP(this.config.endpoint, { timeout: 5000 });
    try {
      this.browser = await open();
    } catch (error) {
      if (!this.config.autoAdb) {
        throw new ControlError('CDP_UNAVAILABLE', `Could not connect to Chrome: ${error.message}`,
          'Check CHROME_CDP_URL. For Android, open Chrome and forward its debugging socket with adb.');
      }
      await forwardChrome(this.config);
      this.browser = await open().catch(error => {
        throw new ControlError('CDP_UNAVAILABLE', `ADB forwarding completed, but Chrome is still unreachable: ${error.message}`,
          'Keep Chrome open. Check adb forward --list and curl http://127.0.0.1:9222/json/version. Verify the Chrome package and debugging socket.');
      });
    }
    if (this.stopped) {
      await this.browser.close();
      throw new Error('Connection completed after this request was reset.');
    }
    for (const context of this.browser.contexts()) context.setDefaultTimeout(this.config.actionTimeout);
    return this.browser;
  }

  async clearRefs() {
    this.refs.clear();
    const handles = this.handles.splice(0);
    await Promise.allSettled(handles.map(handle => handle.dispose()));
  }

  async disconnect() {
    this.stopped = true;
    const browser = this.browser;
    this.browser = null;
    // For a CDP connection Browser.close disconnects Playwright, preserving Chrome and its tabs.
    await browser?.close().catch(() => {});
    await this.clearRefs();
  }

  register(page) {
    for (const [id, candidate] of this.pages) if (candidate === page) return id;
    const id = `tab_${this.prefix}_${++this.sequence}`;
    this.pages.set(id, page);
    page.on('dialog', dialog => this.dialogs.set(page, dialog));
    page.on('close', () => this.dialogs.delete(page));
    return id;
  }

  async tabs() {
    const browser = await this.connect();
    const live = browser.contexts().flatMap(context => context.pages()).filter(page => !page.isClosed());
    for (const [id, page] of this.pages) if (!live.includes(page)) this.pages.delete(id);
    if (!this.pages.has(this.selected)) this.selected = null;
    if (live.length === 1 && !this.selected) this.selected = this.register(live[0]);
    return Promise.all(live.map(async page => {
      const id = this.register(page);
      return { tab_id: id, url: page.url(), title: this.dialogs.has(page) ? '(dialog open)' : await page.title().catch(() => '(loading)'), selected: this.selected === id };
    }));
  }

  async page(tabId) {
    const tabs = await this.tabs();
    const id = tabId || this.selected;
    if (!id || !this.pages.has(id)) {
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
    this.selected = id;
    return this.snapshot({ tab_id: id });
  }

  async newTab(url = 'about:blank') {
    const browser = await this.connect();
    const context = browser.contexts()[0];
    if (!context) throw new ControlError('NO_CONTEXT', 'Chrome has no browser context.', 'Open Chrome and call browser_status.');
    const page = await context.newPage();
    this.selected = this.register(page);
    if (url !== 'about:blank') await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.actionTimeout });
    await page.bringToFront();
    return this.snapshot({});
  }

  async closeTab(tabId) {
    const { page } = await this.page(tabId);
    await this.clearRefs();
    await page.close({ runBeforeUnload: false });
    return { closed_tab_id: tabId, tabs: await this.tabs() };
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
      let retry = false;
      for (const [index, frame] of pageFrames.slice(0, 25).entries()) {
        const frameId = `frame_${index}`;
        try {
          const handle = await frame.evaluateHandle(collectDOM, { maxElements: remainingElements, maxText: remainingText });
          this.handles.push(handle);
          const dataHandle = await handle.getProperty('data');
          const data = await dataHandle.jsonValue();
          await dataHandle.dispose();
          const nodes = await handle.getProperty('nodes');
          this.handles.push(nodes);
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
          if (frame === page.mainFrame()) throw error;
          warnings.push({ frame_id: frameId, error: error.message });
        }
      }
      if (retry) {
        await page.waitForLoadState('domcontentloaded', { timeout: 1500 }).catch(() => {});
        continue;
      }
      if (pageFrames.length > 25) warnings.push({ message: 'Only the first 25 frames were inspected.' });
      return {
        tab_id: id, snapshot_id: snapshotId, url: page.url(), title: await page.title().catch(() => '(loading)'),
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
    await handle?.dispose().catch(() => {});
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
    try {
      if (accept) await dialog.accept(prompt_text);
      else await dialog.dismiss();
    } catch (error) {
      if (!this.dialogs.has(page)) this.dialogs.set(page, dialog);
      throw error;
    }
    await page.waitForTimeout(250);
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

  async action(name, args) {
    const { page, id } = await this.page(args.tab_id);
    if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'A JavaScript dialog is blocking this tab.', 'Call browser_handle_dialog to accept or dismiss it.', { dialog: this.dialogInfo(page) });
    let target;
    try {
      if (args.ref) target = await this.target(args.ref, page);
      const timeout = this.config.actionTimeout;
      await this.untilDialog(page, async () => {
        switch (name) {
          case 'click': await target.click({ timeout, noWaitAfter: true }); break;
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
    } catch (error) {
      if (error.code === 'STALE_REF') throw error;
      await this.clearRefs();
      if (this.dialogs.has(page)) throw new ControlError('DIALOG_OPEN', 'The action opened a blocking JavaScript dialog.', 'Call browser_handle_dialog. Inspect the page before repeating the action.', { action: name, may_have_executed: true, dialog: this.dialogInfo(page) });
      throw error;
    } finally {
      await target?.dispose().catch(() => {});
    }
    await this.clearRefs();
    // Let immediate DOM updates settle; the snapshot is evidence, not a claim of task completion.
    if (name !== 'wait') await page.waitForTimeout(250);
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
    const result = await page.evaluate(expression);
    const serialized = JSON.stringify(result ?? null);
    return { tab_id: id, ...(serialized.length > 20000 ? { result_text: serialized.slice(0, 20000), truncated: true } : { result: result ?? null }), snapshot: await this.snapshot({ tab_id: id }) };
  }
}

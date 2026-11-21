package dom

// CollectDOMJS is executed in each frame via Runtime.callFunctionOn/evaluate.
// It retains actual DOM nodes in result.nodes and returns structured metadata in result.data.
const CollectDOMJS = `function(opts) {
  const {
    maxElements = 160,
    maxText = 12000,
    viewportOnly = false,
    scope = null,
    filter = null,
    roles = null,
    includeBbox = false,
  } = opts || {};
  const nodes = [];
  const shadowText = [];
  const interactiveCandidates = [];
  const labelCandidates = [];
  const scrollCandidates = [];
  const imageCandidates = [];
  const interactive = [
    'a',
    'button',
    'input:not([type="hidden"])',
    'textarea',
    'select',
    'summary',
    '[onclick]',
    '[aria-haspopup]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="textbox"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="option"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="searchbox"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="treeitem"]',
    '[contenteditable]:not([contenteditable="false"])',
    '[tabindex]:not([tabindex="-1"])',
    'video',
    'audio',
  ].join(',');

  const visible = element => {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    if (element.checkVisibility) return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  const scrollable = element => {
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return false;
    const style = getComputedStyle(element);
    return (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1);
  };

  const detectChallenge = () => {
    const href = location.href || '';
    const title = document.title || '';
    if (/recaptcha\/api2|google\.com\/recaptcha/i.test(href) || document.querySelector('iframe[src*="recaptcha"], .g-recaptcha, [data-sitekey][class*="recaptcha"]')) {
      return { kind: 'recaptcha', reason: 'Detected a reCAPTCHA verification widget.' };
    }
    if (/hcaptcha\.com/i.test(href) || document.querySelector('iframe[src*="hcaptcha.com"], .h-captcha')) {
      return { kind: 'hcaptcha', reason: 'Detected an hCaptcha verification widget.' };
    }
    if (
      /challenges\.cloudflare\.com/i.test(href) ||
      document.querySelector('iframe[src*="challenges.cloudflare.com"], .cf-turnstile, #turnstile-wrapper, #challenge-form') ||
      (/^(?:just a moment|attention required)/i.test(title.trim()) && document.querySelector('#cf-wrapper, #challenge-running, #challenge-stage, [id*="cf-chl"]'))
    ) {
      return { kind: 'turnstile', reason: 'Detected a Cloudflare verification challenge.' };
    }
    if (document.querySelector('iframe[src*="arkoselabs.com"], iframe[src*="funcaptcha.com"]')) {
      return { kind: 'arkose', reason: 'Detected an Arkose/FunCaptcha verification challenge.' };
    }
    if (document.querySelector('iframe[src*="captcha-delivery.com"], #px-captcha')) {
      return { kind: 'captcha', reason: 'Detected a bot verification challenge.' };
    }
    return null;
  };

  let scopedRoot = document;
  let scopeMatched = true;
  if (scope) {
    try {
      scopedRoot = document.querySelector(scope);
      if (!scopedRoot) {
        const searchRoots = [document];
        for (let i = 0; i < searchRoots.length && !scopedRoot; i++) {
          for (const el of searchRoots[i].querySelectorAll('*')) {
            if (el.shadowRoot) {
              scopedRoot = el.shadowRoot.querySelector(scope);
              if (scopedRoot) break;
              searchRoots.push(el.shadowRoot);
            }
          }
        }
      }
      if (!scopedRoot) scopeMatched = false;
    } catch {
      scopeMatched = false;
      scopedRoot = null;
    }
  }

  const roots = scopedRoot ? [scopedRoot] : [];
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    if (root.matches?.(interactive)) interactiveCandidates.push(root);
    interactiveCandidates.push(...root.querySelectorAll(interactive));
    if (root.matches?.('img[alt]')) imageCandidates.push(root);
    imageCandidates.push(...root.querySelectorAll('img[alt]'));
    for (const element of root.querySelectorAll('*')) {
      if (element.tagName === 'LABEL' && element.control && ['checkbox', 'radio'].includes(element.control.type) && !visible(element.control)) {
        labelCandidates.push(element);
      }
      if (scrollable(element)) scrollCandidates.push(element);
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        shadowText.push(Array.from(element.shadowRoot.children).map(child => child.innerText || '').join('\n'));
      }
    }
  }

  const candidates = [...interactiveCandidates, ...labelCandidates, ...scrollCandidates, ...imageCandidates];

  const key = Symbol.for('chrome-control.observation');
  const tracker = globalThis[key] ||= { revision: 0 };
  tracker.observer ||= new MutationObserver(() => { tracker.revision++; });
  if (tracker.observer.takeRecords().length) tracker.revision++;
  tracker.observer.disconnect();
  for (const root of (roots.length ? roots : [document])) {
    tracker.observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  tracker.stamp = retained => {
    if (tracker.observer.takeRecords().length) tracker.revision++;
    const properties = retained.map(node => {
      const box = node.getBoundingClientRect();
      return [node.isConnected, node.type === 'password' ? null : node.value,
        node.checked, node.disabled, node.scrollLeft, node.scrollTop, node.scrollHeight, node.scrollWidth,
        box.x, box.y, box.width, box.height, node.complete, node.naturalWidth,
        node.type === 'file' ? Array.from(node.files || []).map(file => [file.name, file.size]) : null];
    });
    const text = JSON.stringify([tracker.revision, location.href, document.title, innerWidth, innerHeight, scrollX, scrollY,
      document.body?.innerText, ...roots.slice(1).map(root => Array.from(root.children).map(child => child.innerText || '').join('\n')), properties]);
    let hash = 2166136261;
    for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
    return String(hash >>> 0);
  };

  const inferRole = element => {
    if (element.getAttribute('role')) return element.getAttribute('role');
    const tag = element.tagName.toLowerCase();
    if (tag === 'label' && element.control && ['checkbox', 'radio'].includes(element.control.type)) {
      return element.control.type;
    }
    if (tag === 'input') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider', file: 'file_input', search: 'searchbox', number: 'spinbutton' })[element.type] || 'textbox';
    return ({ a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button', img: 'img' })[tag] || (element.isContentEditable ? 'textbox' : tag);
  };

  const filterNeedle = typeof filter === 'string' && filter.trim() ? filter.trim().toLowerCase() : null;
  const roleSet = Array.isArray(roles) && roles.length ? new Set(roles.map(r => String(r).toLowerCase())) : null;
  const elements = [];
  let total = 0;

  for (const element of new Set(candidates)) {
    const isMedia = element.tagName === 'VIDEO' || element.tagName === 'AUDIO';
    const mediaSrc = isMedia ? (element.currentSrc || element.getAttribute('src') || element.querySelector('source[src]')?.src || '') : '';
    if (!visible(element) && element.type !== 'file' && !(isMedia && (mediaSrc || element.controls))) continue;
    if (element.tagName === 'A' && !element.hasAttribute('href') && !element.hasAttribute('onclick') && getComputedStyle(element).cursor !== 'pointer') continue;

    const box = element.getBoundingClientRect();
    const inViewport = box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
    if (viewportOnly && !inViewport && element.type !== 'file') continue;

    const role = inferRole(element);
    if (roleSet && !roleSet.has(role.toLowerCase())) continue;

    const root = element.getRootNode();
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => root.getElementById?.(id)?.textContent || '').join(' ').trim();
    const mediaLabel = isMedia
      ? ((mediaSrc && !mediaSrc.startsWith('data:') && !mediaSrc.startsWith('blob:') ? mediaSrc.split('/').pop()?.split('?')[0] : '') || element.tagName.toLowerCase())
      : '';
    const label = element.getAttribute('aria-label') || labelledBy ||
      Array.from(element.labels || []).map(item => item.innerText).join(' ') || element.innerText ||
      element.getAttribute('placeholder') || element.getAttribute('title') ||
      element.getAttribute('alt') || element.querySelector('img[alt]')?.getAttribute('alt') ||
      (['submit', 'button'].includes(element.type) ? element.value : '') ||
      (element.type === 'file' ? 'Choose file' : isMedia ? mediaLabel : scrollable(element) ? ('Scrollable ' + element.tagName.toLowerCase()) : '');
    const trimmedLabel = label.trim();
    const placeholder = element.getAttribute('placeholder') || '';
    const value = 'value' in element && !['password', 'file'].includes(element.type) ? String(element.value) : undefined;
    const href = element.tagName === 'A' && element.hasAttribute('href') ? element.href : undefined;

    if (filterNeedle) {
      const hay = [trimmedLabel, placeholder, value || '', href || '', role, element.tagName.toLowerCase()].join(' ').toLowerCase();
      if (!hay.includes(filterNeedle)) continue;
    }

    total++;
    if (elements.length >= maxElements) continue;

    const options = element.tagName === 'SELECT' ? Array.from(element.options) : undefined;
    const shownOptions = options?.filter((option, index) => index < 80 || option.selected);
    const isFocused = (root.activeElement || document.activeElement) === element;
    const ariaExpanded = element.getAttribute('aria-expanded');
    const ariaSelected = element.getAttribute('aria-selected');
    const ariaPressed = element.getAttribute('aria-pressed');
    const ariaInvalid = element.getAttribute('aria-invalid');
    const isRequired = Boolean(element.required || element.getAttribute('aria-required') === 'true');
    const isReadonly = Boolean(element.readOnly || element.getAttribute('aria-readonly') === 'true');
    const validationMessage = typeof element.validationMessage === 'string' && element.validationMessage ? element.validationMessage.slice(0, 300) : '';
    const labelControl = element.tagName === 'LABEL' && element.control && ['checkbox', 'radio'].includes(element.control.type) ? element.control : null;

    elements.push({
      index: nodes.length,
      tag: element.tagName.toLowerCase(),
      role,
      name: trimmedLabel.slice(0, 300),
      ...(trimmedLabel.length > 300 ? { name_truncated: true } : {}),
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true' || Boolean(labelControl?.disabled),
      in_viewport: inViewport,
      ...(isFocused ? { focused: true } : {}),
      ...(element.type ? { type: element.type } : {}),
      ...(placeholder && placeholder !== trimmedLabel ? { placeholder: placeholder.slice(0, 200) } : {}),
      ...(isRequired ? { required: true } : {}),
      ...(isReadonly ? { readonly: true } : {}),
      ...(value !== undefined ? { value: value.slice(0, 2000), ...(value.length > 2000 ? { value_truncated: true, value_length: value.length } : {}) } : {}),
      ...(element.type === 'file' ? { accept: element.accept, multiple: element.multiple, files: Array.from(element.files || []).map(file => ({ name: file.name, size: file.size })) } : {}),
      ...('checked' in element ? { checked: element.checked } : labelControl ? { checked: labelControl.checked } : {}),
      ...(element.getAttribute('aria-checked') ? { aria_checked: element.getAttribute('aria-checked') } : {}),
      ...(ariaExpanded !== null ? { aria_expanded: ariaExpanded } : {}),
      ...(ariaSelected !== null ? { aria_selected: ariaSelected } : {}),
      ...(ariaPressed !== null ? { aria_pressed: ariaPressed } : {}),
      ...(ariaInvalid && ariaInvalid !== 'false' ? { aria_invalid: ariaInvalid } : {}),
      ...(validationMessage ? { validation_message: validationMessage } : {}),
      ...(options ? { options: shownOptions.map(option => ({ value: option.value, label: option.label, selected: option.selected })), ...(shownOptions.length < options.length ? { options_truncated: true } : {}) } : {}),
      ...(href ? { href } : {}),
      ...(element.tagName === 'IMG' ? { image: { loaded: element.complete && element.naturalWidth > 0, width: element.naturalWidth, height: element.naturalHeight } } : {}),
      ...(isMedia ? {
        media: {
          src: mediaSrc.slice(0, 2000),
          duration: Number.isFinite(element.duration) ? Math.round(element.duration * 100) / 100 : null,
          paused: Boolean(element.paused),
          muted: Boolean(element.muted),
          ended: Boolean(element.ended),
          ...(element.tagName === 'VIDEO' ? { width: element.videoWidth || 0, height: element.videoHeight || 0 } : {}),
        },
      } : {}),
      ...(scrollable(element) ? { scroll: { x: element.scrollLeft, y: element.scrollTop, max_x: element.scrollWidth - element.clientWidth, max_y: element.scrollHeight - element.clientHeight } } : {}),
      ...(includeBbox ? { bbox: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) } } : {}),
    });
    nodes.push(element);
  }

  const baseText = scopedRoot === document ? (document.body?.innerText || '') : (scopedRoot?.innerText || '');
  const text = [baseText, ...shadowText].join('\n').trim();
  const challenge = detectChallenge();
  return {
    nodes,
    data: {
      stamp: tracker.stamp(nodes),
      title: document.title,
      text: text.slice(0, maxText),
      text_truncated: text.length > maxText,
      elements,
      elements_truncated: total > elements.length,
      ...(scope ? { scope_matched: scopeMatched } : {}),
      ...(challenge ? { challenge } : {}),
    },
  };
}`

// ObservationStampJS verifies a cached snapshot's fingerprint on retained nodes.
const ObservationStampJS = `function() {
  return globalThis[Symbol.for('chrome-control.observation')]?.stamp(this) ?? null;
}`

// ScrollDOMJS scrolls the scrollable container under the viewport center or falls back to document.scrollingElement.
const ScrollDOMJS = `function(opts) {
  const x = (opts && opts.x) || 0;
  const y = (opts && opts.y) || 0;
  const canScroll = node => {
    if (!(node instanceof Element)) return false;
    const style = getComputedStyle(node);
    return (y && /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1) ||
      (x && /auto|scroll/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1);
  };
  let node = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
  while (node && !canScroll(node)) node = node.parentElement || node.getRootNode().host;
  node ||= document.scrollingElement;
  if (!node) return { moved: false };
  const before = { x: node.scrollLeft, y: node.scrollTop };
  node.scrollBy({ left: x, top: y, behavior: 'instant' });
  return { tag: node.tagName.toLowerCase(), x: node.scrollLeft, y: node.scrollTop, moved: before.x !== node.scrollLeft || before.y !== node.scrollTop };
}`

// MountAnnotationsJS overlays temporary Set-of-Marks badges over visible retained nodes.
const MountAnnotationsJS = `function(labels) {
  const nodes = this;
  const existing = document.querySelector('[data-chrome-control-som="1"]');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.setAttribute('data-chrome-control-som', '1');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;overflow:hidden;';
  const palette = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2'];
  let count = 0;
  for (let i = 0; i < nodes.length && i < labels.length; i++) {
    const node = nodes[i];
    const label = labels[i];
    if (!node || !node.isConnected) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (box.bottom <= 0 || box.right <= 0 || box.top >= innerHeight || box.left >= innerWidth) continue;
    if (node.checkVisibility && !node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const color = palette[count % palette.length];
    const outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;left:' + Math.max(0, box.left) + 'px;top:' + Math.max(0, box.top) + 'px;width:' + Math.max(2, Math.min(box.width, innerWidth - Math.max(0, box.left))) + 'px;height:' + Math.max(2, Math.min(box.height, innerHeight - Math.max(0, box.top))) + 'px;border:2px solid ' + color + ';box-sizing:border-box;border-radius:2px;pointer-events:none;';
    const badge = document.createElement('span');
    badge.textContent = label;
    const badgeTop = Math.max(0, box.top - 16);
    const badgeLeft = Math.max(0, Math.min(box.left, innerWidth - 36));
    badge.style.cssText = 'position:fixed;left:' + badgeLeft + 'px;top:' + badgeTop + 'px;background:' + color + ';color:#fff;font:bold 11px/14px monospace;padding:1px 3px;border-radius:2px;pointer-events:none;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.4);';
    overlay.appendChild(outline);
    overlay.appendChild(badge);
    count++;
  }
  (document.documentElement || document.body)?.appendChild(overlay);
  return count;
}`

// UnmountAnnotationsJS removes the Set-of-Marks overlay.
const UnmountAnnotationsJS = `function() {
  const existing = document.querySelector('[data-chrome-control-som="1"]');
  if (existing) existing.remove();
}`

// IdentityJS computes a node identity signature used to verify batch targets haven't mutated.
const IdentityJS = `function() {
  const node = this;
  return JSON.stringify({
    tag: node.tagName,
    type: node.getAttribute('type'),
    label: node.getAttribute('aria-label'),
    text: ['BUTTON', 'A', 'SUMMARY'].includes(node.tagName) || node.getAttribute('role') === 'button' ? node.textContent : null,
    value: ['radio', 'checkbox'].includes(node.type) ? node.value : null,
  });
}`

// ResolveActionPointJS scrolls a node into view, verifies visibility/enabled/uncovered/stability,
// and returns frame-local coordinates + covered_by details if occluded.
const ResolveActionPointJS = `async function(checkStabilityMs) {
  const node = this;
  if (!node || !node.isConnected) return { ok: false, reason: 'detached' };
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
  if (checkStabilityMs > 0) {
    await new Promise(resolve => setTimeout(resolve, checkStabilityMs));
    const second = measure();
    if (!second.ok) return second;
    const stable = ['x', 'y', 'left', 'top', 'width', 'height'].every(key => Math.abs(first[key] - second[key]) <= 0.5);
    return stable ? second : { ok: false, reason: 'moving' };
  }
  return first;
}`

// FillElementJS sets an input/textarea/contenteditable value cleanly and dispatches input/change events.
const FillElementJS = `function(value) {
  const node = this;
  if (!node || !node.isConnected || node.matches(':disabled') || node.closest('[aria-disabled="true"], [inert]')) {
    return { ok: false, reason: 'not_actionable' };
  }
  node.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
  node.focus();
  if (node.isContentEditable) {
    node.textContent = value;
  } else if (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT') {
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(node, value);
    else node.value = value;
  } else {
    return { ok: false, reason: 'not_fillable' };
  }
  node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}`

// SelectOptionJS selects one or more options on a <select> element by value or visible label.
const SelectOptionJS = `function(wanted) {
  const node = this;
  if (!node || !node.isConnected || node.tagName !== 'SELECT' || node.matches(':disabled')) {
    return { ok: false, reason: 'not_actionable' };
  }
  const set = new Set(wanted);
  let any = false;
  for (const option of Array.from(node.options)) {
    const hit = set.has(option.value) || set.has(option.label) || set.has((option.textContent || '').trim());
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
  return { ok: any, reason: any ? '' : 'option_not_found' };
}`

// UploadFilesJS attaches base64-encoded file payloads to an <input type="file"> using DataTransfer.
const UploadFilesJS = `function(files) {
  const node = this;
  if (!node || !node.isConnected || node.tagName !== 'INPUT' || node.type !== 'file') {
    return { ok: false, reason: 'not_file_input' };
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.mimeType || 'application/octet-stream' }));
  }
  node.files = dt.files;
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, count: node.files.length };
}`

// WaitForCheckJS checks a single poll of wait_for conditions (text, text_absent, url, selector/state).
const WaitForCheckJS = `function(cond) {
  const { text, text_absent, url, selector, state = 'visible' } = cond || {};
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
}`

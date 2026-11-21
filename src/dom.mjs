// Executed in each frame. Retain actual nodes instead of assigning mutable XPath indices.
export function collectDOM({
  maxElements,
  maxText,
  viewportOnly = false,
  scope = null,
  filter = null,
  roles = null,
  includeBbox = false,
}) {
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
    // Upload widgets often hide their input and open it from a visible button.
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
      (element.type === 'file' ? 'Choose file' : isMedia ? mediaLabel : scrollable(element) ? `Scrollable ${element.tagName.toLowerCase()}` : '');
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
}

// A small fingerprint verifies cached observations without rediscovering the
// DOM. Property changes (which MutationObserver misses) and layout are included.
export function observationStamp(nodes) {
  return globalThis[Symbol.for('chrome-control.observation')]?.stamp(nodes) ?? null;
}

// Choose the visible scroll container under the viewport center before falling
// back to the document. App shells often keep window.scrollY fixed at zero.
export function scrollDOM({ x, y }) {
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
}

// Temporarily render numbered Set-of-Marks badges over retained nodes for screenshots.
export function mountAnnotations(nodes, labels) {
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
    outline.style.cssText = `position:fixed;left:${Math.max(0, box.left)}px;top:${Math.max(0, box.top)}px;width:${Math.max(2, Math.min(box.width, innerWidth - Math.max(0, box.left)))}px;height:${Math.max(2, Math.min(box.height, innerHeight - Math.max(0, box.top)))}px;border:2px solid ${color};box-sizing:border-box;border-radius:2px;pointer-events:none;`;
    const badge = document.createElement('span');
    badge.textContent = label;
    const badgeTop = Math.max(0, box.top - 16);
    const badgeLeft = Math.max(0, Math.min(box.left, innerWidth - 36));
    badge.style.cssText = `position:fixed;left:${badgeLeft}px;top:${badgeTop}px;background:${color};color:#fff;font:bold 11px/14px monospace;padding:1px 3px;border-radius:2px;pointer-events:none;white-space:nowrap;box-shadow:0 1px 2px rgba(0,0,0,0.4);`;
    overlay.appendChild(outline);
    overlay.appendChild(badge);
    count++;
  }
  (document.documentElement || document.body)?.appendChild(overlay);
  return count;
}

export function unmountAnnotations() {
  const existing = document.querySelector('[data-chrome-control-som="1"]');
  if (existing) existing.remove();
}

// Render a snapshot's element list into a compact, token-efficient outline.
export function formatCompactElements(elements = []) {
  return elements.map(el => {
    const parts = [`[${el.ref}]`, el.role || el.tag];
    if (el.name) parts.push(JSON.stringify(el.name));
    if (el.frame_id && el.frame_id !== 'frame_0') parts.push(`frame=${el.frame_id}`);
    if (el.value !== undefined && el.value !== '') parts.push(`value=${JSON.stringify(el.value.slice(0, 120))}`);
    if (el.placeholder) parts.push(`placeholder=${JSON.stringify(el.placeholder.slice(0, 80))}`);
    if (el.checked === true) parts.push('checked');
    else if (el.checked === false) parts.push('unchecked');
    if (el.aria_checked) parts.push(`aria-checked=${el.aria_checked}`);
    if (el.aria_expanded !== undefined) parts.push(`expanded=${el.aria_expanded}`);
    if (el.aria_selected !== undefined) parts.push(`selected=${el.aria_selected}`);
    if (el.aria_pressed !== undefined) parts.push(`pressed=${el.aria_pressed}`);
    if (el.aria_invalid) parts.push(`invalid=${el.aria_invalid}`);
    if (el.focused) parts.push('focused');
    if (el.required) parts.push('required');
    if (el.readonly) parts.push('readonly');
    if (el.disabled) parts.push('disabled');
    if (el.in_viewport === false) parts.push('offscreen');
    if (el.href) parts.push(`href=${JSON.stringify(el.href.slice(0, 160))}`);
    if (el.options?.length) {
      const opts = el.options.slice(0, 12).map(o => `${o.selected ? '*' : ''}${o.value}${o.label && o.label !== o.value ? `(${o.label})` : ''}`).join('|');
      parts.push(`options=[${opts}${el.options.length > 12 || el.options_truncated ? '|...' : ''}]`);
    }
    if (el.bbox) parts.push(`bbox=${el.bbox.x},${el.bbox.y},${el.bbox.width}x${el.bbox.height}`);
    if (el.validation_message) parts.push(`error=${JSON.stringify(el.validation_message)}`);
    return parts.join(' ');
  }).join('\n');
}

// Compute a concise diff summary between two snapshots of the same tab.
export function diffSnapshots(previous, current) {
  if (!previous || !current || previous.tab_id !== current.tab_id) return null;
  if (previous.dialog || current.dialog) return null;
  const changes = {};
  if (previous.url !== current.url) changes.url_changed = { from: previous.url, to: current.url };
  if (previous.title !== current.title) changes.title_changed = { from: previous.title, to: current.title };
  const sig = el => `${el.frame_id || 'frame_0'}|${el.role}|${el.name}|${el.value ?? ''}|${el.checked ?? ''}`;
  const prevCounts = new Map();
  for (const el of previous.elements || []) {
    const key = sig(el);
    prevCounts.set(key, (prevCounts.get(key) || 0) + 1);
  }
  const added = [];
  const nextCounts = new Map();
  for (const el of current.elements || []) {
    const key = sig(el);
    nextCounts.set(key, (nextCounts.get(key) || 0) + 1);
    const remaining = prevCounts.get(key) || 0;
    if (remaining > 0) prevCounts.set(key, remaining - 1);
    else if (added.length < 15) added.push({ ref: el.ref, role: el.role, name: el.name, ...(el.value !== undefined && el.value !== '' ? { value: el.value.slice(0, 120) } : {}) });
  }
  let removedCount = 0;
  for (const count of prevCounts.values()) removedCount += count;
  if (added.length) changes.added_elements = added;
  if (removedCount > 0) changes.removed_elements = removedCount;

  const prevLines = new Set((previous.frames || []).flatMap(f => (f.text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)));
  const newLines = [];
  let newTextLen = 0;
  for (const frame of current.frames || []) {
    for (const rawLine of (frame.text || '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || prevLines.has(line)) continue;
      prevLines.add(line);
      if (newTextLen + line.length + 1 > 500) break;
      newLines.push(line);
      newTextLen += line.length + 1;
    }
  }
  if (newLines.length) changes.new_text = newLines.join('\n');
  if (Object.keys(changes).length === 0) changes.no_visible_change = true;
  return changes;
}

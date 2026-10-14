// Executed in each frame. Retain actual nodes instead of assigning mutable XPath indices.
export function collectDOM({ maxElements, maxText }) {
  const nodes = [];
  const roots = [document];
  const shadowText = [];
  const candidates = [];
  const interactive = 'a,button,input:not([type="hidden"]),textarea,select,summary,img[alt],[onclick],[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="switch"],[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])';
  const scrollable = element => {
    if (element.scrollHeight <= element.clientHeight + 1 && element.scrollWidth <= element.clientWidth + 1) return false;
    const style = getComputedStyle(element);
    return (/auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1) ||
      (/auto|scroll/.test(style.overflowX) && element.scrollWidth > element.clientWidth + 1);
  };
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    candidates.push(...root.querySelectorAll(interactive));
    for (const element of root.querySelectorAll('*')) {
      if (scrollable(element)) candidates.push(element);
      if (element.shadowRoot) {
        roots.push(element.shadowRoot);
        shadowText.push(Array.from(element.shadowRoot.children).map(child => child.innerText || '').join('\n'));
      }
    }
  }
  const visible = element => {
    const box = element.getBoundingClientRect();
    if (!box.width || !box.height) return false;
    if (element.checkVisibility) return element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const style = getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  const inferRole = element => {
    if (element.getAttribute('role')) return element.getAttribute('role');
    const tag = element.tagName.toLowerCase();
    if (tag === 'input') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider', file: 'file_input' })[element.type] || 'textbox';
    return ({ a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button', img: 'img' })[tag] || (element.isContentEditable ? 'textbox' : tag);
  };
  const elements = [];
  let total = 0;
  for (const element of new Set(candidates)) {
    // Upload widgets often hide their input and open it from a visible button.
    if (!visible(element) && element.type !== 'file') continue;
    if (element.tagName === 'A' && !element.hasAttribute('href') && !element.hasAttribute('onclick') && getComputedStyle(element).cursor !== 'pointer') continue;
    total++;
    if (elements.length >= maxElements) continue;
    const root = element.getRootNode();
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => root.getElementById?.(id)?.textContent || '').join(' ').trim();
    const label = element.getAttribute('aria-label') || labelledBy ||
      Array.from(element.labels || []).map(item => item.innerText).join(' ') || element.innerText ||
      element.getAttribute('placeholder') || element.getAttribute('title') ||
      element.getAttribute('alt') || element.querySelector('img[alt]')?.getAttribute('alt') ||
      (['submit', 'button'].includes(element.type) ? element.value : '') ||
      (element.type === 'file' ? 'Choose file' : scrollable(element) ? `Scrollable ${element.tagName.toLowerCase()}` : '');
    const box = element.getBoundingClientRect();
    const value = 'value' in element && !['password', 'file'].includes(element.type) ? String(element.value) : undefined;
    const options = element.tagName === 'SELECT' ? Array.from(element.options) : undefined;
    const shownOptions = options?.filter((option, index) => index < 80 || option.selected);
    elements.push({
      index: nodes.length,
      tag: element.tagName.toLowerCase(),
      role: inferRole(element),
      name: label.trim().slice(0, 300),
      ...(label.trim().length > 300 ? { name_truncated: true } : {}),
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      in_viewport: box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
      ...(element.type ? { type: element.type } : {}),
      ...(value !== undefined ? { value: value.slice(0, 2000), ...(value.length > 2000 ? { value_truncated: true, value_length: value.length } : {}) } : {}),
      ...(element.type === 'file' ? { accept: element.accept, multiple: element.multiple, files: Array.from(element.files || []).map(file => ({ name: file.name, size: file.size })) } : {}),
      ...('checked' in element ? { checked: element.checked } : {}),
      ...(element.getAttribute('aria-checked') ? { aria_checked: element.getAttribute('aria-checked') } : {}),
      ...(options ? { options: shownOptions.map(option => ({ value: option.value, label: option.label, selected: option.selected })), ...(shownOptions.length < options.length ? { options_truncated: true } : {}) } : {}),
      ...(element.tagName === 'A' && element.hasAttribute('href') ? { href: element.href } : {}),
      ...(element.tagName === 'IMG' ? { image: { loaded: element.complete && element.naturalWidth > 0, width: element.naturalWidth, height: element.naturalHeight } } : {}),
      ...(scrollable(element) ? { scroll: { x: element.scrollLeft, y: element.scrollTop, max_x: element.scrollWidth - element.clientWidth, max_y: element.scrollHeight - element.clientHeight } } : {}),
    });
    nodes.push(element);
  }
  const text = [document.body?.innerText || '', ...shadowText].join('\n').trim();
  return { nodes, data: { title: document.title, text: text.slice(0, maxText), text_truncated: text.length > maxText, elements, elements_truncated: total > elements.length } };
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

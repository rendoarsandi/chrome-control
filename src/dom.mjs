// Executed in each frame. Retain actual nodes instead of assigning mutable XPath indices.
export function collectDOM({ maxElements, maxText }) {
  const nodes = [];
  const roots = [document];
  const shadowText = [];
  const candidates = [];
  const interactive = 'a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="textbox"],[role="combobox"],[role="menuitem"],[role="switch"],[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])';
  for (let i = 0; i < roots.length; i++) {
    const root = roots[i];
    candidates.push(...root.querySelectorAll(interactive));
    for (const element of root.querySelectorAll('*')) {
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
    if (tag === 'input') return ({ checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' })[element.type] || 'textbox';
    return ({ a: 'link', button: 'button', textarea: 'textbox', select: 'combobox', summary: 'button' })[tag] || (element.isContentEditable ? 'textbox' : tag);
  };
  const elements = [];
  let total = 0;
  for (const element of candidates) {
    if (!visible(element)) continue;
    total++;
    if (elements.length >= maxElements) continue;
    const root = element.getRootNode();
    const labelledBy = (element.getAttribute('aria-labelledby') || '').split(/\s+/)
      .map(id => root.getElementById?.(id)?.textContent || '').join(' ').trim();
    const label = element.getAttribute('aria-label') || labelledBy ||
      Array.from(element.labels || []).map(item => item.innerText).join(' ') || element.innerText ||
      element.getAttribute('placeholder') || element.getAttribute('title') ||
      element.querySelector('img[alt]')?.getAttribute('alt') ||
      (['submit', 'button'].includes(element.type) ? element.value : '') || '';
    const box = element.getBoundingClientRect();
    elements.push({
      index: nodes.length,
      tag: element.tagName.toLowerCase(),
      role: inferRole(element),
      name: label.trim().slice(0, 300),
      disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
      in_viewport: box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth,
      ...(element.type ? { type: element.type } : {}),
      ...('value' in element && element.type !== 'password' && element.type !== 'file' ? { value: String(element.value).slice(0, 300) } : {}),
      ...('checked' in element ? { checked: element.checked } : {}),
      ...(element.getAttribute('aria-checked') ? { aria_checked: element.getAttribute('aria-checked') } : {}),
      ...(element.tagName === 'SELECT' ? { options: Array.from(element.options).slice(0, 80).map(option => ({ value: option.value, label: option.label, selected: option.selected })) } : {}),
      ...(element.tagName === 'A' ? { href: element.href } : {}),
    });
    nodes.push(element);
  }
  const text = [document.body?.innerText || '', ...shadowText].join('\n').trim();
  return { nodes, data: { title: document.title, text: text.slice(0, maxText), text_truncated: text.length > maxText, elements, elements_truncated: total > elements.length } };
}

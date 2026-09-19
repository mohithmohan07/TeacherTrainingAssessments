// Small helpers shared by every view: element creation, escaping, toasts, dialogs.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'html') el.innerHTML = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// replaceChildren() turns a null child into the text "null", so filter first.
export function mount(parent, ...children) {
  parent.replaceChildren(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return parent;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
  );
}

export function toast(message, kind = 'info') {
  const node = h('div', { class: `toast ${kind}` }, message);
  const stack = document.getElementById('toasts');
  stack.append(node);
  while (stack.children.length > 4) stack.firstElementChild.remove();
  setTimeout(() => {
    node.style.transition = 'opacity .3s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 300);
  }, kind === 'error' ? 6000 : 3200);
}

export function confirmAction(message) {
  return window.confirm(message);
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function formatBytes(bytes) {
  if (!bytes) return '';
  const units = ['B', 'KB', 'MB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function initials(name) {
  return String(name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0].toUpperCase())
    .join('') || '?';
}

export function statusBadge(status) {
  const labels = { draft: 'Draft', scanned: 'Scans uploaded', evaluated: 'Evaluated' };
  return h('span', { class: `badge ${status}` }, labels[status] ?? status);
}

export function logoFor(school, large = false) {
  if (school.logo_path) {
    return h('img', {
      class: `school-logo${large ? ' lg' : ''}`,
      src: `/uploads/${school.logo_path}`,
      alt: `${school.name} logo`,
    });
  }
  const node = h('div', { class: 'logo-placeholder' }, initials(school.name));
  if (large) {
    node.style.width = '92px';
    node.style.height = '92px';
    node.style.fontSize = '26px';
  }
  return node;
}

export function openLightbox(src, alt) {
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const overlay = h(
    'div',
    { class: 'lightbox', onclick: (event) => { if (event.target === overlay) close(); } },
    h('button', { class: 'close', title: 'Close', onclick: close }, '×'),
    h('img', { src, alt: alt ?? '' })
  );
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

export function field(label, control, { span = false, hint } = {}) {
  return h(
    'div',
    { class: `field${span ? ' span-2' : ''}` },
    h('label', { for: control.id || undefined }, label),
    control,
    hint ? h('small', { class: 'hint' }, hint) : null
  );
}

export function input(name, { value = '', type = 'text', placeholder = '', id, required = false } = {}) {
  return h('input', { type, name, id: id ?? `f-${name}`, value: value ?? '', placeholder, required });
}

export function textarea(name, { value = '', placeholder = '' } = {}) {
  const el = h('textarea', { name, id: `f-${name}`, placeholder });
  el.value = value ?? '';
  return el;
}

export function select(name, options, { value = '', id } = {}) {
  const el = h(
    'select',
    { name, id: id ?? `f-${name}` },
    options.map((option) => h('option', { value: option.value }, option.label))
  );
  el.value = value ?? '';
  return el;
}

export function emptyState(message, action) {
  return h('div', { class: 'empty' }, h('p', {}, message), action ?? null);
}

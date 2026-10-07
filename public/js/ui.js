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
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// replaceChildren() turns a null child into the text "null", so filter first.
export function mount(parent, ...children) {
  parent.replaceChildren(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false));
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
  viewPages({ title: alt ?? '', pages: [{ src, name: alt ?? '' }] });
}

// Pictures of pages, shown one at a time over the screen. Each page fits the
// screen; Zoom in (or a click on the page) shows it full width to read, and
// the arrows or arrow keys go through the pages. Close, Escape, a click beside
// the page or the browser's Back button closes it, and the screen underneath
// stays as it was. `pages` is a list of { src, name }. `loadPages` can fetch
// the full list once the first page is showing, and `action` ({ label, run })
// adds a button that closes the pictures and runs.
export function viewPages({ title = '', pages, start = 0, loadPages = null, action = null }) {
  let list = pages;
  let index = Math.min(Math.max(start, 0), list.length - 1);
  let zoomed = false;
  let open = true;

  const image = h('img', { alt: '' });
  const counter = h('span', { class: 'lightbox-count' });
  const zoom = h('button', { class: 'btn btn-sm', type: 'button' });
  const prev = h('button', { class: 'lightbox-nav', type: 'button', title: 'Previous page', 'aria-label': 'Previous page' }, '‹');
  const next = h('button', { class: 'lightbox-nav', type: 'button', title: 'Next page', 'aria-label': 'Next page' }, '›');
  const stage = h('div', { class: 'lightbox-stage' }, image);

  const show = () => {
    const page = list[index];
    if (image.getAttribute('src') !== page.src) image.src = page.src;
    image.alt = page.name || title;
    counter.textContent = list.length > 1 ? `Page ${index + 1} of ${list.length}` : '';
    prev.hidden = next.hidden = list.length < 2;
    prev.disabled = index === 0;
    next.disabled = index === list.length - 1;
    overlay.classList.toggle('zoomed', zoomed);
    zoom.textContent = zoomed ? 'Fit to screen' : 'Zoom in';
  };
  const go = (step) => {
    const to = Math.min(Math.max(index + step, 0), list.length - 1);
    if (to === index) return;
    index = to;
    show();
    stage.scrollTo(0, 0);
  };
  const toggleZoom = () => {
    zoomed = !zoomed;
    show();
    stage.scrollTo(0, 0);
  };

  // Opening adds a step to the browser's history, so Back closes the pictures
  // rather than leaving the page under them. Closing any other way takes the
  // step off again; the promise settles once it has.
  const close = ({ fromHistory = false } = {}) =>
    new Promise((resolve) => {
      if (!open) return resolve();
      open = false;
      overlay.remove();
      document.documentElement.classList.remove('lightbox-open');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onHistory);
      window.removeEventListener('hashchange', onHistory);
      if (fromHistory || !history.state?.lightbox) return resolve();
      window.addEventListener('popstate', () => resolve(), { once: true });
      history.back();
    });
  const onHistory = () => close({ fromHistory: true });
  const onKey = (event) => {
    if (event.key === 'Escape') close();
    else if (event.key === 'ArrowLeft') go(-1);
    else if (event.key === 'ArrowRight') go(1);
  };

  image.addEventListener('click', toggleZoom);
  zoom.addEventListener('click', toggleZoom);
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  stage.addEventListener('click', (event) => {
    if (event.target === stage) close();
  });

  const extra = action
    ? h('button', { class: 'btn btn-sm', type: 'button', onclick: async () => { await close(); action.run(); } }, action.label)
    : null;

  const overlay = h(
    'div',
    { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Page' },
    h(
      'div',
      { class: 'lightbox-bar' },
      h('div', { class: 'lightbox-title' }, title ? h('strong', {}, title) : null, counter),
      h('div', { class: 'lightbox-tools' }, extra, zoom, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => close() }, 'Close ×'))
    ),
    h('div', { class: 'lightbox-body' }, prev, stage, next)
  );

  show();
  history.pushState({ ...history.state, lightbox: true }, '');
  window.addEventListener('popstate', onHistory);
  window.addEventListener('hashchange', onHistory);
  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('lightbox-open');
  document.body.append(overlay);

  loadPages?.().then(
    (all) => {
      if (!open || !all?.length) return;
      const current = list[index].src;
      list = all;
      index = Math.max(0, all.findIndex((page) => page.src === current));
      show();
    },
    () => {} // the page already showing is enough
  );
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

// One section's result: "Section A 72% · B". The colour follows the grade.
export function sectionChip(section, { short = false } = {}) {
  const name = short && /^Section [A-Z]$/.test(section.name) ? section.name.slice(8) : section.name;
  return h(
    'span',
    { class: `grade-chip grade-${section.grade ?? 'none'}`, title: section.grade_label ? `${section.name}: ${section.grade_label}` : section.name },
    section.percent === null || section.percent === undefined ? name : `${name} ${section.percent}%`,
    section.grade ? h('b', {}, section.grade) : null
  );
}

// The same, showing only the percentage, for tables with a column per section.
export function percentChip(section) {
  return sectionChip({ ...section, name: section.percent === null || section.percent === undefined ? '—' : `${section.percent}%`, percent: null });
}

// The potential identifier from the management report. Reports written
// before headlines were in title case still show them in title case.
export function potentialBadge(potential) {
  if (!potential) return null;
  return h('span', { class: `potential potential-${potential.level}` }, titleCase(potential.headline));
}

// Short words that stay lower case inside a title.
const MINOR_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'via', 'with']);

// "Priority for support" → "Priority for Support". It only ever raises a
// first letter, so names such as "UpSchool" or "PE" are left as they are.
export function titleCase(text) {
  const words = String(text ?? '').split(' ');
  return words
    .map((word, i) =>
      i > 0 && i < words.length - 1 && MINOR_WORDS.has(word.toLowerCase())
        ? word
        : word.replace(/^([^\p{L}]*)(\p{Ll})/u, (_, lead, letter) => lead + letter.toUpperCase())
    )
    .join(' ');
}

// UpSchool runs the programme, so its logo is on every report and paper.
export function upschoolLogo(className = 'upschool-logo') {
  return h('img', { class: className, src: '/img/upschool-logo.png', alt: 'UpSchool' });
}

// Printed pages have no page margins (see @page in styles.css): that is what
// stops the browser printing the page address and date at the top and bottom
// of every page. This frame puts the space back on every printed page, and
// repeats `head` at the top of each one. On screen it is just its contents.
export function printFrame(head, ...body) {
  return h(
    'div',
    { class: 'print-frame' },
    h('div', { class: 'print-frame-head' }, h('div', { class: 'print-frame-cell' }, head)),
    h('div', { class: 'print-frame-body' }, h('div', { class: 'print-frame-cell' }, body))
  );
}

// Phones: the menu folds away behind a button, and tables become one card per
// row. Each cell gets its column's heading as `data-label`, which the
// stylesheet shows above the cell on narrow screens only, so printed reports
// and PDFs keep their tables.

export function setUpMenu() {
  const sidebar = document.querySelector('.sidebar');
  const toggle = document.getElementById('menu-toggle');
  if (!sidebar || !toggle) return;
  const close = () => {
    sidebar.classList.remove('menu-open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('menu-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('hashchange', close);
}

function labelTable(table) {
  if (table.dataset.stack) return;
  if (table.querySelector('td[data-label]')) return; // labelled by its own view
  const headings = [...(table.tHead?.rows[0]?.cells ?? [])];
  // Two columns fit a phone as they are.
  if (headings.reduce((total, th) => total + (th.colSpan || 1), 0) < 3) return;
  table.dataset.stack = '';
  table.classList.add('stack-on-phone');
  for (const body of table.tBodies) {
    for (const row of body.rows) {
      let column = 0;
      for (const cell of row.cells) {
        const label = headings[column]?.textContent.trim() ?? '';
        if (label) cell.dataset.label = label;
        column += cell.colSpan || 1;
      }
    }
  }
}

export function stackTablesOnPhones(root) {
  const run = () => root.querySelectorAll('table').forEach(labelTable);
  run();
  // Views redraw parts of themselves, so label any table that appears later.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      run();
    });
  }).observe(root, { childList: true, subtree: true });
}

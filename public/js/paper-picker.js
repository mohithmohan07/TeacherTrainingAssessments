// "Is this the question paper?" The board suggests the library paper that
// best fits a teacher's level, subject and board; this dialog shows it, lets
// it be confirmed or swapped for another, and hands back the chosen papers.
// Nothing is used until it is confirmed here.
import { h, mount, toast } from './ui.js';
import { papersApi } from './api.js';
import { pagesOf } from './evidence.js';

const pdfUrl = (paper) => `/uploads/${paper.stored_name}`;

// A paper's labels in one line: "Section B · Hindi · Primary · CBSE · 35 marks".
export function paperFacts(paper) {
  return [
    paper.sections.length ? `Section${paper.sections.length > 1 ? 's' : ''} ${paper.sections.join(' & ')}` : '',
    paper.subject,
    paper.level_names?.join(', ') || 'Any level',
    paper.board,
    paper.language && paper.language !== 'English' ? paper.language : '',
    paper.total_marks ? `${paper.total_marks} marks` : '',
  ].filter(Boolean).join(' · ');
}

// Matches the stylesheet's width for stacking the dialog.
const narrow = () => window.matchMedia('(max-width: 760px)').matches;

function paperAsPictures(paper) {
  const box = h('div', { class: 'picker-pages' }, h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), 'Opening the paper…'));
  pagesOf({ url: pdfUrl(paper), pdf: true }).then(
    (pages) => mount(box, pages.map((src, i) => h('img', { class: 'picker-page', src, alt: `${paper.title}, page ${i + 1}` }))),
    () => mount(box, h('p', { class: 'empty' }, 'The paper could not be shown here. Press “Open in a new tab” to see it.'))
  );
  return box;
}

// The small first-page picture of a paper, or a PDF badge without one.
export function paperThumb(paper, className = 'paper-thumb') {
  return paper.preview_name
    ? h('img', { class: className, src: `/uploads/${paper.preview_name}`, alt: '', loading: 'lazy' })
    : h('span', { class: `${className} paper-thumb-pdf`, 'aria-hidden': 'true' }, 'PDF');
}

// Opens the dialog. `section` is 'A', 'B' or 'C' for one section, or '' for
// the full paper (one choice per section). `current` holds the papers already
// chosen, if any. Resolves with the chosen paper ids, or null if cancelled.
export async function choosePaper({ teacher, section = '', current = [] }) {
  let data;
  try {
    data = await papersApi.choices(teacher.id, section);
  } catch (error) {
    toast(error.message, 'error');
    return null;
  }
  if (data.slots.every((slot) => !slot.papers.length)) {
    toast(`The paper library has no ${section ? `Section ${section} ` : ''}papers yet. Add them on the Paper library page.`, 'error');
    return null;
  }

  return new Promise((resolve) => {
    const byId = new Map(data.slots.flatMap((slot) => slot.papers.map((paper) => [paper.id, paper])));
    const currentIds = new Set(current.map((paper) => paper.id ?? paper));
    // Each slot starts on the paper already chosen for it, else the suggestion.
    const choice = new Map(
      data.slots.map((slot) => {
        const already = slot.papers.find((paper) => currentIds.has(paper.id));
        return [slot.section, already?.id ?? (currentIds.size ? null : slot.suggested_id)];
      })
    );
    let previewSection = data.slots.find((slot) => choice.get(slot.section))?.section ?? data.slots[0].section;

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    // A paper that holds more than one section (such as A and C together)
    // answers for each of them, so the other slots are filled by it. Slots are
    // taken in order, and a slot already filled this way fills no others.
    const coverage = () => {
      const covered = new Map();
      for (const slot of data.slots) {
        if (covered.has(slot.section)) continue;
        const paper = byId.get(choice.get(slot.section));
        if (!paper || paper.sections.length < 2) continue;
        for (const key of paper.sections) if (key !== slot.section) covered.set(key, paper);
      }
      return covered;
    };
    const coveredBy = (key) => coverage().get(key) ?? null;

    const slotsBox = h('div', { class: 'picker-slots' });
    const previewBox = h('div', { class: 'picker-preview' });
    const confirmButton = h('button', { class: 'btn btn-primary', type: 'button' });
    const suggestedAny = data.slots.some((slot) => slot.suggested_id);

    function chosenIds() {
      const ids = [];
      for (const slot of data.slots) {
        if (coveredBy(slot.section)) continue;
        const id = choice.get(slot.section);
        if (id && !ids.includes(id)) ids.push(id);
      }
      return ids;
    }

    function drawSlots() {
      mount(
        slotsBox,
        data.slots.map((slot) => {
          const cover = coveredBy(slot.section);
          const best = slot.papers.filter((paper) => paper.score > 0);
          const rest = slot.papers.filter((paper) => paper.score <= 0);
          const selectEl = h(
            'select',
            { 'aria-label': `Section ${slot.section} paper`, disabled: Boolean(cover) },
            h('option', { value: '' }, section ? 'Choose a paper' : `Not sitting Section ${slot.section}`),
            best.length ? h('optgroup', { label: 'Best matches' }, best.map((paper) => h('option', { value: String(paper.id) }, paper.title))) : null,
            rest.length ? h('optgroup', { label: best.length ? `Other Section ${slot.section} papers` : `Section ${slot.section} papers` }, rest.map((paper) => h('option', { value: String(paper.id) }, paper.title))) : null
          );
          selectEl.value = cover ? '' : String(choice.get(slot.section) ?? '');
          selectEl.addEventListener('change', () => {
            choice.set(slot.section, selectEl.value ? Number(selectEl.value) : null);
            previewSection = slot.section;
            drawSlots();
            drawPreview();
          });
          const paper = byId.get(choice.get(slot.section));
          const suggested = paper && paper.id === slot.suggested_id;
          return h(
            'div',
            { class: `picker-slot${previewSection === slot.section ? ' active' : ''}` },
            h('div', { class: 'picker-slot-head' }, h('strong', {}, `Section ${slot.section}`), suggested && !cover ? h('span', { class: 'badge suggested' }, 'Suggested') : null),
            cover
              ? h('p', { class: 'hint', style: 'margin:4px 0 0' }, `Covered by “${cover.title}”, which has Section ${slot.section} too.`)
              : selectEl,
            paper && !cover
              ? h(
                  'button',
                  { class: 'btn-link picker-show', type: 'button', onclick: () => { previewSection = slot.section; drawSlots(); drawPreview(); } },
                  previewSection === slot.section ? (narrow() ? 'Shown below' : 'Shown on the right') : 'Show this paper'
                )
              : null
          );
        })
      );
      const ids = chosenIds();
      confirmButton.disabled = !ids.length;
      confirmButton.textContent = ids.length > 1 ? 'Yes, use these papers' : 'Yes, use this paper';
    }

    function drawPreview() {
      const slot = data.slots.find((s) => s.section === previewSection);
      const paper = slot && !coveredBy(slot.section) ? byId.get(choice.get(slot.section)) : null;
      if (!paper) {
        mount(previewBox, h('div', { class: 'picker-empty' }, narrow() ? 'Choose a paper above to see it here.' : 'Choose a paper on the left to see it here.'));
        return;
      }
      const reasons = { level: 'level', subject: 'subject', board: 'board' };
      const matched = (paper.reasons ?? []).map((r) => reasons[r]).filter(Boolean);
      mount(
        previewBox,
        h(
          'div',
          { class: 'picker-paper-head' },
          h('div', {}, h('strong', {}, paper.title), h('div', { class: 'hint' }, paperFacts(paper))),
          h('a', { class: 'btn btn-sm', href: pdfUrl(paper), target: '_blank', rel: 'noopener' }, 'Open in a new tab')
        ),
        matched.length ? h('p', { class: 'hint', style: 'margin:0 0 6px' }, `Matches the teacher’s ${matched.join(', ')}.`) : null,
        paper.notes ? h('p', { class: 'notice picker-note' }, paper.notes) : null,
        // Phone browsers do not show a PDF inside the page, so a phone gets
        // the paper drawn page by page as pictures.
        narrow()
          ? paperAsPictures(paper)
          : h('iframe', { class: 'picker-pdf', src: `${pdfUrl(paper)}#view=FitH`, title: paper.title })
      );
    }

    confirmButton.addEventListener('click', () => close(chosenIds()));

    const details = [teacher.grade, teacher.subjects].filter(Boolean).join(' · ');
    const overlay = h(
      'div',
      { class: 'modal-backdrop', onclick: (event) => { if (event.target === overlay) close(null); } },
      h(
        'div',
        { class: 'modal picker', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Confirm the question paper' },
        h(
          'div',
          { class: 'modal-head' },
          h(
            'div',
            {},
            h('h2', {}, suggestedAny && !currentIds.size
              ? `Is this the question paper ${teacher.name} sat?`
              : `Which question paper did ${teacher.name} sit?`),
            h('p', { class: 'hint' }, `${details ? `${details}. ` : ''}Suggested from the paper library by level, subject and board. Check it, or pick another, before you scan the answers.`)
          ),
          h('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: () => close(null) }, '×')
        ),
        h('div', { class: 'picker-body' }, slotsBox, previewBox),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'), confirmButton)
      )
    );

    drawSlots();
    drawPreview();
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    confirmButton.focus();
  });
}

// Every teacher's answer paper at once, as scanned PDFs. Each PDF is made
// into page pictures here in the browser and uploaded. Once they are all up,
// "Find the question papers" has the server match every one at the same
// time: whose answers they are, which section each page answers, and which
// library paper each section was sat on. Everything can be checked and
// changed, side by side with the question paper, before it is filed. Filing
// never marks anything; Evaluate does.
import { h, mount, toast, select, viewPages, confirmAction } from '../ui.js';
import { bulkApi, papersApi, schoolsApi, teachersApi, testsApi } from '../api.js';
import { loadPdfjs, pagesOf } from '../evidence.js';
import { paperFacts } from '../paper-picker.js';
import { chooseMarking } from '../marking-choice.js';

// Where a page can go. A teacher who teaches two subjects may have sat a
// Section B paper for each, so Section B can hold a second and third paper.
const PLACES = [
  { value: 'A', label: 'Section A' },
  { value: 'B', label: 'Section B' },
  { value: 'B2', label: 'Section B, paper 2' },
  { value: 'B3', label: 'Section B, paper 3' },
  { value: 'C', label: 'Section C' },
  { value: '', label: 'Not used' },
];
const placesFor = (item) => PLACES.filter((p) => p.value !== 'B3' || item.pages.some((page) => page.section === 'B2' || page.section === 'B3'));
const pageCount = (n) => `${n} page${n === 1 ? '' : 's'}`;

/* ------------------------------------------------------ PDFs to pictures */

// About 200 dots per inch across an A4 page: enough to read handwriting,
// small enough to upload a school's worth of answer papers.
const WIDTH = 1700;
const QUALITY = 0.85;

async function pdfPages(file, onPage) {
  const lib = await loadPdfjs();
  const loading = lib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: '/vendor/pdfjs/cmaps/',
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
    wasmUrl: '/vendor/pdfjs/wasm/',
    iccUrl: '/vendor/pdfjs/iccs/',
  });
  try {
    const doc = await loading.promise;
    const pages = [];
    const base = file.name.replace(/\.pdf$/i, '');
    for (let n = 1; n <= doc.numPages; n += 1) {
      onPage(n, doc.numPages);
      const page = await doc.getPage(n);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(4, WIDTH / Math.min(natural.width, natural.height)) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      await page.render({ canvas, viewport, intent: 'print', background: '#fff' }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();
      if (!blob) throw new Error(`Page ${n} could not be made into a picture.`);
      pages.push(new File([blob], `${base} - p${n}.jpg`, { type: 'image/jpeg' }));
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}

/* ------------------------------------------------------------- the page */

export async function renderBulk(root, query = new URLSearchParams()) {
  const schools = await schoolsApi.list();
  const schoolId = query.get('school') ?? String(schools[0]?.id ?? '');
  const school = schools.find((s) => String(s.id) === schoolId);
  if (!school) {
    window.navigate('/assessments');
    return;
  }
  const tests = await testsApi.list(school.id);
  const test = tests.find((t) => String(t.id) === query.get('test')) ?? tests[0];
  const [teachers, library] = await Promise.all([teachersApi.list({ school_id: school.id }), papersApi.list()]);

  const state = { items: [], uploads: [], filed: null, marks: null, busy: false };
  const boardLink = `#/assessments?school=${school.id}&test=${test.id}`;

  const uploadBox = h('div', {});
  const reviewBox = h('div', {});
  const cards = new Map(); // item id → { key, el }

  /* -------------------------------------------------------- uploading */

  const fileInput = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, style: 'display:none' });
  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length) uploadAll(files);
  });

  async function uploadAll(files) {
    const pdfs = files.filter((f) => /\.pdf$/i.test(f.name) || f.type === 'application/pdf');
    if (pdfs.length < files.length) toast('Only PDFs are taken here. Other files were left out.', 'error');
    const rows = pdfs.map((file) => ({ name: file.name, text: 'Waiting…', state: 'waiting' }));
    state.uploads.push(...rows);
    drawUploads();
    drawReview();
    // One PDF at a time, so a long upload never holds every page in memory.
    for (const [i, file] of pdfs.entries()) {
      const row = rows[i];
      try {
        row.state = 'working';
        const pages = await pdfPages(file, (n, of) => {
          row.text = `Reading page ${n} of ${of}…`;
          drawUploads();
        });
        row.text = `Uploading ${pageCount(pages.length)}…`;
        drawUploads();
        const data = new FormData();
        data.set('school_id', school.id);
        data.set('test_id', test.id);
        data.set('file_name', file.name);
        for (const page of pages) data.append('pages', page);
        await addWithRetries(data, file.name, row);
        row.state = 'done';
        row.text = `Uploaded ${pageCount(pages.length)}.`;
        await refresh();
      } catch (error) {
        row.state = 'failed';
        row.text = /password|encrypt/i.test(error.message)
          ? 'This PDF is password protected. Save it without the password and upload it again.'
          : `Not uploaded: ${error.message}`;
      }
      drawUploads();
    }
    drawReview();
  }

  const uploading = () => state.uploads.some((row) => ['waiting', 'working'].includes(row.state));

  // The server can drop a request while it restarts (Fly answers 502), so a
  // PDF is sent again a few times before it counts as not uploaded. A PDF the
  // server did take before the answer was lost is not sent twice.
  const RETRY_WAITS = [3000, 8000, 15000, 30000];
  const serverDropped = (error) => error instanceof TypeError || [502, 503, 504].includes(error.status);

  async function addWithRetries(data, fileName, row) {
    const before = new Set(state.items.map((item) => item.id));
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await bulkApi.add(data);
      } catch (error) {
        if (!serverDropped(error) || attempt >= RETRY_WAITS.length) throw error;
        row.text = 'The server did not answer. Trying again…';
        drawUploads();
        await new Promise((resolve) => setTimeout(resolve, RETRY_WAITS[attempt]));
        const taken = await bulkApi
          .list(school.id, test.id)
          .then((listed) => listed.items.find((item) => !before.has(item.id) && item.file_name === fileName))
          .catch(() => null);
        if (taken) return taken;
      }
    }
  }

  function drawUploads() {
    const dropzone = h(
      'div',
      { class: 'dropzone bulk-drop' },
      h('p', { style: 'margin:0 0 10px' }, h('strong', {}, 'Drop the answer paper PDFs here'), ', or'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => fileInput.click() }, 'Upload files'),
      h('p', { class: 'hint', style: 'margin:10px 0 0' }, 'One PDF for each teacher, with all their answer sheets in it. Naming each file after the teacher, such as “Keshava.pdf”, helps; without that, the name written on the sheets is used.'),
      fileInput
    );
    dropzone.addEventListener('dragover', (event) => {
      event.preventDefault();
      dropzone.classList.add('dragover');
    });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) uploadAll(files);
    });

    const shown = state.uploads.filter((row) => row.state !== 'done' || state.uploads.some((r) => r.state !== 'done'));
    mount(
      uploadBox,
      h(
        'div',
        { class: 'card' },
        h('h2', {}, '1. Upload the answer papers'),
        h('p', { class: 'hint' }, `For ${test.name} at ${school.name}. Upload every PDF first: nothing is matched while they upload. Nothing is filed until you check it below, and nothing is marked until you press Evaluate.`),
        dropzone,
        shown.length
          ? h('ul', { class: 'bulk-progress' }, shown.map((row) => h('li', { class: row.state }, h('strong', {}, row.name), ' ', h('span', {}, row.text))))
          : null
      )
    );
  }

  /* ---------------------------------------------------------- reviewing */

  async function refresh() {
    const data = await bulkApi.list(school.id, test.id);
    state.items = data.items;
    drawReview();
    schedulePoll();
  }

  let pollTimer = null;
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!state.items.some((item) => ['waiting', 'running'].includes(item.sort_status))) return;
    pollTimer = setTimeout(() => {
      if (!root.isConnected || !reviewBox.isConnected) return;
      refresh().catch(() => schedulePoll());
    }, 4000);
  }

  const replaceItem = (item) => {
    state.items = state.items.map((i) => (i.id === item.id ? item : i));
    drawReview();
    schedulePoll();
  };

  const change = async (item, body) => {
    try {
      replaceItem(await bulkApi.update(item.id, body));
      // Other PDFs' notes (such as two PDFs for one teacher) can change too.
      if ('teacher_id' in body) await refresh();
    } catch (error) {
      toast(error.message, 'error');
      drawReview();
    }
  };

  async function fileAll() {
    const ready = state.items.filter((item) => item.ready);
    if (!ready.length) return;
    const waiting = state.items.length - ready.length;
    if (
      waiting &&
      !confirmAction(`${ready.length} of ${state.items.length} answer papers are ready and will be filed now. The other ${waiting} stay here until they are ready.`)
    ) {
      return;
    }
    state.busy = true;
    drawReview();
    try {
      const result = await bulkApi.file(school.id, test.id, ready.map((item) => item.id));
      state.filed = [...(state.filed ?? []), ...result.filed];
      toast(`Filed ${result.filed.length} section answer paper${result.filed.length === 1 ? '' : 's'}.`, 'success');
      if (result.left.length) toast(`${result.left.length} PDF${result.left.length === 1 ? ' was' : 's were'} not ready and stay${result.left.length === 1 ? 's' : ''} here.`, 'error');
    } catch (error) {
      toast(error.message, 'error');
    }
    state.busy = false;
    await refresh();
  }

  // "Find the question papers": every PDF not matched yet is matched at once.
  async function matchAll() {
    state.busy = true;
    drawReview();
    try {
      const result = await bulkApi.match(school.id, test.id);
      state.items = result.items;
    } catch (error) {
      toast(error.message, 'error');
    }
    state.busy = false;
    drawReview();
    schedulePoll();
  }

  function matchCard() {
    const unmatched = state.items.filter((item) => ['new', 'failed'].includes(item.sort_status)).length;
    const matching = state.items.filter((item) => ['waiting', 'running'].includes(item.sort_status)).length;
    const waitForUploads = uploading();
    return h(
      'div',
      { class: 'card' },
      h('h2', {}, '2. Find the question papers'),
      matching
        ? h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), `Matching ${matching} PDF${matching === 1 ? '' : 's'} at once. You can leave this page; matching carries on.`)
        : null,
      unmatched
        ? [
            h('p', { class: 'hint' }, waitForUploads
              ? 'Wait until every PDF has uploaded, then match them all at once.'
              : 'Every PDF is matched at the same time: its teacher, which pages answer which section, and the question paper for each section.'),
            h(
              'button',
              { class: 'btn btn-primary', type: 'button', disabled: waitForUploads || state.busy, onclick: matchAll },
              waitForUploads
                ? 'Find the question papers'
                : unmatched === state.items.length
                  ? `Find the question papers for all ${unmatched}`
                  : `Find the question papers for the ${unmatched} not matched yet`
            ),
          ]
        : matching
          ? null
          : h('p', { class: 'hint', style: 'margin:0' }, `All ${state.items.length} PDF${state.items.length === 1 ? ' is' : 's are'} matched. Check a few below, then file them.`)
    );
  }

  // Evaluate, pressed once for every section just filed, or once more for
  // the ones whose marking failed (`failedOnly`).
  async function evaluateAll(failedOnly = false) {
    const filed = state.filed.map((row) => row.assessment_id);
    const ids = failedOnly ? filed.filter((id) => state.marks?.get(id)?.state === 'failed') : filed;
    if (!ids.length) return;
    const marking = await chooseMarking({
      title: failedOnly ? `Evaluate the ${ids.length === 1 ? 'section' : `${ids.length} sections`} that failed again` : `Evaluate all ${ids.length} sections just filed`,
    });
    if (!marking) return;
    try {
      const started = (await bulkApi.evaluate(ids, marking)).map((m) => [m.id, m]);
      state.marks = new Map([...(state.marks ?? []), ...started]);
    } catch (error) {
      toast(error.message, 'error');
      return;
    }
    drawReview();
    const follow = async () => {
      if (!reviewBox.isConnected) return;
      try {
        state.marks = new Map((await bulkApi.marking(filed)).map((m) => [m.id, m]));
        drawReview();
      } catch {
        // tried again below
      }
      if ([...state.marks.values()].some((m) => ['queued', 'running'].includes(m.state))) setTimeout(follow, 5000);
    };
    setTimeout(follow, 3000);
  }

  function drawReview() {
    const ready = state.items.filter((item) => item.ready).length;
    const sorting = state.items.filter((item) => ['waiting', 'running'].includes(item.sort_status)).length;
    const unmatched = state.items.filter((item) => item.sort_status === 'new').length;
    const need = state.items.length - ready - sorting - unmatched;
    const fileButton = h(
      'button',
      { class: 'btn btn-primary', type: 'button', disabled: !ready || state.busy, onclick: fileAll },
      state.busy ? 'Filing…' : ready ? `File ${ready} checked answer paper${ready === 1 ? '' : 's'}` : 'Nothing ready to file'
    );

    // Only cards whose PDF changed are drawn again, so a choice being made on
    // one is not lost when another finishes sorting.
    const seen = new Set();
    const list = state.items.map((item) => {
      seen.add(item.id);
      const key = JSON.stringify(item);
      const cached = cards.get(item.id);
      if (cached && cached.key === key) return cached.el;
      const el = itemCard(item);
      cards.set(item.id, { key, el });
      return el;
    });
    for (const id of cards.keys()) if (!seen.has(id)) cards.delete(id);

    mount(
      reviewBox,
      state.items.length ? matchCard() : null,
      state.filed?.length ? filedCard(state.filed, boardLink, state.marks, evaluateAll) : null,
      h(
        'div',
        { class: 'card' },
        h(
          'div',
          { class: 'card-head-row' },
          h(
            'div',
            {},
            h('h2', {}, '3. Check and file'),
            h(
              'p',
              { class: 'hint', style: 'margin:0' },
              state.items.length
                ? [
                    `${state.items.length} PDF${state.items.length === 1 ? '' : 's'}`,
                    ready ? `${ready} ready` : '',
                    sorting ? `${sorting} being matched` : '',
                    unmatched ? `${unmatched} not matched yet` : '',
                    need ? `${need} need${need === 1 ? 's' : ''} you` : '',
                  ].filter(Boolean).join(' · ')
                : 'Answer papers you upload appear here.'
            )
          ),
          state.items.length ? fileButton : null
        ),
        state.items.length
          ? h('p', { class: 'hint bulk-explain' }, 'For each PDF, check the teacher, which pages answer which section, and the question paper for each section. Preview shows a section’s question paper beside the teacher’s answers. A section with no pages was not sat. Pages left as “Not used” are not filed.')
          : null
      ),
      list
    );
  }

  function itemCard(item) {
    const sorting = ['waiting', 'running'].includes(item.sort_status);
    const unmatched = item.sort_status === 'new';
    const status = sorting
      ? h('span', { class: 'badge running' }, item.sort_status === 'waiting' ? 'Waiting to be matched' : 'Matching…')
      : unmatched
        ? h('span', { class: 'badge draft' }, 'Not matched yet')
        : item.ready
          ? h('span', { class: 'badge evaluated' }, 'Ready to file')
          : h('span', { class: 'badge scanned' }, 'Needs you');

    const teacherSelect = select(
      'teacher',
      [{ value: '', label: 'Choose the teacher' }, ...teachers.map((t) => ({ value: String(t.id), label: `${t.name}${t.grade ? ` · ${t.grade}` : ''}${t.subjects ? ` · ${t.subjects}` : ''}` }))],
      { value: item.teacher ? String(item.teacher.id) : '', id: `bulk-teacher-${item.id}` }
    );
    teacherSelect.addEventListener('change', () => change(item, { teacher_id: Number(teacherSelect.value) || null }));
    const how = {
      file: 'Matched from the file name.',
      sheet: `Matched from the name written on the sheets${item.name_written ? `: “${item.name_written}”` : ''}.`,
      you: 'Chosen by you.',
    }[item.matched_by] ?? (item.name_written ? `Name on the sheets: “${item.name_written}”.` : '');

    const languages = item.languages.length
      ? `Written in ${item.languages.join(' and ')}.${item.read_by_gemini ? ` Gemini read ${pageCount(item.read_by_gemini)} not in English.` : ''}`
      : '';

    return h(
      'div',
      { class: `card bulk-item${item.ready ? ' ready' : ''}` },
      h(
        'div',
        { class: 'card-head-row' },
        h('div', { class: 'bulk-file' }, h('strong', {}, item.file_name), h('span', { class: 'hint' }, pageCount(item.pages.length)), status),
        h(
          'div',
          { class: 'page-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', disabled: !item.pages.some((p) => p.section), onclick: () => preview(item) }, 'Preview'),
          sorting
            ? null
            : h('button', { class: 'btn btn-sm', type: 'button', title: 'Find this PDF’s teacher, sections and question papers', onclick: async () => {
                try {
                  replaceItem(await bulkApi.sort(item.id));
                } catch (error) {
                  toast(error.message, 'error');
                }
              } }, unmatched ? 'Match' : 'Match again'),
          h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: async () => {
            if (!confirmAction(`Remove ${item.file_name}? Its pages are deleted and nothing is filed.`)) return;
            try {
              await bulkApi.remove(item.id);
              await refresh();
            } catch (error) {
              toast(error.message, 'error');
            }
          } }, 'Remove')
        )
      ),
      item.sort_error ? h('p', { class: 'notice' }, item.sort_error) : null,
      h(
        'div',
        { class: 'bulk-teacher' },
        h('label', { for: teacherSelect.id }, 'Teacher'),
        teacherSelect,
        h('small', { class: 'hint' }, [how, languages].filter(Boolean).join(' '))
      ),
      h('div', { class: 'bulk-sections' }, item.sections.map((section) => sectionBox(item, section, sorting))),
      pagesStrip(item),
      item.problems.length || item.notes.length
        ? h(
            'ul',
            { class: 'bulk-notes' },
            item.problems.map((text) => h('li', { class: 'problem' }, text)),
            item.notes.map((text) => h('li', {}, text))
          )
        : null
    );
  }

  function sectionBox(item, section, sorting) {
    const { key, label } = section;
    const pages = item.pages.filter((p) => p.section === key);
    const questions = [...new Set(pages.flatMap((p) => (p.questions ? p.questions.split(', ') : [])))];
    const options = library.papers.filter((p) => p.sections.includes(section.section));
    const paperSelect = h(
      'select',
      { 'aria-label': `${label} question paper`, disabled: !pages.length },
      h('option', { value: '' }, pages.length ? 'Choose the question paper' : 'Not sat'),
      options.map((p) => h('option', { value: String(p.id) }, p.title))
    );
    paperSelect.value = section.paper ? String(section.paper.id) : '';
    paperSelect.addEventListener('change', () => change(item, { papers: { [key]: Number(paperSelect.value) || null } }));
    const confidence = { high: 'Clear match', medium: 'Likely match', low: 'Unsure: check it' }[section.confidence];

    return h(
      'div',
      { class: `bulk-section${pages.length ? '' : ' not-sat'}` },
      h(
        'div',
        { class: 'bulk-section-head' },
        h('strong', {}, label),
        pages.length && confidence ? h('span', { class: `badge confidence-${section.confidence}` }, confidence) : null
      ),
      h(
        'div',
        { class: 'hint' },
        pages.length
          ? `${pageCount(pages.length)}${questions.length ? ` · answers ${questions.slice(0, 8).join(', ')}${questions.length > 8 ? '…' : ''}` : ''}`
          : item.sort_status === 'new' ? 'Not matched yet' : sorting ? 'Matching…' : 'No pages: not sat'
      ),
      paperSelect,
      section.paper && pages.length ? h('small', { class: 'hint' }, paperFacts(section.paper)) : null,
      section.reason && pages.length ? h('small', { class: 'bulk-reason' }, section.reason) : null,
      pages.length && section.paper
        ? h('button', { class: 'btn-link', type: 'button', onclick: () => preview(item, key) }, `Preview ${label}`)
        : null
    );
  }

  function pagesStrip(item) {
    return h(
      'div',
      { class: 'bulk-pages' },
      item.pages.map((page, i) => {
        const pick = select(
          `page-${page.id}`,
          placesFor(item),
          { value: page.section ?? '', id: `bulk-page-${page.id}` }
        );
        pick.addEventListener('change', () => change(item, { pages: [{ id: page.id, section: pick.value || null }] }));
        return h(
          'div',
          { class: `bulk-page section-${page.section ?? 'none'}` },
          h('img', {
            src: page.src,
            alt: `Page ${i + 1}`,
            loading: 'lazy',
            title: 'Click to see the page large',
            onclick: () => viewPages({ title: `${item.file_name}`, pages: item.pages.map((p, n) => ({ src: p.src, name: `Page ${n + 1}` })), start: i }),
          }),
          h('div', { class: 'bulk-page-foot' }, h('span', {}, `Page ${i + 1}${page.language && page.language !== 'english' ? ` · ${page.language === 'mixed' ? 'mixed language' : 'not English'}` : ''}`), page.questions ? h('span', { class: 'hint', title: page.questions }, page.questions) : null),
          pick
        );
      })
    );
  }

  /* ------------------------------------------------------------ preview */

  // A section's question paper beside the teacher's answers to it. Pages can
  // be moved to another section from here.
  function preview(item, start) {
    const narrow = window.matchMedia('(max-width: 860px)').matches;
    let current = start ?? item.sections.find((s) => s.pages)?.key ?? 'A';
    let shown = item;
    const tabs = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Section' });
    const body = h('div', { class: 'bulk-preview-body' });

    const close = () => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close();
    };

    // The question paper drawn page by page, as the reports do, so it shows
    // in every browser, phones included.
    function paperPages(paper) {
      const box = h('div', { class: 'bulk-preview-scroll' }, h('div', { class: 'marking-state' }, h('span', { class: 'spinner' }), 'Opening the question paper…'));
      pagesOf({ url: `/uploads/${paper.stored_name}`, pdf: true }).then(
        (pages) => mount(box, pages.map((src, i) => h('img', { src, alt: `${paper.title}, page ${i + 1}` })), h('a', { class: 'btn-link', href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener' }, 'Open the PDF in a new tab')),
        () => mount(box, h('p', { class: 'hint' }, 'The question paper could not be shown here. '), h('a', { href: `/uploads/${paper.stored_name}`, target: '_blank', rel: 'noopener' }, 'Open it in a new tab'))
      );
      return box;
    }

    function draw() {
      mount(
        tabs,
        shown.sections.map(({ key, label }) => {
          const count = shown.pages.filter((p) => p.section === key).length;
          return h(
            'button',
            { type: 'button', class: key === current ? 'active' : '', 'aria-pressed': String(key === current), onclick: () => { current = key; draw(); } },
            `${label}${count ? ` (${count})` : ' · not sat'}`
          );
        })
      );
      const section = shown.sections.find((s) => s.key === current) ?? shown.sections[0];
      const pages = shown.pages.filter((p) => p.section === section.key);
      mount(
        body,
        h(
          'div',
          { class: 'bulk-preview-paper' },
          section.paper
            ? [
                h('div', { class: 'hint' }, h('strong', {}, section.paper.title), ` · ${paperFacts(section.paper)}`),
                paperPages(section.paper),
              ]
            : h('div', { class: 'picker-empty' }, pages.length ? `Choose the ${section.label} question paper on the PDF’s card.` : `No pages answer ${section.label}, so it was not sat.`)
        ),
        h(
          'div',
          { class: 'bulk-preview-answers' },
          pages.length
            ? pages.map((page) => {
                const n = shown.pages.indexOf(page) + 1;
                const pick = select(
                  `preview-page-${page.id}`,
                  placesFor(shown),
                  { value: page.section ?? '', id: `preview-page-${page.id}` }
                );
                pick.addEventListener('change', async () => {
                  try {
                    shown = await bulkApi.update(item.id, { pages: [{ id: page.id, section: pick.value || null }] });
                    replaceItem(shown);
                    draw();
                  } catch (error) {
                    toast(error.message, 'error');
                  }
                });
                return h(
                  'figure',
                  { class: 'bulk-preview-page' },
                  h('figcaption', {}, h('span', {}, `Page ${n}${page.questions ? ` · answers ${page.questions}` : ''}`), h('label', { class: 'inline' }, 'Move to ', pick)),
                  h('img', { src: page.src, alt: `Answer page ${n}` })
                );
              })
            : h('div', { class: 'picker-empty' }, 'No answer pages in this section.')
        )
      );
    }

    const overlay = h(
      'div',
      { class: 'modal-backdrop', onclick: (event) => { if (event.target === overlay) close(); } },
      h(
        'div',
        { class: 'modal bulk-preview', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Question paper and answers' },
        h(
          'div',
          { class: 'modal-head' },
          h('div', {}, h('h2', {}, `${item.teacher?.name ?? item.file_name}: question paper and answers`), h('p', { class: 'hint' }, `The question paper is ${narrow ? 'first, the teacher’s answers to it below' : 'on the left, the teacher’s answers to it on the right'}. Move a page that belongs to another section with its “Move to” list.`)),
          h('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: close }, '×')
        ),
        h('div', { class: 'bulk-preview-tabs' }, tabs),
        body
      )
    );
    draw();
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
  }

  /* --------------------------------------------------------------- page */

  mount(
    root,
    h(
      'div',
      { class: 'page-head' },
      h(
        'div',
        {},
        h('div', { class: 'breadcrumb' }, h('a', { href: boardLink }, '← Assessments')),
        h('h1', {}, 'Upload all answer papers'),
        h('p', {}, `${school.name} · ${test.name}. Upload every teacher’s scanned answer paper as PDFs in one go. Each is matched to its teacher, and its pages to the sections and question papers they answer.`)
      )
    ),
    uploadBox,
    reviewBox
  );
  drawUploads();
  await refresh();
}

// What was filed, with a link to each sitting, and Evaluate for all of them
// at once: one Standard or Lenient choice, then each sitting is marked as if
// its own Evaluate had been pressed. `marks` holds how far that has got.
function filedCard(filed, boardLink, marks, evaluateAll) {
  const byTeacher = new Map();
  for (const row of filed) {
    if (!byTeacher.has(row.teacher.id)) byTeacher.set(row.teacher.id, { name: row.teacher.name, rows: [] });
    byTeacher.get(row.teacher.id).rows.push(row);
  }
  const stateOf = (id) => marks?.get(id);
  const label = { queued: 'waiting', running: 'marking…', done: 'marked', failed: 'failed' };
  const done = filed.filter((row) => stateOf(row.assessment_id)?.state === 'done').length;
  const failed = filed.filter((row) => stateOf(row.assessment_id)?.state === 'failed').length;
  const going = marks && done + failed < filed.length;
  return h(
    'div',
    { class: 'card bulk-filed' },
    h('h2', {}, `Filed for ${byTeacher.size} teacher${byTeacher.size === 1 ? '' : 's'}`),
    h(
      'p',
      { class: 'hint' },
      marks
        ? `Marked ${done} of ${filed.length}${failed ? `, ${failed} failed (open one to see why)` : ''}.${going ? ' You can leave this page; marking carries on.' : ''}`
        : 'Nothing has been marked yet. Evaluate all marks every section below, or open one section to Evaluate it on its own. On the Assessments board they are under Papers: Section A, B or C.'
    ),
    h(
      'ul',
      { class: 'bulk-filed-list' },
      [...byTeacher.values()].map((teacher) =>
        h(
          'li',
          {},
          h('strong', {}, teacher.name),
          ': ',
          teacher.rows.map((row, i) => {
            const mark = stateOf(row.assessment_id);
            return [
              i ? ', ' : '',
              h('a', { href: `#/assessments/${row.assessment_id}` }, `Section ${row.section}${row.subject && row.section === 'B' ? ` (${row.subject})` : ''}`),
              ` (${pageCount(row.pages)}${mark && label[mark.state] ? `, ${label[mark.state]}` : ''})`,
            ];
          })
        )
      )
    ),
    h(
      'div',
      { class: 'form-actions', style: 'margin-top:0' },
      marks ? null : h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => evaluateAll() }, `Evaluate all ${filed.length}`),
      marks && failed && !going ? h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: () => evaluateAll(true) }, failed === 1 ? 'Evaluate the failed one again' : `Evaluate the ${failed} failed again`) : null,
      h('a', { class: 'btn btn-sm', href: boardLink }, 'Back to the Assessments board')
    )
  );
}

// Evaluate pressed once for every paper of a test whose marking failed, or for
// every one waiting for Evaluate, and why the failed ones failed. The
// dashboard and the Assessments board both offer it. The papers are marked as
// many at once as the server's memory allows, as with Evaluate all.
import { h, toast } from './ui.js';
import { bulkApi } from './api.js';
import { chooseMarking } from './marking-choice.js';

const papers = (n) => `${n} paper${n === 1 ? '' : 's'}`;

// `which` is 'failed' or 'waiting'; `count` is how many papers that is, and
// `after` runs once their marking has started.
export function evaluateAllButton({ schoolId, testId, which, count, after }) {
  const again = which === 'failed';
  const button = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, again ? 'Evaluate all again' : 'Evaluate all');
  button.addEventListener('click', async () => {
    const them = count === 1 ? 'the paper' : `the ${papers(count)}`;
    const marking = await chooseMarking({ title: again ? `Evaluate ${them} that failed again` : `Evaluate ${them} waiting` });
    if (!marking) return;
    button.disabled = true;
    try {
      const { started } = await bulkApi.evaluateUnmarked(schoolId, testId, which, marking);
      toast(started ? `Marking ${papers(started)} at once.` : 'There was nothing left to evaluate.', 'success');
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      return;
    }
    after?.();
  });
  return button;
}

// Why each paper's marking failed: each reason once, with the papers it
// stopped, each opening the paper. `open` and `onToggle` keep it open when the
// page is drawn again.
export function failedReasons(failed, { open = false, onToggle } = {}) {
  const byReason = new Map();
  for (const sitting of failed) {
    if (!byReason.has(sitting.error)) byReason.set(sitting.error, []);
    byReason.get(sitting.error).push(sitting);
  }
  const details = h(
    'details',
    { class: 'failed-reasons' },
    h('summary', {}, failed.length === 1 ? 'Why it failed' : 'Why they failed'),
    h(
      'ul',
      {},
      [...byReason].map(([reason, sittings]) =>
        h(
          'li',
          {},
          h('div', {}, reason),
          h(
            'div',
            { class: 'hint' },
            sittings.map((sitting, i) => [i ? ', ' : '', h('a', { href: `#/assessments/${sitting.id}` }, `${sitting.teacher.name} (${sitting.paper})`)])
          )
        )
      )
    )
  );
  details.open = open;
  details.addEventListener('toggle', () => onToggle?.(details.open));
  return details;
}

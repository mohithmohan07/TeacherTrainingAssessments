// How Evaluate counts the marks: Standard, where every question counts, or
// Lenient, where the questions the teacher did not attempt are left out of
// both the marks and the total. OpenAI marks the answers the same way either
// way. The dialog asks each time Evaluate is pressed and starts on the last
// choice made on this computer.
import { h } from './ui.js';

export const MARKINGS = [
  {
    key: 'standard',
    label: 'Standard',
    meaning: 'Every question counts. A question left blank gets 0 and stays in the total.',
  },
  {
    key: 'lenient',
    label: 'Lenient',
    meaning: 'Only the questions answered count. Questions left blank are not in the marks or the total, so the score covers only what the teacher answered.',
  },
];

const LAST_CHOICE = 'evaluate-marking';

function lastChoice() {
  try {
    return localStorage.getItem(LAST_CHOICE);
  } catch {
    return null;
  }
}

function remember(choice) {
  try {
    localStorage.setItem(LAST_CHOICE, choice);
  } catch {
    // Not remembered in a private window; the dialog starts on Standard.
  }
}

// Opens the dialog. `current` is how the sitting was last marked, if it was;
// `again` warns that the new marks replace the current ones. Resolves with
// 'standard' or 'lenient', or null if cancelled.
export function chooseMarking({ teacherName = '', current = null, again = false } = {}) {
  return new Promise((resolve) => {
    let choice = [current, lastChoice()].find((key) => MARKINGS.some((m) => m.key === key)) ?? 'standard';

    const close = (value) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') close(null);
    };

    const options = MARKINGS.map((m) => {
      const radio = h('input', { type: 'radio', name: 'marking', value: m.key });
      radio.checked = m.key === choice;
      const option = h('label', { class: `marking-option${m.key === choice ? ' active' : ''}` }, radio, h('span', {}, h('strong', {}, m.label), h('span', { class: 'hint' }, m.meaning)));
      radio.addEventListener('change', () => {
        choice = m.key;
        for (const el of options) el.classList.toggle('active', el === option);
      });
      return option;
    });

    const evaluate = h('button', { class: 'btn btn-primary', type: 'button' }, again ? 'Evaluate again' : 'Evaluate');
    evaluate.addEventListener('click', () => {
      remember(choice);
      close(choice);
    });

    const overlay = h(
      'div',
      { class: 'modal-backdrop', onclick: (event) => { if (event.target === overlay) close(null); } },
      h(
        'div',
        { class: 'modal marking-choice', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'How to count the marks' },
        h(
          'div',
          { class: 'modal-head' },
          h(
            'div',
            {},
            h('h2', {}, teacherName ? `Evaluate ${teacherName}’s paper` : 'Evaluate this paper'),
            h('p', { class: 'hint' }, 'OpenAI marks every answer the same way. Choose how the marks are counted.')
          ),
          h('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: () => close(null) }, '×')
        ),
        h(
          'div',
          { class: 'marking-options' },
          options,
          again ? h('p', { class: 'notice' }, 'The new marks replace the current ones, including any you corrected.') : null
        ),
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn', type: 'button', onclick: () => close(null) }, 'Cancel'), evaluate)
      )
    );

    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    evaluate.focus();
  });
}

// The charts in the reports, drawn in plain HTML and SVG so they print as
// they look on screen. Every chart carries its numbers as text too, so no
// figure rests on colour alone, and each part names itself on hover.
import { h } from './ui.js';

const SVG = 'http://www.w3.org/2000/svg';

function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined && value !== false) el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

// The grade bands from the lowest up, each with the share of 0–100 it covers.
function zones(grades) {
  const bands = [...grades].sort((a, b) => a.min - b.min);
  return bands.map((band, i) => ({ ...band, width: (bands[i + 1]?.min ?? 100) - band.min }));
}

// A score as a bar on a track tinted by grade band, with the percentage
// beside it: where the bar ends shows the grade at a glance.
export function scoreBar(percent, grades, { label } = {}) {
  if (percent === null || percent === undefined) return h('span', { class: 'hint' }, '—');
  const value = Math.max(0, Math.min(100, Number(percent)));
  const band = [...grades].sort((a, b) => b.min - a.min).find((g) => value >= g.min);
  return h(
    'div',
    { class: 'score-bar', title: `${label ? `${label}: ` : ''}${percent}%${band ? `, Grade ${band.grade} (${band.label})` : ''}` },
    h(
      'div',
      { class: 'score-track', 'aria-hidden': 'true' },
      zones(grades).map((z) => h('span', { class: `zone zone-${z.grade}`, style: `width:${z.width}%` })),
      h('span', { class: 'score-fill', style: `width:${value}%` })
    ),
    h('span', { class: 'score-value' }, `${percent}%`)
  );
}

// A ring cut into slices, with the total in the middle. Slices are
// [{ key, label, value }], coloured by their key in the stylesheet, and a
// 2px gap keeps neighbours apart.
export function donut(slices, { size = 150, total, caption = 'teachers' } = {}) {
  const sum = slices.reduce((a, s) => a + s.value, 0);
  const stroke = size * 0.17;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const shown = slices.filter((s) => s.value > 0);
  const gap = shown.length > 1 ? 2 : 0;
  let offset = 0;
  return svg(
    'svg',
    { class: 'donut', width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': slices.map((s) => `${s.label}: ${s.value}`).join(', ') },
    shown.length ? null : svg('circle', { cx: size / 2, cy: size / 2, r, class: 'donut-track', 'stroke-width': stroke, fill: 'none' }),
    shown.map((s) => {
      const length = (s.value / sum) * c;
      const arc = svg(
        'circle',
        {
          cx: size / 2,
          cy: size / 2,
          r,
          fill: 'none',
          class: `donut-slice slice-${s.key}`,
          'stroke-width': stroke,
          'stroke-dasharray': `${Math.max(0, length - gap)} ${c - Math.max(0, length - gap)}`,
          'stroke-dashoffset': -offset,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        },
        svg('title', {}, `${s.label}: ${s.value} of ${sum}`)
      );
      offset += length;
      return arc;
    }),
    svg('text', { x: '50%', y: '47%', 'text-anchor': 'middle', class: 'donut-total' }, total ?? sum),
    svg('text', { x: '50%', y: '62%', 'text-anchor': 'middle', class: 'donut-caption' }, caption)
  );
}

// Counts as one bar split into coloured parts, each part showing its count.
// `parts` are [{ key, label, value }]; every part with a count stays wide
// enough for its number.
export function stackedBar(parts, { label } = {}) {
  const sum = parts.reduce((a, p) => a + p.value, 0);
  if (!sum) return h('span', { class: 'hint' }, 'No results');
  return h(
    'div',
    { class: 'stack-bar', role: 'img', 'aria-label': `${label ? `${label}: ` : ''}${parts.map((p) => `${p.label} ${p.value}`).join(', ')}` },
    parts
      .filter((p) => p.value > 0)
      .map((p) => h('span', { class: `stack-part fill-${p.key}`, style: `flex-grow:${p.value}`, title: `${label ? `${label}, ` : ''}${p.label}: ${p.value} of ${sum}` }, p.value))
  );
}

// The key under a chart: a swatch and a name for each colour.
export function legend(items) {
  return h('div', { class: 'chart-legend' }, items.map((item) => h('span', {}, h('i', { class: `fill-${item.key}` }), item.label)));
}

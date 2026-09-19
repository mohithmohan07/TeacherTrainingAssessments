import { renderDashboard } from './views/dashboard.js';
import { renderSchools, renderSchoolDetail } from './views/schools.js';
import { renderAssessments, renderAssessmentDetail } from './views/assessments.js';
import { toast } from './ui.js';

const view = document.getElementById('view');

const routes = [
  { pattern: /^\/dashboard$/, nav: 'dashboard', render: () => renderDashboard(view) },
  { pattern: /^\/schools$/, nav: 'schools', render: () => renderSchools(view) },
  { pattern: /^\/schools\/(\d+)$/, nav: 'schools', render: (id) => renderSchoolDetail(view, id) },
  { pattern: /^\/assessments(?:\?(.*))?$/, nav: 'assessments', render: (query) => renderAssessments(view, new URLSearchParams(query ?? '')) },
  { pattern: /^\/assessments\/(\d+)$/, nav: 'assessments', render: (id) => renderAssessmentDetail(view, id) },
];

function currentPath() {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/dashboard';
}

function setActiveNav(name) {
  for (const link of document.querySelectorAll('#nav a')) {
    link.classList.toggle('active', link.dataset.route === name);
  }
}

async function router() {
  const path = currentPath();
  const match = routes
    .map((route) => ({ route, result: route.pattern.exec(path) }))
    .find((entry) => entry.result);

  if (!match) {
    window.location.hash = '#/dashboard';
    return;
  }

  setActiveNav(match.route.nav);
  view.replaceChildren();
  view.append(Object.assign(document.createElement('p'), { className: 'loading', textContent: 'Loading…' }));

  try {
    await match.route.render(...match.result.slice(1));
  } catch (error) {
    console.error(error);
    view.replaceChildren();
    view.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: error.message }));
    toast(error.message, 'error');
  }
}

// `navigate` lets views move around without knowing about the hash format.
window.navigate = (path) => {
  window.location.hash = `#${path}`;
};

window.addEventListener('hashchange', router);
router(); // module scripts run after the document is parsed

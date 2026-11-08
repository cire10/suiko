// @ts-check
// Suiko reviewer UI entry point (no build step: Preact + htm via the import map in index.html).
// Boot order: move the ?k= token into sessionStorage, apply the saved theme and side panel width, track the narrow
// (< 900 px), medium (900-1199 px) and roomy (>= 1600 px: room for the outline rail beside the doc) layouts, install
// the keyboard map, render the app, then load the route (/ = all docs, /d/:ws/:doc = one doc).

import { html, render } from 'preact-htm';
import { applyRoute, applyTheme, markSeen, setPanelWidth } from './actions.js';
import { captureToken } from './api.js';
import { App } from './components/App.js';
import { installKeys } from './keys.js';
import { store } from './state.js';

captureToken();
applyTheme(store.get().theme);
setPanelWidth(store.get().panelWidth, { save: false });

const narrowQuery = matchMedia('(max-width: 899.98px)');
const mediumQuery = matchMedia('(min-width: 900px) and (max-width: 1199.98px)');
const roomyQuery = matchMedia('(min-width: 1600px)');
const syncLayout = () => {
  const narrow = narrowQuery.matches;
  const medium = mediumQuery.matches;
  const roomy = roomyQuery.matches;
  store.set(narrow ? { narrow, medium, roomy } : { narrow, medium, roomy, drawer: false, nav: false });
};
narrowQuery.addEventListener('change', syncLayout);
mediumQuery.addEventListener('change', syncLayout);
roomyQuery.addEventListener('change', syncLayout);
syncLayout();

installKeys();
window.addEventListener('popstate', applyRoute);
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, markSeen, { capture: true, passive: true });
window.addEventListener('focus', () => setTimeout(markSeen, 1500));
window.addEventListener('unhandledrejection', (ev) => console.error('suiko: unhandled rejection', ev.reason));

const root = document.getElementById('app');
if (root) {
  root.textContent = '';
  render(html`<${App} />`, root);
}
applyRoute();

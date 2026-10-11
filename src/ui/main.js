// @ts-check
// SpecReview reviewer UI entry point (no build step: Preact + htm via the import map in index.html).
// Boot order: move the ?k= token into sessionStorage, apply the saved theme, track the narrow (< 900 px) and medium
// (900-1199 px) layouts, install the keyboard map, render the app, then load the route (/ = all docs,
// /d/:ws/:doc = one doc).

import { html, render } from 'preact-htm';
import { applyRoute, applyTheme, markSeen } from './actions.js';
import { captureToken } from './api.js';
import { App } from './components/App.js';
import { installKeys } from './keys.js';
import { store } from './state.js';

captureToken();
applyTheme(store.get().theme);

const narrowQuery = matchMedia('(max-width: 899.98px)');
const mediumQuery = matchMedia('(min-width: 900px) and (max-width: 1199.98px)');
const syncLayout = () => {
  const narrow = narrowQuery.matches;
  const medium = mediumQuery.matches;
  store.set(narrow ? { narrow, medium } : { narrow, medium, drawer: false, nav: false });
};
narrowQuery.addEventListener('change', syncLayout);
mediumQuery.addEventListener('change', syncLayout);
syncLayout();

installKeys();
window.addEventListener('popstate', applyRoute);
for (const type of ['pointerdown', 'keydown']) window.addEventListener(type, markSeen, { capture: true, passive: true });
window.addEventListener('focus', () => setTimeout(markSeen, 1500));
window.addEventListener('unhandledrejection', (ev) => console.error('specreview: unhandled rejection', ev.reason));

const root = document.getElementById('app');
if (root) {
  root.textContent = '';
  render(html`<${App} />`, root);
}
applyRoute();

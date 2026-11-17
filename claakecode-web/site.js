const data = JSON.parse(document.querySelector('#feature-data').textContent);
const panels = [...document.querySelectorAll('[data-panel]')];
const links = [...document.querySelectorAll('[data-feature]')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let current = 0;
let cleanup;
const aliases = { settings: 'outils', agent: 'rlm', pourquoi: 'fonctions' };
const byHash = () => data.findIndex(item => item.id === (aliases[location.hash.slice(1)] || location.hash.slice(1)));
function select(index, updateHash = true) {
  const next = (index + data.length) % data.length;
  clearTimeout(cleanup);
  panels.forEach((panel, i) => {
    panel.classList.remove('is-entering', 'is-leaving');
    if (i !== current && i !== next) panel.hidden = true;
  });
  const previous = current;
  const direction = next > current ? 1 : -1;
  document.documentElement.style.setProperty('--direction', direction);
  if (previous !== next && !reduced.matches) {
    panels[previous].classList.add('is-leaving');
    panels[previous].setAttribute('inert', '');
  } else panels[previous].hidden = true;
  current = next;
  panels[next].hidden = false;
  panels[next].removeAttribute('inert');
  panels[next].classList.add('is-entering');
  links.forEach((link, i) => {
    if (i === next) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  document.querySelector('.current-count').textContent = `0${next + 1} / 0${data.length}`;
  if (updateHash) history.pushState(null, '', '#' + data[next].id);
  cleanup = setTimeout(() => {
    panels.forEach((panel, i) => { if (i !== current) panel.hidden = true; });
  }, reduced.matches ? 0 : 420);
}
links.forEach((link, index) => link.addEventListener('click', event => { event.preventDefault(); select(index); }));
document.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => select(current + Number(button.dataset.step))));
document.querySelector('.feature-rail').addEventListener('keydown', event => {
  const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (event.key in steps) {
    event.preventDefault();
    const focused = links.indexOf(document.activeElement);
    select((focused >= 0 ? focused : current) + steps[event.key]);
    links[current].focus();
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault(); select(event.key === 'Home' ? 0 : data.length - 1); links[current].focus();
  }
});
let restoreFocus;
function openDialog(dialog, opener) {
  restoreFocus = opener || document.activeElement;
  dialog.showModal();
}
document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => {
  const item = data[Number(button.dataset.detail)];
  const dialog = document.querySelector('#feature-dialog');
  dialog.querySelector('[data-dialog-tag]').textContent = item.name;
  dialog.querySelector('[data-dialog-title]').textContent = item.title.replace('\n', ' ');
  dialog.querySelector('[data-dialog-description]').textContent = item.detail;
  dialog.querySelector('.real-preview').hidden = item.id !== 'fonctions';
  openDialog(dialog, button);
}));
document.querySelectorAll('[data-open]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault(); openDialog(document.getElementById(link.dataset.open), link);
}));
document.querySelectorAll('dialog').forEach(dialog => {
  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) {
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  } });
  dialog.addEventListener('close', () => restoreFocus?.focus());
});
function applyHash() {
  const hash = location.hash.slice(1);
  if (hash === 'telecharger' || hash === 'faq') {
    const dialog = document.getElementById(hash === 'faq' ? 'faq-dialog' : 'download-dialog');
    if (!dialog.open) openDialog(dialog);
  } else { const index = byHash(); if (index >= 0) select(index, false); }
}
window.addEventListener('hashchange', applyHash);
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); select(0); });
document.documentElement.classList.add('js-gallery');
panels.forEach(panel => { panel.hidden = true; });
select(Math.max(0, byHash()), false);
applyHash();

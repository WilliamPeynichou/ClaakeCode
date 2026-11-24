const data = JSON.parse(document.querySelector('#feature-data').textContent);
const panels = [...document.querySelectorAll('[data-panel]')];
const links = [...document.querySelectorAll('[data-feature]')];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let current = 0;
let position = 0;
let target = 0;
let frame = null;
let lastTime = 0;
let ignoreScrollUntil = 0;
history.scrollRestoration = 'manual';
const exhibition = document.querySelector('.exhibition');
const viewport = document.querySelector('.gallery-viewport');
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const parts = panels.map(panel => ({
  info: panel.querySelector('.feature-info'),
  art: panel.querySelector('.feature-art'),
  word: panel.querySelector('.feature-word'),
}));
const aliases = { settings: 'outils', agent: 'rlm', pourquoi: 'fonctions' };
const byHash = () => data.findIndex(item => item.id === (aliases[location.hash.slice(1)] || location.hash.slice(1)));
const scrollRange = () => Math.max(0, exhibition.offsetHeight - viewport.offsetHeight);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
function renderScene() {
  const mobile = innerWidth <= 650;
  panels.forEach((panel, i) => {
    const delta = i - position;
    const visible = Math.abs(delta) < 1;
    panel.hidden = !visible;
    panel.inert = i !== current;
    panel.setAttribute('aria-hidden', String(i !== current));
    if (!visible) return;
    // Keep the scene readable near each stop; blend only between stops.
    const amount = clamp((Math.abs(delta) - .12) / .76, 0, 1);
    const eased = amount * amount * (3 - 2 * amount);
    const opacity = 1 - eased;
    const sign = Math.sign(delta);
    panel.style.zIndex = i === current ? '2' : '1';
    parts[i].info.style.opacity = opacity;
    parts[i].info.style.transform = `translate3d(0, ${sign * eased * 38}px, 0)`;
    parts[i].art.style.opacity = opacity;
    parts[i].art.style.transform = `translate3d(${sign * eased * (mobile ? 70 : 170)}px, ${eased * 24}px, ${-eased * 150}px)`;
    parts[i].word.style.opacity = opacity;
    parts[i].word.style.transform = `translate3d(${sign * eased * -65}px, ${eased * 28}px, 0)`;
  });
  viewport.style.setProperty('--progress', position / (data.length - 1));
}
function tick(time) {
  const elapsed = lastTime ? Math.min(time - lastTime, 40) : 16;
  lastTime = time;
  position += (target - position) * (1 - Math.exp(-elapsed / 105));
  if (Math.abs(target - position) < .001) position = target;
  renderScene();
  if (position !== target) frame = requestAnimationFrame(tick);
  else { frame = null; lastTime = 0; }
}
function animateTo(value) {
  target = clamp(value, 0, data.length - 1);
  if (reduced.matches) { position = target; renderScene(); return; }
  if (!frame) frame = requestAnimationFrame(tick);
}
function markCurrent(index, updateHash = true, fromScroll = false) {
  current = index;
  links.forEach((link, i) => {
    if (i === index) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  });
  panels.forEach((panel, i) => { panel.inert = i !== index; panel.setAttribute('aria-hidden', String(i !== index)); });
  document.querySelector('.current-count').textContent = `0${index + 1} / 0${data.length}`;
  if (updateHash) {
    if (fromScroll) history.replaceState(null, '', '#' + data[index].id);
    else history.pushState(null, '', '#' + data[index].id);
  }
}
function jumpTo(index) {
  ignoreScrollUntil = performance.now() + 250;
  window.scrollTo({ top: exhibition.offsetTop + scrollRange() * index / (data.length - 1), behavior: 'instant' });
}
function select(index, updateHash = true) {
  const next = (index + data.length) % data.length;
  markCurrent(next, updateHash);
  animateTo(next);
  jumpTo(next);
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
  document.documentElement.classList.add('dialog-open');
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
  dialog.addEventListener('close', () => {
    document.documentElement.classList.remove('dialog-open');
    restoreFocus?.focus({ preventScroll: true });
  });
});
function applyHash() {
  const hash = location.hash.slice(1);
  if (hash === 'telecharger' || hash === 'faq') {
    const dialog = document.getElementById(hash === 'faq' ? 'faq-dialog' : 'download-dialog');
    if (!dialog.open) openDialog(dialog);
  } else { const index = byHash(); if (index >= 0) select(index, false); }
}
window.addEventListener('hashchange', applyHash);
window.addEventListener('scroll', () => {
  if (performance.now() < ignoreScrollUntil || document.querySelector('dialog[open]')) return;
  const range = scrollRange();
  if (!range) return;
  const value = clamp((window.scrollY - exhibition.offsetTop) / range, 0, 1) * (data.length - 1);
  const next = Math.round(value);
  if (next !== current) markCurrent(next, true, true);
  animateTo(reduced.matches ? next : value);
}, { passive: true });
window.addEventListener('resize', () => select(current, false));
reduced.addEventListener('change', () => {
  if (frame) cancelAnimationFrame(frame);
  frame = null; lastTime = 0;
  position = target = current; renderScene();
});
// Pointer light is local to the object; it does not move the text or the page.
document.querySelectorAll('.art-object').forEach(object => {
  object.addEventListener('pointermove', event => {
    if (reduced.matches || !finePointer.matches) return;
    const rect = object.getBoundingClientRect();
    object.style.setProperty('--light-x', `${clamp((event.clientX - rect.left) / rect.width, 0, 1) * 100}%`);
    object.style.setProperty('--light-y', `${clamp((event.clientY - rect.top) / rect.height, 0, 1) * 100}%`);
  });
});
document.querySelector('.brand').addEventListener('click', event => { event.preventDefault(); select(0); });
document.documentElement.classList.add('js-gallery', 'motion-gallery');
current = position = target = Math.max(0, byHash());
markCurrent(current, false);
renderScene();
jumpTo(current);
addEventListener('load', () => { jumpTo(current); renderScene(); }, { once: true });
if (!reduced.matches) {
  viewport.classList.add('scene-arrival');
  viewport.addEventListener('animationend', event => {
    if (event.animationName === 'arrival-ring') viewport.classList.remove('scene-arrival');
  });
}
applyHash();

const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
const targets = document.querySelectorAll('.reveal');
let observer;
function showAll() {
  observer?.disconnect();
  targets.forEach(target => target.classList.remove('reveal-pending'));
}
if (!motion.matches && 'IntersectionObserver' in window) {
  observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  targets.forEach(target => {
    target.classList.add('reveal-pending');
    observer.observe(target);
  });
}
motion.addEventListener('change', showAll);

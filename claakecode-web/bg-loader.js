/* Background loader - decides whether the WebGL fluid background is worth its cost.
   Skip entirely when: no #bg canvas, or the user prefers reduced motion.
   Otherwise load three.js + liquidglass asynchronously so they never block first paint.
   shortcut: reduced-motion users get the static CSS gradient (no WebGL), upgrade = draw a
   lightweight 2D-canvas fallback if the art direction ever needs motion for them. */
(function () {
  var canvas = document.getElementById('bg');
  if (!canvas) return;
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { canvas.remove(); return; }

  function load(src, cb) {
    var s = document.createElement('script');
    s.src = src; s.onload = cb;
    document.body.appendChild(s);
  }
  // Defer to idle so critical rendering wins; load three then the shader driver.
  var start = function () {
    load('/assets/vendor/three.min.js', function () { load('liquidglass.js'); });
  };
  if ('requestIdleCallback' in window) requestIdleCallback(start, { timeout: 1500 });
  else setTimeout(start, 200);
})();

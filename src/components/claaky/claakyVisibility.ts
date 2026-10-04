// One observer and one visibility listener for every Claaky, not one per character.
// CSS animations keep their phase while paused; no frame loop, timer or React render is needed.
const elements = new Map<SVGSVGElement, boolean>();
let observer: IntersectionObserver | undefined;

function update(element: SVGSVGElement, visible: boolean) {
  element.dataset.paused = String(!visible || document.hidden);
}

function visibilityChanged() {
  elements.forEach((visible, element) => update(element, visible));
}

export function observeClaaky(element: SVGSVGElement): () => void {
  if (elements.size === 0) {
    document.addEventListener("visibilitychange", visibilityChanged);
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const target = entry.target as SVGSVGElement;
          if (!elements.has(target)) continue;
          elements.set(target, entry.isIntersecting);
          update(target, entry.isIntersecting);
        }
      });
    }
  }
  elements.set(element, !observer);
  update(element, !observer);
  observer?.observe(element);
  return () => {
    observer?.unobserve(element);
    elements.delete(element);
    if (elements.size === 0) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", visibilityChanged);
    }
  };
}

import { useEffect } from "react";

// How much of the screen must disappear before we call it a keyboard rather than browser chrome.
const KEYBOARD_MIN_HEIGHT = 150;

/**
 * Marks <html data-keyboard> while an on-screen keyboard covers part of the page.
 *
 * Focus alone is not a reliable signal: a field can be focused (autoFocus, a
 * hardware keyboard) with no on-screen keyboard showing. The visual viewport
 * shrinks only when one actually opens, so watch that instead.
 */
export function useKeyboardOpenFlag() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const update = () => {
      // Pinch zoom also shrinks vv.height; multiplying by scale cancels that out.
      const hidden = window.innerHeight - vv.height * vv.scale;
      root.toggleAttribute("data-keyboard", hidden > KEYBOARD_MIN_HEIGHT);
    };
    update();
    vv.addEventListener("resize", update);
    return () => {
      vv.removeEventListener("resize", update);
      root.removeAttribute("data-keyboard");
    };
  }, []);
}

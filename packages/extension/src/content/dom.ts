import LOGO_SVG from "../../static/icons/logo.svg";

// Builds elements with textContent only (never innerHTML), so pasted or server text can't inject markup.
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  Object.assign(el, props);
  el.append(...children);
  return el;
}

// The logo is our own bundled asset, so parsing it as markup is safe.
export function logo(className: string): HTMLSpanElement {
  const span = h("span", { className });
  span.innerHTML = LOGO_SVG;
  return span;
}

// A tiny helper for building DOM elements safely (text is never parsed as HTML).
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (prop.startsWith('--')) el.style.setProperty(prop, v);
        else el.style[prop] = v;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value; // only used for trusted, hard-coded icons
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export const ICONS = {
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
  hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a1.5 1.5 0 0 0-1.5 1.5V12h-.5V5.5a1.5 1.5 0 0 0-3 0V11h-.5V4.5a1.5 1.5 0 0 0-3 0V11H9V6.5a1.5 1.5 0 0 0-3 0v8.3l-1.2-1.6a1.6 1.6 0 0 0-2.5 2l3.6 4.7A6 6 0 0 0 10.7 22H14a5.5 5.5 0 0 0 5.5-5.5v-7A1.5 1.5 0 0 0 18 8Z"/></svg>',
};

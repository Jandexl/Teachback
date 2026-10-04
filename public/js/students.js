// The four AI classmates. Their personalities live on the server (lib/tasks.js);
// this file only holds what the screen needs to show them.
export const STUDENTS = {
  mika: { name: 'Mika', role: 'Gets lost easily', color: 'var(--mika)' },
  rafa: { name: 'Rafa', role: 'Wants proof', color: 'var(--rafa)' },
  iya: { name: 'Iya', role: 'Asks "what if?"', color: 'var(--iya)' },
  dev: { name: 'Dev', role: 'Connects ideas', color: 'var(--dev)' },
};

export const STUDENT_IDS = Object.keys(STUDENTS);

// Hand-drawn faces for each classmate (trusted, hard-coded SVG). The circle behind
// them is the classmate's colour, set in CSS.
const INK = '#213b33';
const eyes = (y = 31, r = 1.6) => `<circle cx="27.5" cy="${y}" r="${r}" fill="${INK}"/><circle cx="36.5" cy="${y}" r="${r}" fill="${INK}"/>`;
const cheeks = '<circle cx="23.5" cy="35" r="2.2" fill="#f07a6a" opacity=".35"/><circle cx="40.5" cy="35" r="2.2" fill="#f07a6a" opacity=".35"/>';
const body = (skin, shirt) =>
  `<path d="M8 66C10 51 21 46 32 46s22 5 24 20Z" fill="${shirt}"/><rect x="28.5" y="38" width="7" height="10" rx="3" fill="${skin}"/>`;
const svg = (inner) => `<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false">${inner}</svg>`;

export const FACES = {
  mika: svg(
    body('#f3cda6', '#fffcf6') +
      '<path d="M15 31C15 16 23 10 32 10s17 6 17 21v12H15Z" fill="#2b2118"/>' +
      '<ellipse cx="32" cy="30" rx="12" ry="13" fill="#f3cda6"/>' +
      '<path d="M19.5 27C20 18 26 15 32.5 15S44.5 19 44.5 26C40 22.5 34 21.5 28 23.5 24.5 24.5 22 25.6 19.5 27Z" fill="#2b2118"/>' +
      eyes(31, 1.8) + cheeks +
      `<path d="M29.5 37q2.5 1.6 5 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
  ),
  rafa: svg(
    body('#c98b5e', '#fffcf6') +
      '<ellipse cx="32" cy="31" rx="12" ry="13" fill="#c98b5e"/>' +
      '<path d="M19.6 28C18.5 17 25.5 12 33 12s13 5.5 11.4 16C42 22.5 38 20.5 32 20.5S22.5 22.5 19.6 28Z" fill="#1d1712"/>' +
      `<path d="M24.5 27.4l5-.8M34.3 25.6q3-1.8 5.6.2" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>` +
      eyes(31) + cheeks +
      `<path d="M29 37.4q4 1.4 7-1.4" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
  ),
  iya: svg(
    body('#e8b48a', '#fffcf6') +
      '<circle cx="32" cy="10.5" r="6.5" fill="#5a3220"/>' +
      '<ellipse cx="32" cy="31" rx="12" ry="13" fill="#e8b48a"/>' +
      '<path d="M19.2 30C18 19 25 14.5 32 14.5S46 19 44.8 30C42.5 23.5 37.5 20.5 32 20.5S21.5 23.5 19.2 30Z" fill="#5a3220"/>' +
      eyes(31, 2) +
      '<circle cx="28.2" cy="30.3" r=".6" fill="#fff"/><circle cx="37.2" cy="30.3" r=".6" fill="#fff"/>' + cheeks +
      `<ellipse cx="32" cy="37.6" rx="1.9" ry="2.1" fill="${INK}"/>`
  ),
  dev: svg(
    body('#8d5a3b', '#fffcf6') +
      '<g fill="#15110e"><circle cx="21.5" cy="23" r="5"/><circle cx="25.5" cy="16.5" r="5.5"/><circle cx="32" cy="14" r="6"/><circle cx="38.5" cy="16.5" r="5.5"/><circle cx="42.5" cy="23" r="5"/><circle cx="20" cy="29" r="3.6"/><circle cx="44" cy="29" r="3.6"/></g>' +
      '<ellipse cx="32" cy="32" rx="11.5" ry="12.5" fill="#8d5a3b"/>' +
      '<path d="M21 26c3-3.5 7-5 11-5s8 1.5 11 5c-3-1.5-7-2.4-11-2.4s-8 .9-11 2.4Z" fill="#15110e"/>' +
      eyes(31.5, 1.3) +
      `<g stroke="${INK}" stroke-width="1.4" fill="none"><circle cx="27.5" cy="31.5" r="4"/><circle cx="36.5" cy="31.5" r="4"/><path d="M31.5 31.5h1"/></g>` +
      `<path d="M28.5 37q3.5 2.6 7 0" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`
  ),
};

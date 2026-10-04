// Reads a PDF in the browser: renders each page as an image and extracts its text.
// The PDF itself is never uploaded; only the extracted slide text is sent to the AI later.
import '../vendor/pdfjs/polyfills.mjs';
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/worker.mjs', import.meta.url).href;

export const MAX_SLIDES = 40;
export const MAX_FILE_MB = 30;

export async function loadSlides(file, onProgress = () => {}) {
  if (!file) throw new Error('Choose a PDF file first.');
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    if (/\.pptx?$/i.test(file.name)) {
      throw new Error('PowerPoint files need to be saved as PDF first. In PowerPoint or Google Slides, use File, then Download or Export, then PDF.');
    }
    throw new Error('That file is not a PDF. Upload your slides as a PDF.');
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(`That PDF is larger than ${MAX_FILE_MB} MB. Try exporting it with smaller images.`);
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    throw new Error('This PDF could not be opened. It may be damaged or password protected.');
  }

  const count = Math.min(doc.numPages, MAX_SLIDES);
  const slides = [];
  try {
    for (let i = 1; i <= count; i++) {
      onProgress(i, count);
      const page = await doc.getPage(i);
      const text = await pageText(page);
      const image = await renderPage(page);
      // The first line of text is usually the slide's title. It stays visible when the slide
      // is hidden ("Present from memory"), so you know what you are recalling.
      const title = (text.split('\n').find((line) => line.trim()) || '').trim().slice(0, 90);
      slides.push({ n: i, text, image, title });
      page.cleanup();
    }
  } finally {
    // Free the memory pdf.js used; the slide images and text are already copied.
    task.destroy().catch(() => {});
  }
  return { slides, truncated: doc.numPages > MAX_SLIDES };
}

async function pageText(page) {
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

async function renderPage(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(2, 1600 / base.width);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  const url = canvas.toDataURL('image/jpeg', 0.85);
  canvas.width = canvas.height = 0;
  return url;
}

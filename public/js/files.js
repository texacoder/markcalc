// Prepares uploads in the browser. Photos are resized; PDF pages become images, or,
// when allowed and the page already contains typed text, that text is extracted instead
// (no image page used). Plain .txt files are read as text.
const QUALITY = 0.85;
let pdfjsPromise;

function loadPdfJs() {
  pdfjsPromise ??= import('/vendor/pdfjs/pdf.min.mjs').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
    return lib;
  });
  return pdfjsPromise;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not process image.'))), 'image/jpeg', QUALITY),
  );
}

function fit(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return [Math.round(width * scale), Math.round(height * scale)];
}

async function imageToJpeg(file, maxSide) {
  // createImageBitmap applies the phone's EXIF rotation.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error(`"${file.name}" could not be opened. Use a JPG or PNG photo.`);
  });
  const [w, h] = fit(bitmap.width, bitmap.height, maxSide);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  return canvasToBlob(canvas);
}

// Text of a PDF page, or '' if the page is a scan / has hardly any text.
async function pageText(page) {
  const content = await page.getTextContent();
  let text = '';
  for (const item of content.items) text += (item.str || '') + (item.hasEOL ? '\n' : ' ');
  text = text.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim();
  return text.replace(/\s/g, '').length >= 40 ? text : '';
}

async function renderPage(page, maxSide) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(3, maxSide / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport }).promise;
  return canvasToBlob(canvas);
}

async function readPdf(file, { onProgress, maxSide, extractText }, out) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise.catch(() => {
    throw new Error(`"${file.name}" could not be opened as a PDF.`);
  });
  const texts = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Reading PDF page ${i} of ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const text = extractText ? await pageText(page) : '';
    if (text) texts.push(text);
    else out.images.push(await renderPage(page, maxSide));
  }
  await task.destroy();
  if (texts.length) out.texts.push({ name: file.name, text: texts.join('\n\n') });
}

const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
const isText = (f) => f.type === 'text/plain' || /\.(txt|text|md)$/i.test(f.name);
const isImage = (f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic|heif|bmp)$/i.test(f.name);

// Returns { images: [JPEG blobs, one per page], texts: [{ name, text }] }.
export async function prepareFiles(fileList, { onProgress, maxSide = 1600, extractText = false } = {}) {
  const out = { images: [], texts: [] };
  for (const file of fileList) {
    if (isPdf(file)) {
      await readPdf(file, { onProgress, maxSide, extractText }, out);
    } else if (isText(file)) {
      out.texts.push({ name: file.name, text: (await file.text()).trim() });
    } else if (isImage(file)) {
      onProgress?.(`Preparing ${file.name}…`);
      out.images.push(await imageToJpeg(file, maxSide));
    } else if (/\.docx?$/i.test(file.name)) {
      throw new Error(`"${file.name}" is a Word file. Save it as PDF, or copy and paste its text into the box.`);
    } else {
      throw new Error(`"${file.name}" isn't a photo, PDF or text file.`);
    }
  }
  return out;
}

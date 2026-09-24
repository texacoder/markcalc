// Prepares uploads in the browser: PDFs become one image per page, and large
// phone photos are resized so uploads are fast and marking stays accurate.
const MAX_SIDE = 2200;
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

function fit(width, height) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  return [Math.round(width * scale), Math.round(height * scale)];
}

async function imageToJpeg(file) {
  // createImageBitmap applies the phone's EXIF rotation.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error(`"${file.name}" could not be opened. Use a JPG or PNG photo.`);
  });
  const [w, h] = fit(bitmap.width, bitmap.height);
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

async function pdfToJpegs(file, onProgress) {
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: await file.arrayBuffer() });
  const doc = await task.promise.catch(() => {
    throw new Error(`"${file.name}" could not be opened as a PDF.`);
  });
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`Reading PDF page ${i} of ${doc.numPages}…`);
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport }).promise;
    pages.push(await canvasToBlob(canvas));
  }
  await task.destroy();
  return pages;
}

// Returns an array of JPEG blobs, one per page.
export async function prepareFiles(fileList, onProgress) {
  const out = [];
  for (const file of fileList) {
    if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
      out.push(...(await pdfToJpegs(file, onProgress)));
    } else if (file.type.startsWith('image/') || /\.(jpe?g|png|webp|gif|heic)$/i.test(file.name)) {
      onProgress?.(`Preparing ${file.name}…`);
      out.push(await imageToJpeg(file));
    } else {
      throw new Error(`"${file.name}" is not an image or PDF.`);
    }
  }
  return out;
}

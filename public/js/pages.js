// A page picker: upload / photograph / drag pages, preview them, reorder and remove.
import { html, mount, $, toast } from './ui.js';
import { prepareFiles, shrinkImage } from './files.js';

let uid = 0;

export class PagePicker {
  // extractText: typed PDFs / .txt files are turned into text and passed to onText(text, fileName)
  // instead of being added as page images.
  constructor(root, { label, hint, onChange, onText, maxSide, extractText = false } = {}) {
    this.root = root;
    this.items = [];
    this.onChange = onChange;
    this.onText = onText;
    this.maxSide = maxSide;
    this.extractText = extractText;
    this.busy = false;
    const id = `pp${++uid}`;

    mount(
      root,
      html`<div class="drop">
        <div class="drop-empty">
          <svg viewBox="0 0 24 24" width="36" height="36" aria-hidden="true"><path fill="currentColor" d="M19 13v6H5v-6H3v6a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2Zm-6-9.17 3.59 3.58L18 6l-6-6-6 6 1.41 1.41L11 3.83V16h2V3.83Z"/></svg>
          <strong>${label}</strong>
          <span class="muted">${hint}</span>
          <div class="drop-buttons">
            <label class="btn" for="${id}-files">Choose files</label>
            <label class="btn ghost camera-btn" for="${id}-camera">Take photo</label>
          </div>
          <input type="file" id="${id}-files" accept="image/*,application/pdf,.pdf,.txt,text/plain" multiple hidden />
          <input type="file" id="${id}-camera" accept="image/*" capture="environment" hidden />
        </div>
        <p class="drop-status muted" hidden></p>
        <ol class="thumbs"></ol>
      </div>`,
    );

    this.drop = $('.drop', root);
    this.status = $('.drop-status', root);
    this.list = $('.thumbs', root);
    for (const input of [$(`#${id}-files`, root), $(`#${id}-camera`, root)]) {
      input.addEventListener('change', () => {
        this.add(input.files);
        input.value = '';
      });
    }
    this.drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.drop.classList.add('over');
    });
    this.drop.addEventListener('dragleave', () => this.drop.classList.remove('over'));
    this.drop.addEventListener('drop', (e) => {
      e.preventDefault();
      this.drop.classList.remove('over');
      this.add(e.dataTransfer.files);
    });
    this.list.addEventListener('click', (e) => this.onThumbClick(e));
    this.render();
  }

  async add(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    this.busy = true;
    this.status.hidden = false;
    try {
      const { images, texts } = await prepareFiles(files, {
        onProgress: (msg) => (this.status.textContent = msg),
        maxSide: this.maxSide,
        extractText: this.extractText,
      });
      for (const blob of images) this.items.push({ key: `n${++uid}`, blob, url: URL.createObjectURL(blob) });
      for (const { name, text } of texts) this.onText?.(text, name);
      this.render();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      this.busy = false;
      this.status.hidden = true;
    }
  }

  onThumbClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const i = Number(btn.closest('li').dataset.index);
    const act = btn.dataset.act;
    if (act === 'remove') {
      const [item] = this.items.splice(i, 1);
      URL.revokeObjectURL(item.url);
    } else if (act === 'left' && i > 0) {
      [this.items[i - 1], this.items[i]] = [this.items[i], this.items[i - 1]];
    } else if (act === 'right' && i < this.items.length - 1) {
      [this.items[i + 1], this.items[i]] = [this.items[i], this.items[i + 1]];
    } else if (act === 'view') {
      window.open(this.items[i].url, '_blank', 'noopener');
      return;
    }
    this.render();
  }

  render() {
    this.drop.classList.toggle('has-pages', this.items.length > 0);
    mount(
      this.list,
      html`${this.items.map(
        (item, i) => html`<li data-index="${i}">
          <button type="button" class="thumb-img" data-act="view" title="Open full size">
            <img src="${item.url}" alt="Page ${i + 1}" loading="lazy" />
          </button>
          <div class="thumb-bar">
            <button type="button" data-act="left" aria-label="Move page ${i + 1} earlier" ${i === 0 ? 'disabled' : ''}>‹</button>
            <span>Page ${i + 1}</span>
            <button type="button" data-act="right" aria-label="Move page ${i + 1} later" ${i === this.items.length - 1 ? 'disabled' : ''}>›</button>
          </div>
          <button type="button" class="thumb-remove" data-act="remove" aria-label="Remove page ${i + 1}">×</button>
        </li>`,
      )}`,
    );
    this.onChange?.(this.items.length);
  }

  count() {
    return this.items.length;
  }

  // factor < 1 sends smaller copies of the pages (the originals are kept).
  async appendTo(form, field, factor = 1) {
    for (const [i, item] of this.items.entries()) {
      const blob = factor < 1 ? await shrinkImage(item.blob, factor) : item.blob;
      form.append(field, blob, `page-${i + 1}.jpg`);
    }
  }

  clear() {
    for (const item of this.items) URL.revokeObjectURL(item.url);
    this.items = [];
    this.render();
  }
}

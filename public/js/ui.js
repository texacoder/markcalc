// Small DOM helpers shared by the views.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(value) {
    this.value = value;
  }
}
export const raw = (v) => new Raw(v);

// Tagged template: interpolated values are escaped unless wrapped in raw() or are arrays of html``.
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    if (v instanceof Raw) out += v.value;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.value : escape(x))).join('');
    else if (v === false || v === null || v === undefined) out += '';
    else out += escape(v);
    out += strings[i + 1];
  });
  return raw(out);
}

export function mount(target, content) {
  target.innerHTML = content instanceof Raw ? content.value : escape(content);
  return target;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function fmt(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return '–';
  return Number.isInteger(x) ? String(x) : x.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function scoreClass(awarded, maximum) {
  if (!maximum) return '';
  const p = awarded / maximum;
  return p >= 0.999 ? 'full' : p >= 0.5 ? 'good' : p > 0 ? 'part' : 'zero';
}

let toastTimer;
export function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 4000);
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    mount(button, html`<span class="spinner" aria-hidden="true"></span>${label || 'Please wait…'}`);
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || button.textContent;
  }
}

export function confirmDialog(message, okLabel = 'Delete') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog small';
    mount(
      dlg,
      html`<form method="dialog">
        <p>${message}</p>
        <div class="actions end">
          <button value="cancel" class="btn ghost">Cancel</button>
          <button value="ok" class="btn danger">${okLabel}</button>
        </div>
      </form>`,
    );
    document.body.append(dlg);
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok');
      dlg.remove();
    });
    dlg.showModal();
  });
}

export function formatDate(sqlDate) {
  const d = new Date(`${String(sqlDate).replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

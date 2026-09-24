(() => {
  const form = document.getElementById('grade-form');
  const submitBtn = document.getElementById('submit');
  const nextBtn = document.getElementById('next-student');
  const errorEl = document.getElementById('error');
  const resultEl = document.getElementById('result');

  const STORAGE_KEY = 'markcalc-setup-v1';
  const SAVED_FIELDS = ['subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'questionText', 'instructions'];
  const files = { questionPaper: [], answerSheet: [] };

  // ---- Remember the exam setup in this browser ----
  function saveSetup() {
    const data = {};
    for (const name of SAVED_FIELDS) data[name] = form.elements[name].value;
    data.presets = [...form.querySelectorAll('input[name=preset]:checked')].map((c) => c.value);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
  }

  function loadSetup() {
    let data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch {}
    if (!data) return;
    for (const name of SAVED_FIELDS) if (data[name]) form.elements[name].value = data[name];
    for (const c of form.querySelectorAll('input[name=preset]')) c.checked = (data.presets || []).includes(c.value);
  }

  form.addEventListener('input', saveSetup);
  loadSetup();

  // ---- File pickers with previews ----
  function renderThumbs(key) {
    const box = document.getElementById(`${key}-thumbs`);
    box.replaceChildren();
    files[key].forEach((file, i) => {
      const item = document.createElement('div');
      item.className = 'thumb';
      const img = document.createElement('img');
      img.src = URL.createObjectURL(file);
      img.alt = file.name;
      img.onload = () => URL.revokeObjectURL(img.src);
      const label = document.createElement('span');
      label.textContent = `Page ${i + 1}`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.setAttribute('aria-label', `Remove page ${i + 1}`);
      remove.onclick = () => { files[key].splice(i, 1); renderThumbs(key); };
      item.append(img, label, remove);
      box.append(item);
    });
  }

  function addFiles(key, list) {
    const images = [...list].filter((f) => f.type.startsWith('image/'));
    files[key].push(...images);
    renderThumbs(key);
  }

  for (const drop of document.querySelectorAll('.drop')) {
    const key = drop.dataset.input;
    const input = document.getElementById(key);
    input.addEventListener('change', () => { addFiles(key, input.files); input.value = ''; });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles(key, e.dataTransfer.files);
    });
  }

  // ---- Submit ----
  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.hidden = !msg;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.innerHTML = busy ? '<span class="spinner"></span>Calculating…' : 'Calculate marks';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    if (!files.answerSheet.length) return showError('Please upload the answer sheet.');
    if (!files.questionPaper.length && !form.elements.questionText.value.trim()) {
      return showError('Please upload the question paper or type the questions.');
    }

    const body = new FormData();
    for (const name of SAVED_FIELDS) if (name !== 'instructions') body.append(name, form.elements[name].value);
    const presets = [...form.querySelectorAll('input[name=preset]:checked')].map((c) => `- ${c.value}`);
    const own = form.elements.instructions.value.trim();
    body.append('instructions', [...presets, own && `- ${own}`].filter(Boolean).join('\n'));
    files.questionPaper.forEach((f) => body.append('questionPaper', f));
    files.answerSheet.forEach((f) => body.append('answerSheet', f));

    setBusy(true);
    try {
      const res = await fetch('/api/grade', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not calculate marks. Please try again.');
      renderResult(data);
      nextBtn.hidden = false;
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  });

  nextBtn.addEventListener('click', () => {
    files.answerSheet = [];
    renderThumbs('answerSheet');
    resultEl.hidden = true;
    nextBtn.hidden = true;
    document.querySelector('[data-input=answerSheet]').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ---- Result ----
  function el(tag, attrs = {}, text) {
    const node = document.createElement(tag);
    Object.assign(node, attrs);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fmt(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  }

  function renderResult(r) {
    resultEl.replaceChildren();
    resultEl.append(el('h2', {}, 'Result'));

    const score = el('div', { className: 'score' });
    score.append(
      el('span', { className: 'big' }, `${fmt(r.totalAwarded)} / ${fmt(r.totalMaximum)}`),
      el('span', { className: 'pct' }, `${fmt(r.percentage)}%`),
    );
    resultEl.append(score);
    if (r.studentName) resultEl.append(el('p', { className: 'student' }, `Student: ${r.studentName}`));

    const table = el('table');
    const head = el('tr');
    for (const h of ['Question', 'Marks', 'Remarks']) head.append(el('th', {}, h));
    table.appendChild(el('thead')).append(head);
    const tbody = table.appendChild(el('tbody'));
    for (const q of r.questions) {
      const cls = q.awarded >= q.maximum ? 'full' : q.awarded > 0 ? 'part' : 'zero';
      const row = el('tr');
      row.append(
        el('td', {}, q.question),
        el('td', { className: `num ${cls}` }, `${fmt(q.awarded)} / ${fmt(q.maximum)}`),
        el('td', {}, q.comment),
      );
      tbody.append(row);
    }
    resultEl.append(table);

    if (r.overallFeedback) {
      resultEl.append(el('h3', {}, 'Feedback'), el('p', {}, r.overallFeedback));
    }
    if (r.warnings?.length) {
      const box = el('div', { className: 'warnings' });
      box.append(el('strong', {}, 'Please check'));
      const ul = el('ul');
      for (const w of r.warnings) ul.append(el('li', {}, w));
      box.append(ul);
      resultEl.append(box);
    }

    const actions = el('div', { className: 'actions' });
    const print = el('button', { type: 'button', className: 'secondary' }, 'Print result');
    print.onclick = () => window.print();
    actions.append(print);
    resultEl.append(actions);

    resultEl.hidden = false;
    resultEl.scrollIntoView({ behavior: 'smooth' });
  }
})();

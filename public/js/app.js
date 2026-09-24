// Single-page marking tool. No login and nothing is stored on the server:
// everything lives in this page until it is closed.
import { api } from './api.js';
import { html, mount, $, $$, fmt, scoreClass, toast, setBusy, confirmDialog } from './ui.js';
import { PagePicker } from './pages.js';

const view = $('#view');
const config = { maxPages: 40, perDeviceLimit: 15, imageMaxSide: 1600, usedToday: 0 };
const session = []; // results marked while this page is open
let grading = false;

const PRESETS = [
  ['Check liberally', 'Check liberally; give the benefit of the doubt for partially correct or reasonably worded answers.'],
  ['Check strictly', 'Check strictly; award marks only for fully correct points that match the scheme.'],
  ['Marks for diagram alone', 'Award marks for a correct diagram even if the written explanation is missing or incomplete.'],
  ['Step marks', 'Give step marks for the correct method even if the final answer is wrong.'],
  ['Ignore spelling & grammar', 'Ignore spelling and grammar mistakes unless the subject is a language.'],
  ['Deduct for missing units', 'Deduct marks when units are missing or wrong in numerical answers.'],
  ['No half marks', 'Award whole marks only; no half marks.'],
  ['Keywords matter', 'Look for key terms from the marking scheme; answers containing the key points get marks even if worded differently.'],
];

window.addEventListener('beforeunload', (e) => {
  if (grading || session.length) e.preventDefault();
});

// ---------------------------------------------------------------- routing
function router() {
  const path = location.hash.replace(/^#/, '') || '/';
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${path}`));
  if (path === '/help') {
    $('#mark-page').hidden = true;
    $('#help-page').hidden = false;
    window.scrollTo(0, 0);
  } else {
    $('#help-page').hidden = true;
    $('#mark-page').hidden = false;
  }
}

// ---------------------------------------------------------------- marking page
function renderMarkPage() {
  const limited = config.maxPages < 20;
  mount(
    view,
    html`<div id="mark-page">
      <div class="page-head">
        <div>
          <h1 tabindex="-1">Mark an answer sheet</h1>
          <p class="muted">Fill in the exam details once, add the question paper and the student's answer sheet, and get the marks. Nothing is saved: when you close this page, it's all gone.</p>
        </div>
      </div>

      <form id="mark-form" novalidate>
        <section class="card">
          <h2><span class="step">1</span> Exam details</h2>
          <div class="grid-3">
            <label>Subject / paper<input name="subject" placeholder="e.g. Physics, Data Structures" /></label>
            <label>Class / course<input name="className" placeholder="e.g. Class 10, B.Sc. Sem 3" /></label>
            <label>Total marks<input name="totalMarks" type="number" min="1" step="0.5" placeholder="e.g. 40" /></label>
          </div>
          <label>Syllabus / topics covered <small class="muted">(optional)</small>
            <textarea name="syllabus" rows="2" placeholder="e.g. Unit 1 Optics – reflection & refraction; Unit 2 Human eye"></textarea>
          </label>
        </section>

        <section class="card">
          <h2><span class="step">2</span> Marking scheme / answer key</h2>
          <p class="hint">Write the expected answer or key points for each question and how the marks are split. This matters most for accurate marks.</p>
          <textarea name="scheme" rows="8" placeholder="Q1 (2 marks) Define refraction – bending of light when it passes from one medium to another (2)&#10;Q2 (5 marks) Ray diagram of convex lens – correct rays (2), labels (1), image position (1), nature of image (1)&#10;Q3 (3 marks) f = 20 cm, u = -30 cm → v = 60 cm. Formula (1), substitution (1), answer with unit (1)"></textarea>
          <label>Anything else the checker should know <small class="muted">(optional)</small>
            <textarea name="extra" rows="2" placeholder="e.g. Part B: answer any 5 of 8. Internal choice in Q6."></textarea>
          </label>
        </section>

        <section class="card">
          <h2><span class="step">3</span> Question paper</h2>
          <p class="hint">Type or paste the questions, or upload photos / a PDF of the question paper.
            ${limited ? html`<strong>Typing is better:</strong> each marking can read only ${config.maxPages} pages in total, so typed questions leave every page for the answer sheet.` : ''}</p>
          <textarea name="questionText" rows="5" placeholder="Q1. Define refraction. (2)&#10;Q2. Draw a ray diagram for a convex lens… (5)"></textarea>
          <details id="qp-details">
            <summary>Or upload question paper photos / PDF</summary>
            <div id="qp-picker"></div>
          </details>
        </section>

        <section class="card">
          <h2><span class="step">4</span> How should it be checked?</h2>
          <div class="chips">
            ${PRESETS.map(([label, value]) => html`<label class="chip"><input type="checkbox" name="preset" value="${value}" /> ${label}</label>`)}
          </div>
          <label>Your own instructions <small class="muted">(optional)</small>
            <textarea name="instructions" rows="2" placeholder="e.g. Accept answers in Hindi or English. Q4: full marks if any 3 of the 5 points are present."></textarea>
          </label>
        </section>

        <section class="card" id="answer-card">
          <h2><span class="step">5</span> Student's answer sheet</h2>
          <div class="grid-2">
            <label>Student name<input name="studentName" autocomplete="off" placeholder="Optional" /></label>
            <label>Roll no.<input name="rollNo" autocomplete="off" placeholder="Optional" /></label>
          </div>
          <div id="as-picker"></div>
        </section>

        <p class="form-error" role="alert" hidden></p>
        <div class="submit-bar">
          <button class="btn primary big" type="submit" id="mark-btn">Calculate marks</button>
          <span class="muted small" id="page-count"></span>
        </div>
      </form>

      <section id="result" hidden></section>
      <section class="card" id="session-results" hidden></section>
    </div>
    <div id="help-page" hidden>${helpContent()}</div>`,
  );

  // Declared first: the pickers call updateCount() while they are being created.
  let qpPicker = null;
  let asPicker = null;
  qpPicker = new PagePicker($('#qp-picker'), {
    label: 'Add question paper pages',
    hint: 'JPG, PNG or PDF. One photo per page.',
    maxSide: config.imageMaxSide,
    onChange: () => updateCount(),
  });
  asPicker = new PagePicker($('#as-picker'), {
    label: "Add the student's answer sheet",
    hint: 'All pages, in order. Phone photos or a PDF.',
    maxSide: config.imageMaxSide,
    onChange: () => updateCount(),
  });

  function updateCount() {
    const total = (qpPicker?.count() || 0) + (asPicker?.count() || 0);
    const over = total > config.maxPages;
    const el = $('#page-count');
    el.textContent = total ? `${total} of ${config.maxPages} pages` : '';
    el.classList.toggle('over', over);
    $('#mark-btn').disabled = over;
    if (over) $('#mark-btn').textContent = `Too many pages (max ${config.maxPages})`;
    else $('#mark-btn').textContent = 'Calculate marks';
  }
  updateCount();

  const form = $('#mark-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    const fail = (msg, focus) => {
      err.textContent = msg;
      err.hidden = false;
      (focus || err).scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    if (qpPicker.busy || asPicker.busy) return fail('Please wait for the pages to finish loading.');
    if (!form.elements.questionText.value.trim() && !qpPicker.count()) {
      return fail('Please add the question paper: type the questions or upload photos.', form.elements.questionText);
    }
    if (!asPicker.count()) return fail("Please add the student's answer sheet pages.", $('#answer-card'));

    const fd = new FormData();
    for (const name of ['subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'questionText', 'instructions', 'studentName', 'rollNo']) {
      fd.append(name, form.elements[name].value);
    }
    fd.append('presets', JSON.stringify($$('input[name=preset]:checked', form).map((c) => c.value)));
    qpPicker.appendTo(fd, 'questionPaper');
    asPicker.appendTo(fd, 'answerSheet');

    const btn = $('#mark-btn');
    setBusy(btn, true, 'Marking…');
    const progress = showProgress(qpPicker.count(), asPicker.count());
    grading = true;
    try {
      const result = await api('/grade', { method: 'POST', form: fd });
      result.id = Date.now();
      session.unshift(result);
      renderResult(result);
      renderSession();
      toast(`Marked: ${fmt(result.totalAwarded)} / ${fmt(result.totalMaximum)}`, 'success');
    } catch (ex) {
      fail(ex.message);
    } finally {
      grading = false;
      progress.close();
      setBusy(btn, false);
      updateCount();
    }
  });

  // "Next student": keep the exam setup, clear only the answer sheet.
  view.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-page-act]')?.dataset.pageAct;
    if (act === 'next') {
      asPicker.clear();
      form.elements.studentName.value = '';
      form.elements.rollNo.value = '';
      $('#result').hidden = true;
      $('#answer-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (act === 'new-exam') {
      if (!(await confirmDialog('Clear everything, including the results list, and start a new exam?', 'Start new exam'))) return;
      session.length = 0;
      grading = false;
      location.reload();
    }
  });
}

function showProgress(qpPages, asPages) {
  const steps = [
    qpPages ? 'Reading the question paper…' : 'Reading the questions…',
    `Reading ${asPages} answer page${asPages > 1 ? 's' : ''}…`,
    'Matching answers to questions…',
    'Applying your marking scheme…',
    'Checking against your instructions…',
    'Adding up the marks…',
  ];
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog progress';
  mount(
    dlg,
    html`<div class="progress-body">
      <span class="spinner big" aria-hidden="true"></span>
      <h2>Marking the answer sheet</h2>
      <p class="progress-step" aria-live="polite">${steps[0]}</p>
      <p class="muted small">This usually takes 30–90 seconds. Please keep this page open.</p>
      <p class="muted small progress-time">0s</p>
    </div>`,
  );
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  const started = Date.now();
  let i = 0;
  const t1 = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);
    $('.progress-step', dlg).textContent = steps[i];
  }, 9000);
  const t2 = setInterval(() => ($('.progress-time', dlg).textContent = `${Math.round((Date.now() - started) / 1000)}s`), 1000);
  return {
    close() {
      clearInterval(t1);
      clearInterval(t2);
      dlg.close();
      dlg.remove();
    },
  };
}

// ---------------------------------------------------------------- results
function round(n) {
  return Math.round(Number(n) * 100) / 100;
}

// Same rule as the server: total = sum of counted questions, capped at the paper total.
function recompute(r) {
  const total = round(r.questions.filter((q) => q.counted).reduce((s, q) => s + q.awarded, 0));
  r.totalAwarded = Math.min(total, r.totalMaximum);
  r.percentage = r.totalMaximum ? round((r.totalAwarded / r.totalMaximum) * 100) : 0;
}

function resultCard(r, { onChange, onDelete } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'result';

  const draw = () => {
    mount(
      wrap,
      html`<div class="result-head">
        <div>
          <h2 class="result-name">${r.studentName || 'Student'}${r.rollNo ? html` <span class="muted">· Roll ${r.rollNo}</span>` : ''}</h2>
          ${r.edited ? html`<span class="badge">Corrected by teacher</span>` : ''}
        </div>
        <div class="score ${scoreClass(r.totalAwarded, r.totalMaximum)}">
          <span class="score-big">${fmt(r.totalAwarded)}<span class="score-max"> / ${fmt(r.totalMaximum)}</span></span>
          <span class="score-pct">${fmt(r.percentage)}%</span>
        </div>
      </div>
      ${r.warnings?.length
        ? html`<div class="warn-box"><strong>Please double-check:</strong><ul>${r.warnings.map((w) => html`<li>${w}</li>`)}</ul></div>`
        : ''}
      <div class="table-wrap">
        <table class="q-table">
          <thead><tr><th>Q</th><th>Student's answer</th><th>Remarks</th><th class="num">Marks</th></tr></thead>
          <tbody>
            ${r.questions.map(
              (q, i) => html`<tr class="${q.counted ? '' : 'not-counted'}">
                <td class="q-label">${q.question}</td>
                <td>${q.studentAnswer}</td>
                <td>${q.comment}${q.counted ? '' : html` <span class="badge muted-badge">not counted (choice)</span>`}</td>
                <td class="num">
                  <span class="mark ${scoreClass(q.awarded, q.maximum)}">${fmt(q.awarded)}</span><span class="muted"> / ${fmt(q.maximum)}</span>
                  <input class="mark-input" type="number" step="0.5" min="0" max="${q.maximum}" value="${q.awarded}" data-index="${i}" aria-label="Marks for question ${q.question}" hidden />
                </td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
      ${r.overallFeedback ? html`<div class="feedback"><h3>Feedback</h3><p>${r.overallFeedback}</p></div>` : ''}
      <div class="actions result-actions no-print">
        <button type="button" class="btn ghost small" data-act="edit">Correct marks</button>
        <button type="button" class="btn primary small" data-act="save" hidden>Save changes</button>
        <button type="button" class="btn ghost small" data-act="cancel" hidden>Cancel</button>
        <button type="button" class="btn ghost small" data-act="print">Print</button>
        ${onDelete ? html`<button type="button" class="btn ghost danger small" data-act="delete">Remove from list</button>` : ''}
      </div>`,
    );
  };

  const setEditing = (on) => {
    $$('.mark-input', wrap).forEach((i) => (i.hidden = !on));
    $$('.mark', wrap).forEach((m) => (m.hidden = on));
    $('[data-act=edit]', wrap).hidden = on;
    $('[data-act=save]', wrap).hidden = !on;
    $('[data-act=cancel]', wrap).hidden = !on;
    if (on) $('.mark-input', wrap)?.focus();
  };

  wrap.addEventListener('click', async (e) => {
    const act = e.target.closest('button[data-act]')?.dataset.act;
    if (act === 'edit') setEditing(true);
    if (act === 'cancel') draw();
    if (act === 'print') printNode(wrap);
    if (act === 'save') {
      for (const input of $$('.mark-input', wrap)) {
        const q = r.questions[Number(input.dataset.index)];
        const value = Number(input.value);
        q.awarded = Number.isFinite(value) ? Math.min(q.maximum, Math.max(0, round(value))) : q.awarded;
      }
      r.edited = true;
      recompute(r);
      draw();
      onChange?.(r);
      toast('Marks updated.', 'success');
    }
    if (act === 'delete' && (await confirmDialog(`Remove ${r.studentName || 'this student'} from the list?`, 'Remove'))) onDelete(r);
  });

  draw();
  return wrap;
}

function renderResult(r) {
  const box = $('#result');
  box.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card latest';
  card.append(resultCard(r, { onChange: () => renderSession() }));
  const next = document.createElement('div');
  next.className = 'actions next-actions no-print';
  mount(
    next,
    html`<button type="button" class="btn primary" data-page-act="next">Mark the next student (same exam)</button>
      <button type="button" class="btn ghost" data-page-act="new-exam">Start a new exam</button>`,
  );
  card.append(next);
  box.append(card);
  box.dataset.id = String(r.id);
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderSession() {
  const box = $('#session-results');
  if (!session.length) {
    box.hidden = true;
    return;
  }
  const pcts = session.map((r) => r.percentage);
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  mount(
    box,
    html`<div class="page-head">
      <div>
        <h2>Results so far</h2>
        <p class="muted small">Kept only in this page. Download the list before you close it.</p>
      </div>
      <div class="actions">
        <button type="button" class="btn primary small" id="download-csv">Download CSV / Excel</button>
        <button type="button" class="btn ghost small" id="print-all">Print list</button>
      </div>
    </div>
    ${session.length > 1
      ? html`<div class="stats">
          <div><span class="muted small">Students</span><strong>${session.length}</strong></div>
          <div><span class="muted small">Average</span><strong>${fmt(Math.round(avg * 10) / 10)}%</strong></div>
          <div><span class="muted small">Highest</span><strong>${fmt(Math.max(...pcts))}%</strong></div>
          <div><span class="muted small">Lowest</span><strong>${fmt(Math.min(...pcts))}%</strong></div>
        </div>`
      : ''}
    <div class="table-wrap" id="session-table">
      <table class="class-table">
        <thead><tr><th>Roll</th><th>Student</th><th class="num">Marks</th><th class="num">%</th><th class="no-print"></th></tr></thead>
        <tbody>
          ${session.map(
            (r) => html`<tr>
              <td>${r.rollNo || '–'}</td>
              <td>${r.studentName || 'Student'}${r.edited ? html` <span class="badge">corrected</span>` : ''}${r.warnings?.length ? html` <span class="badge warn">check</span>` : ''}</td>
              <td class="num"><strong>${fmt(r.totalAwarded)}</strong> / ${fmt(r.totalMaximum)}</td>
              <td class="num"><span class="pct ${scoreClass(r.totalAwarded, r.totalMaximum)}">${fmt(r.percentage)}%</span></td>
              <td class="num no-print"><button type="button" class="btn ghost small" data-open="${r.id}">View</button></td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
  );
  box.hidden = false;

  $('#download-csv').onclick = downloadCsv;
  $('#print-all').onclick = () => {
    const node = document.createElement('div');
    const f = $('#mark-form').elements;
    mount(node, html`<h2>Results: ${[f.subject.value, f.className.value].filter(Boolean).join(' · ') || 'Exam'}</h2>`);
    node.append($('#session-table').cloneNode(true));
    printNode(node);
  };
  box.onclick = (e) => {
    const id = Number(e.target.closest('[data-open]')?.dataset.open);
    const r = session.find((x) => x.id === id);
    if (r) openResultDialog(r);
  };
}

function openResultDialog(r) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog wide';
  const close = document.createElement('button');
  close.className = 'dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.onclick = () => dlg.close();
  dlg.append(
    close,
    resultCard(r, {
      onChange: () => renderSession(),
      onDelete: (d) => {
        session.splice(session.indexOf(d), 1);
        dlg.close();
        renderSession();
        if ($('#result').dataset.id === String(d.id)) $('#result').hidden = true;
      },
    }),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  document.body.append(dlg);
  dlg.showModal();
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv() {
  const labels = [];
  for (const r of session) for (const q of r.questions) if (!labels.includes(q.question)) labels.push(q.question);
  const rows = [['Roll No', 'Student', ...labels.map((l) => `Q${l}`), 'Total', 'Out of', 'Percentage']];
  const sorted = [...session].sort((a, b) => String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true }));
  for (const r of sorted) {
    const byLabel = Object.fromEntries(r.questions.map((q) => [q.question, q.counted ? q.awarded : `(${q.awarded})`]));
    rows.push([r.rollNo, r.studentName, ...labels.map((l) => byLabel[l] ?? ''), r.totalAwarded, r.totalMaximum, `${r.percentage}%`]);
  }
  const csv = `﻿${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const subject = $('#mark-form').elements.subject.value.replace(/[^\w\- ]+/g, '').trim();
  a.download = `${subject || 'marks'}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function printNode(node) {
  const area = $('#print-area');
  area.replaceChildren(node.cloneNode(true));
  $$('input', area).forEach((i) => i.remove());
  $$('.mark', area).forEach((m) => (m.hidden = false));
  document.body.classList.add('printing');
  window.addEventListener(
    'afterprint',
    () => {
      document.body.classList.remove('printing');
      area.replaceChildren();
    },
    { once: true },
  );
  window.print();
}

// ---------------------------------------------------------------- help
function helpContent() {
  return html`<h1 tabindex="-1">How to use Mark Calculator</h1>
    <div class="help">
      <section class="card">
        <h2>1. Describe the exam</h2>
        <ul>
          <li><strong>Exam details</strong>: subject or paper, class or course (school, college or university) and <em>total marks</em>.</li>
          <li><strong>Marking scheme / answer key</strong>: the expected answer or key points for each question and how the marks are split. This matters most for accuracy.</li>
          <li><strong>Question paper</strong>: type or paste the questions, or upload photos / a PDF.</li>
          <li><strong>Checking instructions</strong>: tap options like <em>Check liberally</em>, <em>Marks for diagram alone</em> or <em>Step marks</em>, and add your own.</li>
        </ul>
      </section>
      <section class="card">
        <h2>2. Add the answer sheet and calculate</h2>
        <ul>
          <li>Add every page of the student's answer sheet in order: <strong>Choose files</strong> (photos or PDF) or <strong>Take photo</strong> on a phone. Use ‹ › to reorder and × to remove a page.</li>
          <li>Click <strong>Calculate marks</strong>. It takes about 30–90 seconds.</li>
          ${config.maxPages < 20 ? html`<li>Each marking can read up to <strong>${config.maxPages} pages</strong> in total (question paper + answer sheet). Typing the questions leaves more room for the answer sheet.</li>` : ''}
        </ul>
      </section>
      <section class="card">
        <h2>3. Check the result</h2>
        <ul>
          <li>You get marks for every question, what the student wrote, a short remark, the total and feedback.</li>
          <li>Anything under <em>Please double-check</em> (unclear handwriting, a missing page) is worth a look.</li>
          <li><strong>Correct marks</strong> lets you change any mark. The total updates by itself.</li>
          <li><strong>Mark the next student</strong> keeps the exam details, so you only add the next answer sheet. <strong>Download CSV / Excel</strong> saves the list of results.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Tips for accurate marks</h2>
        <ul>
          <li>Photograph pages flat, in good light, with the whole page in the frame.</li>
          <li>Write a clear marking scheme with key points and the mark split for each question.</li>
          <li>Always glance over the result. The marks are a strong first check, but you're the examiner.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Privacy</h2>
        <p>There are no accounts and nothing is stored. The question paper and answer sheet are used only to calculate the marks and are then discarded. Results exist only in your open page until you close it.</p>
      </section>
      <p><a class="btn primary" href="#/">Start marking</a></p>
    </div>`;
}

// ---------------------------------------------------------------- start
(async function start() {
  try {
    Object.assign(config, await api('/config'));
  } catch (err) {
    toast(err.message, 'error');
  }
  renderMarkPage();
  window.addEventListener('hashchange', router);
  router();
})();

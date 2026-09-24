import { api, ApiError } from './api.js';
import { html, mount, $, $$, fmt, scoreClass, toast, setBusy, confirmDialog, formatDate } from './ui.js';
import { PagePicker } from './pages.js';

const view = $('#view');
const state = { user: null, usage: null, config: { signupCodeRequired: false } };

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

// ---------------------------------------------------------------- routing
const routes = [
  [/^\/login$/, () => authView('login'), { guest: true }],
  [/^\/signup$/, () => authView('signup'), { guest: true }],
  [/^\/help$/, () => helpView(), { open: true }],
  [/^\/$/, () => dashboardView()],
  [/^\/exams\/new$/, () => examEditorView()],
  [/^\/exams\/(\d+)\/edit$/, (m) => examEditorView(Number(m[1]))],
  [/^\/exams\/(\d+)$/, (m) => markingView(Number(m[1]))],
  [/^\/account$/, () => accountView()],
];

let grading = false;
window.addEventListener('beforeunload', (e) => {
  if (grading) e.preventDefault();
});

async function router() {
  const path = location.hash.replace(/^#/, '') || '/';
  const route = routes.find(([re]) => re.test(path));
  if (!route) return go('/');
  const [re, render, opts = {}] = route;
  if (!opts.open && !opts.guest && !state.user) return go('/login');
  if (opts.guest && state.user) return go('/');
  renderNav();
  window.scrollTo(0, 0);
  try {
    await render(path.match(re));
  } catch (err) {
    handleError(err);
  }
  $('#view h1')?.focus?.();
}

function go(path) {
  if (location.hash === `#${path}`) router();
  else location.hash = path;
}

function handleError(err) {
  if (err instanceof ApiError && err.status === 401) {
    state.user = null;
    go('/login');
    return;
  }
  console.error(err);
  toast(err.message || 'Something went wrong.', 'error');
}

async function refreshMe() {
  const me = await api('/me');
  state.user = me.user;
  state.usage = me.usage || null;
}

function renderNav() {
  const nav = $('#nav');
  if (!state.user) {
    mount(nav, html`<a href="#/help">How it works</a>`);
    return;
  }
  mount(
    nav,
    html`<a href="#/">My exams</a>
      <a href="#/help">Help</a>
      <a href="#/account" class="nav-user" title="${state.user.email}">${state.user.name.split(' ')[0]}</a>`,
  );
}

// ---------------------------------------------------------------- auth
function authView(mode) {
  const isSignup = mode === 'signup';
  mount(
    view,
    html`<div class="auth">
      <section class="auth-intro">
        <h1 tabindex="-1">Mark answer sheets in minutes</h1>
        <p class="lead">Set up your exam once: syllabus, marking scheme and your checking instructions. Then photograph each student's answer sheet and get marks for every question, with remarks.</p>
        <ul class="ticks">
          <li>Works with photos from your phone or scanned PDFs</li>
          <li>Follows <em>your</em> marking scheme and instructions</li>
          <li>Class results table with a CSV export for your register</li>
          <li>You can review and correct any mark</li>
        </ul>
      </section>
      <form class="card auth-card" id="auth-form" novalidate>
        <h2>${isSignup ? 'Create your teacher account' : 'Log in'}</h2>
        ${isSignup ? html`<label>Your name<input name="name" autocomplete="name" required /></label>` : ''}
        <label>Email<input name="email" type="email" autocomplete="email" required /></label>
        <label>Password<input name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" minlength="8" required />
          ${isSignup ? html`<small class="muted">At least 8 characters</small>` : ''}</label>
        ${isSignup && state.config.signupCodeRequired
          ? html`<label>School access code<input name="code" required autocomplete="off" /><small class="muted">Ask your school admin for this code.</small></label>`
          : ''}
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary block" type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
        <p class="switch muted">
          ${isSignup ? html`Already have an account? <a href="#/login">Log in</a>` : html`New here? <a href="#/signup">Create an account</a>`}
        </p>
      </form>
    </div>`,
  );

  const form = $('#auth-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    const data = Object.fromEntries(new FormData(form));
    const btn = $('button[type=submit]', form);
    setBusy(btn, true, isSignup ? 'Creating account…' : 'Logging in…');
    try {
      await api(isSignup ? '/auth/signup' : '/auth/login', { method: 'POST', json: data });
      await refreshMe();
      go('/');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      setBusy(btn, false);
    }
  });
}

// ---------------------------------------------------------------- dashboard
async function dashboardView() {
  mount(view, html`<div class="loading">Loading your exams…</div>`);
  const [exams] = await Promise.all([api('/exams'), refreshMe()]);
  const u = state.usage;

  mount(
    view,
    html`<div class="page-head">
        <div>
          <h1 tabindex="-1">My exams</h1>
          <p class="muted">Create an exam once, then mark every student's answer sheet against it.</p>
        </div>
        <a class="btn primary" href="#/exams/new">+ New exam</a>
      </div>
      ${u ? html`<p class="usage muted">Answer sheets marked today: <strong>${u.today}</strong> of ${u.limit}</p>` : ''}
      ${exams.length
        ? html`<div class="exam-grid">
            ${exams.map(
              (e) => html`<article class="card exam-card">
                <a class="exam-link" href="#/exams/${e.id}">
                  <h2>${e.title}</h2>
                  <p class="muted">${[e.subject, e.className].filter(Boolean).join(' · ') || 'No subject set'}${e.totalMarks ? ` · ${e.totalMarks} marks` : ''}</p>
                </a>
                <div class="exam-stats">
                  <span><strong>${e.resultCount}</strong> marked</span>
                  ${e.averagePercent != null ? html`<span>Class average <strong>${e.averagePercent}%</strong></span>` : ''}
                  <span class="muted">Updated ${formatDate(e.updatedAt)}</span>
                </div>
                <div class="actions">
                  <a class="btn primary small" href="#/exams/${e.id}">Mark answer sheets</a>
                  <a class="btn ghost small" href="#/exams/${e.id}/edit">Edit exam</a>
                </div>
              </article>`,
            )}
          </div>`
        : html`<div class="card empty">
            <h2>Welcome, ${state.user.name.split(' ')[0]}! Let's mark your first paper.</h2>
            <ol class="steps">
              <li><strong>Create an exam.</strong> Add the syllabus, marking scheme, question paper and how you want it checked.</li>
              <li><strong>Upload an answer sheet.</strong> Take photos of every page, or upload a scanned PDF.</li>
              <li><strong>Get the marks.</strong> See marks for every question, correct any mark, and export the class list.</li>
            </ol>
            <a class="btn primary" href="#/exams/new">Create your first exam</a>
          </div>`}`,
  );
}

// ---------------------------------------------------------------- exam editor
async function examEditorView(id) {
  let exam = { title: '', subject: '', className: '', totalMarks: '', syllabus: '', scheme: '', extra: '', questionText: '', presets: [], instructions: '', files: [] };
  if (id) {
    mount(view, html`<div class="loading">Loading exam…</div>`);
    exam = await api(`/exams/${id}`);
  }
  const presetValues = new Set(exam.presets);

  mount(
    view,
    html`<a class="back" href="${id ? `#/exams/${id}` : '#/'}">← Back</a>
    <h1 tabindex="-1">${id ? 'Edit exam' : 'New exam'}</h1>
    <p class="muted">The more detail you give, especially in the marking scheme, the more accurate the marks will be.</p>
    <form id="exam-form" novalidate>
      <section class="card">
        <h2><span class="step">1</span> Exam details</h2>
        <label>Exam name <span class="req">*</span>
          <input name="title" required maxlength="200" placeholder="e.g. Class 10 Physics – Unit Test 2" value="${exam.title}" />
        </label>
        <div class="grid-3">
          <label>Subject<input name="subject" placeholder="e.g. Physics" value="${exam.subject}" /></label>
          <label>Class / grade<input name="className" placeholder="e.g. Class 10 B" value="${exam.className}" /></label>
          <label>Total marks<input name="totalMarks" type="number" min="1" step="0.5" placeholder="e.g. 50" value="${exam.totalMarks}" /></label>
        </div>
        <label>Syllabus / topics covered
          <textarea name="syllabus" rows="3" placeholder="e.g. Ch 1 Light – reflection & refraction; Ch 2 Human eye">${exam.syllabus}</textarea>
        </label>
      </section>

      <section class="card">
        <h2><span class="step">2</span> Marking scheme / answer key</h2>
        <p class="hint">Write the expected answer or points for each question and how marks are split. You can paste from your document.</p>
        <textarea name="scheme" rows="10" placeholder="Q1 (2 marks) Define refraction. – bending of light when it passes from one medium to another (2)&#10;Q2 (5 marks) Ray diagram of convex lens – correct rays (2), labels (1), image position (1), nature of image (1)&#10;Q3 (3 marks) Numerical: f = 20 cm, u = -30 cm → v = 60 cm. Formula (1), substitution (1), answer with unit (1)">${exam.scheme}</textarea>
        <label>Anything else the checker should know
          <textarea name="extra" rows="2" placeholder="e.g. Section C has an internal choice: answer any 2 of 3. Q5 accepts any two valid examples.">${exam.extra}</textarea>
        </label>
      </section>

      <section class="card">
        <h2><span class="step">3</span> Question paper</h2>
        <p class="hint">Upload a photo of each page or a PDF. You can also type the questions instead.</p>
        <div id="qp-picker"></div>
        <details ${exam.questionText ? 'open' : ''}>
          <summary>Type or paste the questions (optional)</summary>
          <textarea name="questionText" rows="6" placeholder="Q1. Define refraction. (2)&#10;Q2. Draw a ray diagram for a convex lens… (5)">${exam.questionText}</textarea>
        </details>
      </section>

      <section class="card">
        <h2><span class="step">4</span> How should it be checked?</h2>
        <p class="hint">Tap everything that applies, then add your own instructions.</p>
        <div class="chips">
          ${PRESETS.map(
            ([label, value]) => html`<label class="chip"><input type="checkbox" name="preset" value="${value}" ${presetValues.has(value) ? 'checked' : ''} /> ${label}</label>`,
          )}
        </div>
        <label>Your own instructions
          <textarea name="instructions" rows="3" placeholder="e.g. Accept answers in Hindi or English. Q4: give full marks if any 3 of the 5 points are present.">${exam.instructions}</textarea>
        </label>
      </section>

      <p class="form-error" role="alert" hidden></p>
      <div class="actions sticky-actions">
        <button class="btn primary" type="submit">${id ? 'Save changes' : 'Save exam & start marking'}</button>
        ${id ? html`<button class="btn danger ghost" type="button" id="delete-exam">Delete exam</button>` : ''}
      </div>
    </form>`,
  );

  const picker = new PagePicker($('#qp-picker'), {
    label: 'Add question paper pages',
    hint: 'JPG, PNG or PDF. One photo per page.',
    saved: exam.files.map((fid) => ({ id: fid, url: `/api/exams/${id}/files/${fid}` })),
  });

  const form = $('#exam-form');
  let dirty = false;
  form.addEventListener('input', () => (dirty = true));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    err.hidden = true;
    const showErr = (msg) => {
      err.textContent = msg;
      err.hidden = false;
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
    if (!form.elements.title.value.trim()) return showErr('Please give the exam a name.');
    if (picker.busy) return showErr('Please wait for the pages to finish loading.');
    if (!picker.count() && !form.elements.questionText.value.trim()) {
      return showErr('Please add the question paper: upload photos/PDF or type the questions.');
    }

    const fd = new FormData();
    for (const name of ['title', 'subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'questionText', 'instructions']) {
      fd.append(name, form.elements[name].value);
    }
    fd.append('presets', JSON.stringify($$('input[name=preset]:checked', form).map((c) => c.value)));
    const btn = $('button[type=submit]', form);
    setBusy(btn, true, 'Saving…');
    try {
      const keep = await picker.appendTo(fd, 'questionPaper');
      fd.append('keepFiles', JSON.stringify(keep));
      const saved = await api(id ? `/exams/${id}` : '/exams', { method: id ? 'PUT' : 'POST', form: fd });
      dirty = false;
      toast('Exam saved.', 'success');
      go(`/exams/${saved.id}`);
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 401) return handleError(ex);
      showErr(ex.message);
    } finally {
      setBusy(btn, false);
    }
  });

  $('#delete-exam')?.addEventListener('click', async () => {
    if (!(await confirmDialog('Delete this exam and all its marked results? This cannot be undone.'))) return;
    try {
      await api(`/exams/${id}`, { method: 'DELETE' });
      toast('Exam deleted.');
      go('/');
    } catch (ex) {
      handleError(ex);
    }
  });

  // Warn before leaving with unsaved changes (in-app navigation).
  const guard = (e) => {
    if (dirty && !confirm('You have unsaved changes. Leave without saving?')) {
      e.stopImmediatePropagation();
      history.pushState(null, '', e.oldURL);
      return;
    }
    window.removeEventListener('hashchange', guard, true);
  };
  window.addEventListener('hashchange', guard, true);
}

// ---------------------------------------------------------------- marking
async function markingView(id) {
  mount(view, html`<div class="loading">Loading exam…</div>`);
  const [exam, results] = await Promise.all([api(`/exams/${id}`), api(`/exams/${id}/results`)]);
  await refreshMe();

  mount(
    view,
    html`<a class="back" href="#/">← My exams</a>
    <div class="page-head">
      <div>
        <h1 tabindex="-1">${exam.title}</h1>
        <p class="muted">${[exam.subject, exam.className, exam.totalMarks && `${exam.totalMarks} marks`].filter(Boolean).join(' · ')}</p>
      </div>
      <a class="btn ghost" href="#/exams/${id}/edit">Edit exam setup</a>
    </div>

    <div class="mark-layout">
      <section class="card" id="mark-card">
        <h2>Mark an answer sheet</h2>
        <form id="mark-form" novalidate>
          <div class="grid-2">
            <label>Student name<input name="studentName" autocomplete="off" placeholder="Optional" /></label>
            <label>Roll no.<input name="rollNo" autocomplete="off" placeholder="Optional" /></label>
          </div>
          <p class="hint">Leave these blank to read them from the answer sheet.</p>
          <div id="as-picker"></div>
          <p class="form-error" role="alert" hidden></p>
          <button class="btn primary block big" type="submit" id="mark-btn" disabled>Calculate marks</button>
          ${state.usage ? html`<p class="muted small center" id="usage-line">${state.usage.today} of ${state.usage.limit} answer sheets used today</p>` : ''}
        </form>
      </section>
      <section id="latest"></section>
    </div>

    <section class="card" id="class-results"></section>`,
  );

  const picker = new PagePicker($('#as-picker'), {
    label: "Add the student's answer sheet",
    hint: 'All pages, in order. Phone photos or a PDF.',
    onChange: (n) => {
      const btn = $('#mark-btn');
      btn.disabled = n === 0;
      btn.textContent = n ? `Calculate marks (${n} page${n > 1 ? 's' : ''})` : 'Calculate marks';
    },
  });

  let list = results;
  const renderList = () => renderClassResults(exam, list, (updated) => {
    list = updated;
    renderList();
  });
  renderList();

  $('#mark-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $('.form-error', form);
    err.hidden = true;
    if (picker.busy) return;
    if (!picker.count()) {
      err.textContent = 'Please add the answer sheet pages.';
      err.hidden = false;
      return;
    }
    const fd = new FormData();
    fd.append('studentName', form.elements.studentName.value);
    fd.append('rollNo', form.elements.rollNo.value);
    await picker.appendTo(fd, 'answerSheet');

    const progress = showProgress(picker.count());
    grading = true;
    try {
      const result = await api(`/exams/${id}/grade`, { method: 'POST', form: fd });
      list = [result, ...list];
      renderList();
      renderLatest(result, exam, (updated) => {
        list = list.map((r) => (r.id === updated.id ? updated : r));
        renderList();
      });
      picker.clear();
      form.reset();
      if (state.usage) {
        state.usage.today += 1;
        const line = $('#usage-line');
        if (line) line.textContent = `${state.usage.today} of ${state.usage.limit} answer sheets used today`;
      }
      toast(`Marked: ${fmt(result.totalAwarded)} / ${fmt(result.totalMaximum)}`, 'success');
    } catch (ex) {
      if (ex instanceof ApiError && ex.status === 401) return handleError(ex);
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      grading = false;
      progress.close();
    }
  });
}

function showProgress(pages) {
  const steps = ['Reading the question paper…', `Reading ${pages} answer page${pages > 1 ? 's' : ''}…`, 'Matching answers to questions…', 'Applying your marking scheme…', 'Checking against your instructions…', 'Adding up the marks…'];
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

// Result card with editable marks. onSaved(updatedResult) is called after edits are saved.
function resultCard(r, exam, { onSaved, onDeleted, compact } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'result';

  const draw = () => {
    mount(
      wrap,
      html`<div class="result-head">
        <div>
          <p class="muted small">${exam.title}</p>
          <h2 class="result-name">${r.studentName || 'Unnamed student'}${r.rollNo ? html` <span class="muted">· Roll ${r.rollNo}</span>` : ''}</h2>
          ${r.edited ? html`<span class="badge">Edited by teacher</span>` : ''}
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
            ${(r.questions || []).map(
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
        ${onDeleted ? html`<button type="button" class="btn ghost danger small" data-act="delete">Delete</button>` : ''}
      </div>
      <p class="muted small no-print">${compact ? '' : 'Marks are suggestions. Review them and correct anything you disagree with.'}</p>`,
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
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'edit') setEditing(true);
    if (act === 'cancel') {
      draw();
    }
    if (act === 'print') printNode(wrap);
    if (act === 'save') {
      const questions = $$('.mark-input', wrap).map((i) => ({ awarded: Number(i.value) }));
      setBusy(btn, true, 'Saving…');
      try {
        r = await api(`/results/${r.id}`, { method: 'PATCH', json: { questions } });
        draw();
        onSaved?.(r);
        toast('Marks updated.', 'success');
      } catch (ex) {
        setBusy(btn, false);
        handleError(ex);
      }
    }
    if (act === 'delete') {
      if (!(await confirmDialog(`Delete the result for ${r.studentName || 'this student'}?`))) return;
      try {
        await api(`/results/${r.id}`, { method: 'DELETE' });
        onDeleted?.(r);
        toast('Result deleted.');
      } catch (ex) {
        handleError(ex);
      }
    }
  });

  draw();
  return wrap;
}

function renderLatest(result, exam, onSaved) {
  const box = $('#latest');
  box.replaceChildren();
  const card = document.createElement('div');
  card.className = 'card latest';
  card.append(resultCard(result, exam, { onSaved }));
  box.append(card);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderClassResults(exam, list, setList) {
  const box = $('#class-results');
  if (!box) return;
  if (!list.length) {
    mount(box, html`<h2>Class results</h2><p class="muted">No answer sheets marked yet. Results will appear here, one row per student.</p>`);
    return;
  }
  const pcts = list.map((r) => r.percentage);
  const avg = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const sorted = [...list].sort((a, b) => String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true }) || String(a.studentName).localeCompare(String(b.studentName)));

  mount(
    box,
    html`<div class="page-head">
      <h2>Class results</h2>
      <div class="actions">
        <a class="btn ghost small" href="/api/exams/${exam.id}/results.csv" download>Download CSV / Excel</a>
        <button type="button" class="btn ghost small" id="print-all">Print list</button>
      </div>
    </div>
    <div class="stats">
      <div><span class="muted small">Students</span><strong>${list.length}</strong></div>
      <div><span class="muted small">Class average</span><strong>${fmt(Math.round(avg * 10) / 10)}%</strong></div>
      <div><span class="muted small">Highest</span><strong>${fmt(Math.max(...pcts))}%</strong></div>
      <div><span class="muted small">Lowest</span><strong>${fmt(Math.min(...pcts))}%</strong></div>
    </div>
    <div class="table-wrap" id="class-table">
      <table class="class-table">
        <thead><tr><th>Roll</th><th>Student</th><th class="num">Marks</th><th class="num">%</th><th></th></tr></thead>
        <tbody>
          ${sorted.map(
            (r) => html`<tr>
              <td>${r.rollNo || '–'}</td>
              <td>${r.studentName || 'Unnamed'}${r.edited ? html` <span class="badge">edited</span>` : ''}${r.warnings?.length ? html` <span class="badge warn" title="${r.warnings.join(' ')}">check</span>` : ''}</td>
              <td class="num"><strong>${fmt(r.totalAwarded)}</strong> / ${fmt(r.totalMaximum)}</td>
              <td class="num"><span class="pct ${scoreClass(r.totalAwarded, r.totalMaximum)}">${fmt(r.percentage)}%</span></td>
              <td class="num no-print"><button type="button" class="btn ghost small" data-open="${r.id}">View</button></td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>`,
  );

  $('#print-all').addEventListener('click', () => {
    const node = document.createElement('div');
    mount(node, html`<h2>${exam.title}: class results</h2><p>${[exam.subject, exam.className].filter(Boolean).join(' · ')}</p>`);
    node.append($('#class-table').cloneNode(true));
    printNode(node);
  });

  box.onclick = (e) => {
    const btn = e.target.closest('[data-open]');
    if (!btn) return;
    const r = list.find((x) => x.id === Number(btn.dataset.open));
    if (r) openResultDialog(r, exam, list, setList);
  };
}

function openResultDialog(r, exam, list, setList) {
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog wide';
  const close = document.createElement('button');
  close.className = 'dialog-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '×';
  close.onclick = () => dlg.close();
  dlg.append(
    close,
    resultCard(r, exam, {
      compact: true,
      onSaved: (u) => setList(list.map((x) => (x.id === u.id ? u : x))),
      onDeleted: (d) => {
        dlg.close();
        setList(list.filter((x) => x.id !== d.id));
      },
    }),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  document.body.append(dlg);
  dlg.showModal();
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

// ---------------------------------------------------------------- account
async function accountView() {
  await refreshMe();
  mount(
    view,
    html`<h1 tabindex="-1">Account</h1>
    <section class="card narrow-card">
      <p><strong>${state.user.name}</strong><br /><span class="muted">${state.user.email}</span></p>
      ${state.usage ? html`<p class="muted">Answer sheets marked today: ${state.usage.today} of ${state.usage.limit}</p>` : ''}
      <button class="btn ghost" id="logout">Log out</button>
    </section>
    <section class="card narrow-card">
      <h2>Change password</h2>
      <form id="pw-form" novalidate>
        <label>Current password<input type="password" name="current" autocomplete="current-password" required /></label>
        <label>New password<input type="password" name="next" autocomplete="new-password" minlength="8" required /></label>
        <p class="form-error" role="alert" hidden></p>
        <button class="btn primary" type="submit">Update password</button>
      </form>
    </section>`,
  );
  $('#logout').addEventListener('click', async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    go('/login');
  });
  $('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = $('.form-error', form);
    err.hidden = true;
    const btn = $('button', form);
    setBusy(btn, true, 'Updating…');
    try {
      await api('/auth/password', { method: 'POST', json: Object.fromEntries(new FormData(form)) });
      form.reset();
      toast('Password updated.', 'success');
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      setBusy(btn, false);
    }
  });
}

// ---------------------------------------------------------------- help
function helpView() {
  mount(
    view,
    html`<h1 tabindex="-1">How to use Mark Calculator</h1>
    <div class="help">
      <section class="card">
        <h2>1. Create an exam</h2>
        <p>Click <strong>New exam</strong> and fill in:</p>
        <ul>
          <li><strong>Exam details</strong>: name, subject, class and <em>total marks</em>. The total keeps the marks consistent.</li>
          <li><strong>Marking scheme / answer key</strong>: the expected answer or key points for each question, and how the marks are split. This matters most for accuracy.</li>
          <li><strong>Question paper</strong>: photos of each page or a PDF (or type the questions).</li>
          <li><strong>Checking instructions</strong>: tap options like <em>Check liberally</em>, <em>Marks for diagram alone</em> or <em>Step marks</em>, and add your own.</li>
        </ul>
        <p>You only do this once per exam. It is saved in your account.</p>
      </section>
      <section class="card">
        <h2>2. Mark answer sheets</h2>
        <ul>
          <li>Open the exam and add the student's answer sheet: <strong>Choose files</strong> (photos or PDF) or <strong>Take photo</strong> on a phone.</li>
          <li>Add every page, in order. Use ‹ › to reorder and × to remove a page.</li>
          <li>Optionally type the student's name and roll number. If you leave them blank, they're read from the sheet.</li>
          <li>Click <strong>Calculate marks</strong>. It takes about 30–90 seconds.</li>
        </ul>
      </section>
      <section class="card">
        <h2>3. Review, correct and export</h2>
        <ul>
          <li>Each result shows marks for every question, what the student wrote, and a short remark.</li>
          <li>Anything marked <span class="badge warn">check</span> had unclear handwriting or a missing page. Please look at those.</li>
          <li>Click <strong>Correct marks</strong> to change any mark. The total updates automatically.</li>
          <li>The <strong>Class results</strong> table lists every student. <strong>Download CSV / Excel</strong> gives a sheet for your register, and you can print any result.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Tips for accurate marks</h2>
        <ul>
          <li>Photograph pages flat, in good light, with the whole page in the frame. Avoid shadows and blur.</li>
          <li>Write a clear marking scheme with key points and mark splits for each question.</li>
          <li>Mention choice rules ("answer any 4 of 6") in <em>Anything else the checker should know</em>.</li>
          <li>Always glance over the result. The marks are a strong first check, but you're the examiner.</li>
        </ul>
      </section>
      <section class="card">
        <h2>Privacy</h2>
        <p>Answer sheet photos are used only to calculate the marks and are not stored. Question papers, marking schemes and results are saved to your account so you can reuse them. Other teachers can't see your data.</p>
      </section>
      ${state.user ? '' : html`<p><a class="btn primary" href="#/signup">Create a free account</a></p>`}
    </div>`,
  );
}

// ---------------------------------------------------------------- start
(async function start() {
  try {
    const [config] = await Promise.all([api('/config'), refreshMe()]);
    state.config = config;
  } catch (err) {
    toast(err.message, 'error');
  }
  window.addEventListener('hashchange', router);
  router();
})();


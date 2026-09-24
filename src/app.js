const path = require('path');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const auth = require('./auth');
const { grade, normalize, GradingError, providerName } = require('./grader');

const { HttpError } = auth;
const MAX_FILE_MB = 10;
const EXAM_FIELDS = {
  title: 'title',
  subject: 'subject',
  className: 'class_name',
  totalMarks: 'total_marks',
  syllabus: 'syllabus',
  scheme: 'scheme',
  extra: 'extra',
  questionText: 'question_text',
  instructions: 'instructions',
};

// Identify the real image type from the file's first bytes instead of trusting the browser.
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString() === 'GIF8') return 'image/gif';
  return null;
}

function checkImages(files) {
  return files.map((f) => {
    const mimetype = sniffImage(f.buffer);
    if (!mimetype) throw new HttpError(400, `"${f.originalname}" is not a supported image. Use JPG, PNG, WEBP or PDF.`);
    return { mimetype, buffer: f.buffer };
  });
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function createApp({ db, env = process.env }) {
  const app = express();
  const secureCookies = env.NODE_ENV === 'production';
  const dailyLimit = Number(env.DAILY_GRADING_LIMIT) || 60;
  // Optional cap for the whole website per day (e.g. to stay inside a free AI quota).
  const siteDailyLimit = Number(env.SITE_DAILY_LIMIT) || 0;
  const signupCode = (env.SIGNUP_CODE || '').trim();
  const loginLimiter = auth.rateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  const signupLimiter = auth.rateLimiter({ windowMs: 60 * 60 * 1000, max: 10 });

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 40, fields: 40, fieldSize: 200 * 1024 },
  });

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'script-src': ["'self'", "'wasm-unsafe-eval'"],
          'img-src': ["'self'", 'data:', 'blob:'],
          'worker-src': ["'self'", 'blob:'],
          // Allow plain-http use on a school LAN; hosted deployments are HTTPS anyway.
          'upgrade-insecure-requests': null,
        },
      },
    }),
  );

  app.get('/healthz', (req, res) => res.json({ ok: true, markingConfigured: providerName(env) !== 'none' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use('/vendor/pdfjs', express.static(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build'), { maxAge: '7d' }));

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));

  // Reject cross-site writes (cookies are SameSite=Lax too; this is belt and braces).
  api.use((req, res, next) => {
    if (req.method === 'GET' || !req.headers.origin) return next();
    try {
      if (new URL(req.headers.origin).host === req.headers.host) return next();
    } catch {}
    next(new HttpError(403, 'Request blocked.'));
  });

  api.use(async (req, res, next) => {
    req.user = await auth.sessionUser(db, req);
    next();
  });

  const requireUser = (req, res, next) => (req.user ? next() : next(new HttpError(401, 'Please log in.')));

  const usageToday = async (userId) =>
    (await db.get('SELECT count FROM usage WHERE user_id = ? AND day = ?', userId, today()))?.count || 0;
  const siteUsageToday = async () => (await db.get('SELECT count FROM site_usage WHERE day = ?', today()))?.count || 0;

  // ---------- Auth ----------
  api.get('/config', (req, res) => res.json({ signupCodeRequired: Boolean(signupCode) }));

  api.get('/me', async (req, res) => {
    if (!req.user) return res.json({ user: null });
    const { id, name, email } = req.user;
    res.json({ user: { id, name, email }, usage: { today: await usageToday(id), limit: dailyLimit } });
  });

  api.post('/auth/signup', async (req, res) => {
    if (!signupLimiter(req.ip)) throw new HttpError(429, 'Too many sign-ups from this network. Try again later.');
    const { name, email, password, code } = req.body || {};
    auth.validateSignup({ name, email, password });
    if (signupCode && String(code || '').trim() !== signupCode) throw new HttpError(403, 'The school access code is not correct.');
    const normalized = auth.normalizeEmail(email);
    if (await db.get('SELECT 1 AS x FROM users WHERE email = ?', normalized)) {
      throw new HttpError(409, 'An account with this email already exists. Please log in.');
    }
    const hash = await auth.hashPassword(password);
    const { lastInsertRowid } = await db.run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      String(name).trim().slice(0, 100),
      normalized,
      hash,
    );
    auth.setSessionCookie(res, await auth.createSession(db, lastInsertRowid), secureCookies);
    res.status(201).json({ ok: true });
  });

  api.post('/auth/login', async (req, res) => {
    if (!loginLimiter(req.ip)) throw new HttpError(429, 'Too many login attempts. Please wait 15 minutes.');
    const { email, password } = req.body || {};
    const user = await db.get('SELECT id, password_hash FROM users WHERE email = ?', auth.normalizeEmail(email));
    if (!user || !(await auth.verifyPassword(String(password || ''), user.password_hash))) {
      throw new HttpError(401, 'Email or password is incorrect.');
    }
    auth.setSessionCookie(res, await auth.createSession(db, user.id), secureCookies);
    res.json({ ok: true });
  });

  api.post('/auth/logout', async (req, res) => {
    await auth.destroySession(db, req.user?.token);
    auth.clearSessionCookie(res, secureCookies);
    res.json({ ok: true });
  });

  api.post('/auth/password', requireUser, async (req, res) => {
    const { current, next: newPassword } = req.body || {};
    const row = await db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!(await auth.verifyPassword(String(current || ''), row.password_hash))) throw new HttpError(400, 'Current password is incorrect.');
    if (String(newPassword || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters.');
    const hash = await auth.hashPassword(newPassword);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.user.id);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', req.user.id, auth.sha256(req.user.token));
    res.json({ ok: true });
  });

  // ---------- Exams ----------
  const getExam = async (req) => {
    const exam = await db.get('SELECT * FROM exams WHERE id = ? AND user_id = ?', Number(req.params.id) || 0, req.user.id);
    if (!exam) throw new HttpError(404, 'Exam not found.');
    return exam;
  };

  const examFiles = (examId, withData = false, conn = db) =>
    conn.all(`SELECT id, mimetype${withData ? ', data' : ''} FROM exam_files WHERE exam_id = ? ORDER BY position`, examId);

  const serializeExam = async (e) => ({
    id: e.id,
    title: e.title,
    subject: e.subject,
    className: e.class_name,
    totalMarks: e.total_marks,
    syllabus: e.syllabus,
    scheme: e.scheme,
    extra: e.extra,
    questionText: e.question_text,
    presets: parseJson(e.presets, []),
    instructions: e.instructions,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
    files: (await examFiles(e.id)).map((f) => f.id),
  });

  const examValues = (body) => {
    const values = {};
    for (const [key, col] of Object.entries(EXAM_FIELDS)) values[col] = String(body?.[key] ?? '').slice(0, 30000);
    values.title = values.title.trim().slice(0, 200) || 'Untitled exam';
    const presets = parseJson(body?.presets, []);
    values.presets = JSON.stringify(Array.isArray(presets) ? presets.map(String).slice(0, 20) : []);
    return values;
  };

  const saveFiles = async (t, examId, keepIds, newFiles) => {
    const current = (await examFiles(examId, false, t)).map((f) => f.id);
    const keep = [...new Set(keepIds)].filter((id) => current.includes(id));
    for (const id of current) if (!keep.includes(id)) await t.run('DELETE FROM exam_files WHERE id = ?', id);
    for (const [i, id] of keep.entries()) await t.run('UPDATE exam_files SET position = ? WHERE id = ?', i, id);
    for (const [i, f] of newFiles.entries()) {
      await t.run(
        'INSERT INTO exam_files (exam_id, position, mimetype, data) VALUES (?, ?, ?, ?)',
        examId,
        keep.length + i,
        f.mimetype,
        f.buffer,
      );
    }
  };
  const loadExam = async (id) => serializeExam(await db.get('SELECT * FROM exams WHERE id = ?', id));

  const questionUpload = upload.fields([{ name: 'questionPaper', maxCount: 15 }]);

  api.get('/exams', requireUser, async (req, res) => {
    const rows = await db.all(
      `SELECT e.id, e.title, e.subject, e.class_name, e.total_marks, e.updated_at,
                COUNT(r.id) AS result_count, AVG(r.total_awarded * 100.0 / NULLIF(r.total_maximum, 0)) AS avg_pct
         FROM exams e LEFT JOIN results r ON r.exam_id = e.id
         WHERE e.user_id = ? GROUP BY e.id ORDER BY e.updated_at DESC, e.id DESC`,
      req.user.id,
    );
    res.json(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        subject: r.subject,
        className: r.class_name,
        totalMarks: r.total_marks,
        updatedAt: r.updated_at,
        resultCount: r.result_count,
        averagePercent: r.avg_pct == null ? null : Math.round(r.avg_pct),
      })),
    );
  });

  api.post('/exams', requireUser, questionUpload, async (req, res) => {
    const values = examValues(req.body);
    const files = checkImages(req.files?.questionPaper || []);
    const id = await db.tx(async (t) => {
      const cols = Object.keys(values);
      const { lastInsertRowid } = await t.run(
        `INSERT INTO exams (user_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`,
        req.user.id,
        ...Object.values(values),
      );
      await saveFiles(t, lastInsertRowid, [], files);
      return lastInsertRowid;
    });
    res.status(201).json(await loadExam(id));
  });

  api.get('/exams/:id', requireUser, async (req, res) => res.json(await serializeExam(await getExam(req))));

  api.put('/exams/:id', requireUser, questionUpload, async (req, res) => {
    const exam = await getExam(req);
    const values = examValues(req.body);
    const files = checkImages(req.files?.questionPaper || []);
    const keepList = parseJson(req.body?.keepFiles, []);
    const keep = (Array.isArray(keepList) ? keepList : []).map(Number);
    await db.tx(async (t) => {
      const sets = Object.keys(values).map((c) => `${c} = ?`);
      await t.run(`UPDATE exams SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...Object.values(values), exam.id);
      await saveFiles(t, exam.id, keep, files);
    });
    res.json(await loadExam(exam.id));
  });

  api.delete('/exams/:id', requireUser, async (req, res) => {
    const exam = await getExam(req);
    await db.tx(async (t) => {
      await t.run('DELETE FROM exam_files WHERE exam_id = ?', exam.id);
      await t.run('DELETE FROM results WHERE exam_id = ?', exam.id);
      await t.run('DELETE FROM exams WHERE id = ?', exam.id);
    });
    res.json({ ok: true });
  });

  api.get('/exams/:id/files/:fileId', requireUser, async (req, res) => {
    const exam = await getExam(req);
    const file = await db.get(
      'SELECT mimetype, data FROM exam_files WHERE id = ? AND exam_id = ?',
      Number(req.params.fileId) || 0,
      exam.id,
    );
    if (!file) throw new HttpError(404, 'File not found.');
    res.set('Cache-Control', 'private, max-age=86400').type(file.mimetype).send(Buffer.from(file.data));
  });

  // ---------- Grading & results ----------
  const serializeResult = (r) => ({
    id: r.id,
    examId: r.exam_id,
    studentName: r.student_name,
    rollNo: r.roll_no,
    totalAwarded: r.total_awarded,
    totalMaximum: r.total_maximum,
    edited: Boolean(r.edited),
    createdAt: r.created_at,
    ...parseJson(r.data, {}),
  });

  const saveResultRow = (conn, id, result, edited) =>
    conn.run(
      `UPDATE results SET student_name = ?, roll_no = ?, total_awarded = ?, total_maximum = ?, data = ?, edited = ? WHERE id = ?`,
      result.studentName,
        result.rollNo,
        result.totalAwarded,
        result.totalMaximum,
        JSON.stringify({
          percentage: result.percentage,
          questions: result.questions,
          overallFeedback: result.overallFeedback,
          warnings: result.warnings,
        }),
      edited ? 1 : 0,
      id,
    );

  const answerUpload = upload.fields([{ name: 'answerSheet', maxCount: 30 }]);

  api.post('/exams/:id/grade', requireUser, answerUpload, async (req, res) => {
    const exam = await serializeExam(await getExam(req));
    const answerFiles = checkImages(req.files?.answerSheet || []);
    if (!answerFiles.length) throw new HttpError(400, 'Please upload at least one answer sheet page.');
    const questionFiles = (await examFiles(exam.id, true)).map((f) => ({ mimetype: f.mimetype, buffer: Buffer.from(f.data) }));
    if (!questionFiles.length && !exam.questionText.trim()) {
      throw new HttpError(400, 'This exam has no question paper yet. Edit the exam and add it first.');
    }
    if ((await usageToday(req.user.id)) >= dailyLimit) {
      throw new HttpError(429, `You have reached today's limit of ${dailyLimit} answer sheets. It resets at midnight (UTC).`);
    }
    if (siteDailyLimit && (await siteUsageToday()) >= siteDailyLimit) {
      throw new HttpError(429, "Today's marking limit for this website has been reached. Please try again tomorrow.");
    }

    const result = await grade({ setup: exam, questionFiles, answerFiles }, env);
    const studentName = String(req.body?.studentName || '').trim().slice(0, 120);
    const rollNo = String(req.body?.rollNo || '').trim().slice(0, 60);
    if (studentName) result.studentName = studentName;
    if (rollNo) result.rollNo = rollNo;

    const id = await db.tx(async (t) => {
      const { lastInsertRowid } = await t.run(
        'INSERT INTO results (exam_id, total_awarded, total_maximum, data) VALUES (?, 0, 0, ?)',
        exam.id,
        '{}',
      );
      await saveResultRow(t, lastInsertRowid, result, false);
      await t.run(
        `INSERT INTO usage (user_id, day, count) VALUES (?, ?, 1)
         ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1`,
        req.user.id,
        today(),
      );
      await t.run(
        `INSERT INTO site_usage (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1`,
        today(),
      );
      return lastInsertRowid;
    });
    res.status(201).json(serializeResult(await db.get('SELECT * FROM results WHERE id = ?', id)));
  });

  api.get('/exams/:id/results', requireUser, async (req, res) => {
    const exam = await getExam(req);
    const rows = await db.all('SELECT * FROM results WHERE exam_id = ? ORDER BY created_at DESC, id DESC', exam.id);
    res.json(rows.map(serializeResult));
  });

  const getResult = async (req) => {
    const row = await db.get(
      'SELECT r.* FROM results r JOIN exams e ON e.id = r.exam_id WHERE r.id = ? AND e.user_id = ?',
      Number(req.params.id) || 0,
      req.user.id,
    );
    if (!row) throw new HttpError(404, 'Result not found.');
    return row;
  };

  // Teacher corrections: change marks per question, student name or roll number.
  api.patch('/results/:id', requireUser, async (req, res) => {
    const row = await getResult(req);
    const current = serializeResult(row);
    const edits = Array.isArray(req.body?.questions) ? req.body.questions : [];
    const questions = current.questions.map((q, i) => ({
      ...q,
      awarded: edits[i]?.awarded ?? q.awarded,
      counted: edits[i]?.counted ?? q.counted,
      comment: edits[i]?.comment ?? q.comment,
    }));
    const exam = await db.get('SELECT total_marks FROM exams WHERE id = ?', row.exam_id);
    const updated = normalize(
      {
        ...current,
        questions,
        studentName: req.body?.studentName ?? current.studentName,
        rollNo: req.body?.rollNo ?? current.rollNo,
        warnings: current.warnings.filter((w) => !w.includes('capped')),
      },
      exam.total_marks || current.totalMaximum,
    );
    await saveResultRow(db, row.id, updated, true);
    res.json(serializeResult(await db.get('SELECT * FROM results WHERE id = ?', row.id)));
  });

  api.delete('/results/:id', requireUser, async (req, res) => {
    const row = await getResult(req);
    await db.run('DELETE FROM results WHERE id = ?', row.id);
    res.json({ ok: true });
  });

  api.get('/exams/:id/results.csv', requireUser, async (req, res) => {
    const exam = await getExam(req);
    const results = (await db.all('SELECT * FROM results WHERE exam_id = ? ORDER BY id', exam.id))
      .map(serializeResult)
      .sort(
        (a, b) =>
          String(a.rollNo).localeCompare(String(b.rollNo), undefined, { numeric: true }) ||
          String(a.studentName).localeCompare(String(b.studentName)),
      );
    const labels = [];
    for (const r of results) for (const q of r.questions || []) if (!labels.includes(q.question)) labels.push(q.question);
    const lines = [['Roll No', 'Student', ...labels.map((l) => `Q${l}`), 'Total', 'Out of', 'Percentage'].map(csvCell).join(',')];
    for (const r of results) {
      const byLabel = Object.fromEntries((r.questions || []).map((q) => [q.question, q.counted ? q.awarded : `(${q.awarded})`]));
      lines.push(
        [r.rollNo, r.studentName, ...labels.map((l) => byLabel[l] ?? ''), r.totalAwarded, r.totalMaximum, `${r.percentage}%`]
          .map(csvCell)
          .join(','),
      );
    }
    const filename = `${exam.title.replace(/[^\w\- ]+/g, '').trim() || 'results'}.csv`;
    res.set('Content-Disposition', `attachment; filename="${filename}"`).type('text/csv').send(`﻿${lines.join('\r\n')}\r\n`);
  });

  api.use((req, res, next) => next(new HttpError(404, 'Not found.')));
  app.use('/api', api);

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof HttpError || err instanceof GradingError) return res.status(err.status).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE' ? `Each page must be under ${MAX_FILE_MB} MB.` : 'Too many pages uploaded at once.';
      return res.status(400).json({ error: msg });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp, sniffImage };

// Stateless web server: no accounts and no database. Each request carries the exam setup,
// question paper and answer sheet; the marks are returned and nothing is stored.
const path = require('path');
const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const { grade, GradingError, providerName, maxPages, requestTooLarge, selfTest } = require('./grader');

const MAX_FILE_MB = 10;
const SETUP_FIELDS = ['subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'questionText', 'instructions', 'answerText'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

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

const today = () => new Date().toISOString().slice(0, 10);

// The visitor's address (used only for the per-device daily limit, never stored).
function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || req.ip || '').trim();
}

// Daily counters kept in memory only (they reset when the server restarts).
function dailyCounter() {
  let day = today();
  const counts = new Map();
  return {
    get(key) {
      if (day !== today()) {
        day = today();
        counts.clear();
      }
      return counts.get(key) || 0;
    },
    add(key, n = 1) {
      counts.set(key, Math.max(0, this.get(key) + n));
    },
  };
}

// Limits how many markings run at once (free AI tiers allow very few parallel requests).
function semaphore(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active < max && queue.length) {
      active += 1;
      queue.shift()();
    }
  };
  return async (fn) => {
    await new Promise((resolve) => {
      queue.push(resolve);
      next();
    });
    try {
      return await fn();
    } finally {
      active -= 1;
      next();
    }
  };
}

function createApp({ env = process.env } = {}) {
  const app = express();
  const perDeviceLimit = Number(env.PER_DEVICE_DAILY_LIMIT) || 15;
  const siteDailyLimit = Number(env.SITE_DAILY_LIMIT) || 0;
  const concurrent = Number(env.MAX_CONCURRENT) || (providerName(env) === 'github' ? 2 : 4);
  const usage = dailyCounter();
  const limitSlots = semaphore(concurrent);

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 45, fields: 30, fieldSize: 200 * 1024 },
  });

  // Hosts like Render sit behind more than one proxy; trust them so req.ip is the visitor's address.
  app.set('trust proxy', true);
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
  // Always revalidate the site's own files so a new deploy shows up immediately.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      setHeaders: (res, file) => res.setHeader('Cache-Control', /\.(svg|png)$/.test(file) ? 'public, max-age=86400' : 'no-cache'),
    }),
  );
  app.use(
    '/vendor/pdfjs',
    express.static(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'legacy', 'build'), { maxAge: '7d' }),
  );

  const api = express.Router();

  // Only accept marking requests from this website itself.
  api.use((req, res, next) => {
    if (req.method === 'GET' || !req.headers.origin) return next();
    try {
      if (new URL(req.headers.origin).host === req.headers.host) return next();
    } catch {}
    next(new HttpError(403, 'Request blocked.'));
  });

  const provider = providerName(env);
  // Images larger than this add upload time without helping the model read them.
  // Groq/OpenRouter models count image size heavily against small free per-minute limits.
  const imageMaxSide = provider === 'gemini' ? 2200 : ['groq', 'openrouter', 'custom'].includes(provider) ? 1280 : 1600;

  api.get('/config', (req, res) =>
    res.json({ maxPages: maxPages(env), perDeviceLimit, imageMaxSide, usedToday: usage.get(`ip:${clientIp(req)}`) }),
  );

  // Connection test for the site owner: open /api/selftest in a browser. Uses a few AI requests,
  // so it counts towards the per-device daily limit.
  api.get('/selftest', async (req, res) => {
    const ipKey = `ip:${clientIp(req)}`;
    if (usage.get(ipKey) >= perDeviceLimit) throw new HttpError(429, 'Daily limit reached for this device.');
    usage.add(ipKey);
    res.set('Cache-Control', 'no-store').json(await selfTest(env));
  });

  api.post(
    '/grade',
    upload.fields([
      { name: 'syllabusFiles', maxCount: 10 },
      { name: 'schemeFiles', maxCount: 15 },
      { name: 'questionPaper', maxCount: 15 },
      { name: 'answerSheet', maxCount: 30 },
    ]),
    async (req, res) => {
      const setup = {};
      for (const key of SETUP_FIELDS) setup[key] = String(req.body?.[key] ?? '').slice(0, 30000);
      const presets = parseJson(req.body?.presets, []);
      setup.presets = Array.isArray(presets) ? presets.map(String).slice(0, 20) : [];

      const files = {
        syllabusFiles: checkImages(req.files?.syllabusFiles || []),
        schemeFiles: checkImages(req.files?.schemeFiles || []),
        questionFiles: checkImages(req.files?.questionPaper || []),
        answerFiles: checkImages(req.files?.answerSheet || []),
      };
      if (!files.answerFiles.length && !setup.answerText.trim()) {
        throw new HttpError(400, "Please add the student's answer sheet: photos, a PDF, or typed answers.");
      }
      if (!files.questionFiles.length && !setup.questionText.trim() && !files.schemeFiles.length && !setup.scheme.trim()) {
        throw new HttpError(400, 'Please add the question paper (or a marking scheme that includes the questions).');
      }
      const tooBig = requestTooLarge({ setup, ...files }, env);
      if (tooBig) throw new HttpError(413, tooBig);
      const pageLimit = maxPages(env);
      const pageCount = Object.values(files).reduce((n, list) => n + list.length, 0);
      if (pageCount > pageLimit) {
        throw new HttpError(
          400,
          `At most ${pageLimit} page images can be read at a time. You added ${pageCount}. Remove some pages, or type the syllabus, scheme or questions instead of uploading photos.`,
        );
      }

      const ipKey = `ip:${clientIp(req)}`;
      if (usage.get(ipKey) >= perDeviceLimit) {
        throw new HttpError(429, `You've marked ${perDeviceLimit} answer sheets today, which is the daily limit per device. Please try again tomorrow.`);
      }
      if (siteDailyLimit && usage.get('site') >= siteDailyLimit) {
        throw new HttpError(429, "Today's marking limit for this website has been reached. Please try again tomorrow.");
      }
      usage.add(ipKey);
      usage.add('site');

      let result;
      try {
        result = await limitSlots(() => grade({ setup, ...files }, env));
      } catch (err) {
        // A failed marking doesn't count towards the limits.
        usage.add(ipKey, -1);
        usage.add('site', -1);
        throw err;
      }
      const studentName = String(req.body?.studentName || '').trim().slice(0, 120);
      const rollNo = String(req.body?.rollNo || '').trim().slice(0, 60);
      if (studentName) result.studentName = studentName;
      if (rollNo) result.rollNo = rollNo;
      res.json(result);
    },
  );

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
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  return app;
}

module.exports = { createApp, sniffImage };

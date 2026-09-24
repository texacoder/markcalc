require('dotenv').config();
const path = require('path');
const express = require('express');
const multer = require('multer');
const { grade, GradingError } = require('./src/grader');

const MAX_FILE_MB = 10;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const TEXT_FIELDS = ['subject', 'className', 'totalMarks', 'syllabus', 'scheme', 'extra', 'instructions', 'questionText'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_TYPES.has(file.mimetype)) cb(null, true);
    else cb(new GradingError(`"${file.originalname}" is not a supported image (use JPG, PNG or WEBP).`));
  },
});

function createApp() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  app.post(
    '/api/grade',
    upload.fields([
      { name: 'questionPaper', maxCount: 10 },
      { name: 'answerSheet', maxCount: 20 },
    ]),
    async (req, res, next) => {
      try {
        const setup = {};
        for (const key of TEXT_FIELDS) setup[key] = String(req.body?.[key] ?? '').slice(0, 20000);
        const questionFiles = req.files?.questionPaper || [];
        const answerFiles = req.files?.answerSheet || [];

        if (!answerFiles.length) throw new GradingError('Please upload at least one answer sheet image.');
        if (!questionFiles.length && !setup.questionText.trim()) {
          throw new GradingError('Please upload the question paper or type the questions.');
        }

        res.json(await grade({ setup, questionFiles, answerFiles }));
      } catch (err) {
        next(err);
      }
    },
  );

  app.use((err, req, res, next) => {
    if (err instanceof GradingError) return res.status(400).json({ error: err.message });
    if (err instanceof multer.MulterError) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each image must be under ${MAX_FILE_MB} MB.` : 'Upload failed: too many files.';
      return res.status(400).json({ error: msg });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong while calculating marks. Please try again.' });
  });

  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 3000;
  createApp().listen(port, () => console.log(`Mark calculator running at http://localhost:${port}`));
}

module.exports = { createApp };

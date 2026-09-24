require('dotenv').config({ quiet: true });
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { providerName, checkProvider } = require('./src/grader');

const port = Number(process.env.PORT) || 3000;
const dbUrl = process.env.DATABASE_URL || 'file:./data/markcalc.db';

(async () => {
  if (providerName(process.env) === 'none') {
    console.warn('WARNING: no GITHUB_MODELS_TOKEN, GEMINI_API_KEY or OPENAI_API_KEY set. Marking will fail until one is configured.');
  }
  if (process.env.RENDER && dbUrl.startsWith('file:')) {
    console.warn('WARNING: using a local database file on Render. Without a disk, data is lost on restart. Set DATABASE_URL to your Neon (postgresql://...) or Turso database.');
  }

  const db = await openDb({ url: dbUrl, authToken: process.env.DATABASE_AUTH_TOKEN }).catch((err) => {
    throw new Error(`Could not open the database (${err.message}). Check DATABASE_URL and DATABASE_AUTH_TOKEN.`);
  });
  const server = createApp({ db }).listen(port, () => {
    const safeUrl = dbUrl.split('?')[0].replace(/\/\/[^@/]*@/, '//***@');
    console.log(`Mark calculator running at http://localhost:${port} (database: ${safeUrl})`);
  });
  // Marking several pages can take a few minutes.
  server.requestTimeout = 10 * 60 * 1000;

  checkProvider().then(({ ok, message }) => (ok ? console.log(`Marking: ${message}`) : console.error(`Marking: ${message}`)));

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
})().catch((err) => {
  console.error('Failed to start:', err.message);
  process.exit(1);
});

require('dotenv').config({ quiet: true });
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const port = Number(process.env.PORT) || 3000;
const dbFile = process.env.DATABASE_FILE || './data/markcalc.db';

if (!process.env.OPENAI_API_KEY && process.env.MOCK_GRADER !== '1') {
  console.warn('WARNING: OPENAI_API_KEY is not set. Marking will fail until it is configured.');
}

const db = openDb(dbFile);
const server = createApp({ db }).listen(port, () => {
  console.log(`Mark calculator running at http://localhost:${port} (database: ${dbFile})`);
});
// Grading several pages can take a few minutes.
server.requestTimeout = 10 * 60 * 1000;

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

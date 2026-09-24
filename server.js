require('dotenv').config({ quiet: true });
const { createApp } = require('./src/app');
const { checkProvider } = require('./src/grader');

const port = Number(process.env.PORT) || 3000;

const server = createApp().listen(port, () => {
  console.log(`Mark calculator running at http://localhost:${port}`);
});
// Marking several pages can take a few minutes.
server.requestTimeout = 10 * 60 * 1000;

checkProvider().then(({ ok, message }) => (ok ? console.log(`Marking: ${message}`) : console.error(`Marking: ${message}`)));

const shutdown = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

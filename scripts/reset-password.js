// Usage: npm run reset-password -- teacher@school.com NewPassword123
require('dotenv').config({ quiet: true });
const { openDb } = require('../src/db');
const { hashPassword, normalizeEmail } = require('../src/auth');

(async () => {
  const [email, password] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error('Usage: npm run reset-password -- <email> <new password (8+ chars)>');
    process.exit(1);
  }
  const db = await openDb({ url: process.env.DATABASE_URL, authToken: process.env.DATABASE_AUTH_TOKEN });
  const user = await db.get('SELECT id FROM users WHERE email = ?', normalizeEmail(email));
  if (!user) {
    console.error('No teacher with that email.');
    process.exit(1);
  }
  await db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(password), user.id);
  await db.run('DELETE FROM sessions WHERE user_id = ?', user.id);
  console.log(`Password updated for ${email}.`);
  db.close();
})();

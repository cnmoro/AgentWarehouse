#!/usr/bin/env node
'use strict';
// Create or update a login.   npm run set-user
// Remove a login.             npm run set-user -- --remove someone@example.com
const readline = require('readline');
const { hashPassword, normalizeEmail, loadUsers, saveUsers } = require('../lib/auth');

const MIN_LENGTH = 12;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.startsWith(question)) rl.output.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main() {
  const users = loadUsers();
  const args = process.argv.slice(2);

  if (args[0] === '--remove') {
    const email = normalizeEmail(args[1]);
    if (!users[email]) return console.error(`No user ${email}`);
    delete users[email];
    saveUsers(users);
    return console.log(`Removed ${email}. Their open sessions end within 10 seconds.`);
  }

  const email = normalizeEmail(await ask('Email: '));
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('That does not look like an email address.');

  const password = await ask(`Password (min ${MIN_LENGTH} chars): `, { hidden: true });
  if (password.length < MIN_LENGTH) throw new Error(`Password must be at least ${MIN_LENGTH} characters.`);
  if (password.toLowerCase().includes(email.split('@')[0])) throw new Error('Password must not contain the email name.');
  const again = await ask('Repeat password: ', { hidden: true });
  if (again !== password) throw new Error('Passwords do not match.');

  users[email] = { hash: await hashPassword(password), updated: new Date().toISOString() };
  saveUsers(users);
  console.log(`Saved ${email}. Any sessions signed in with an older password end within 10 seconds.`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

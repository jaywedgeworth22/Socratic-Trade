const fs = require('fs');
const content = fs.readFileSync('src/lib/scheduler.ts', 'utf8');

let newContent = content.replace(
  'for (const userId of listUsers()) {',
  'for (const userId of listUsers()) {\n      signal?.throwIfAborted();'
);

newContent = newContent.replace(
  'for (const run of dueRuns) {',
  'for (const run of dueRuns) {\n      signal?.throwIfAborted();'
);

// also in the early loop
newContent = newContent.replace(
  'for (const { userId, account } of accountUsers) {',
  'for (const { userId, account } of accountUsers) {\n      signal?.throwIfAborted();'
);

fs.writeFileSync('src/lib/scheduler.ts', newContent);

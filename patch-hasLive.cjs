const fs = require('fs');
const content = fs.readFileSync('src/lib/db-execution.ts', 'utf8');

const oldCode = `    const rows = database
      .prepare("SELECT value FROM settings WHERE key = ? OR key LIKE ?")
      .all(\`strategy_run_lock:\${userId}\`, \`strategy_run_lock:\${userId}:%\`) as Array<{ value: string }>;`;

const newCode = `    // Optimized index scan: replaces \`key = ? OR key LIKE ?\` which caused a full table scan.
    // \`:\` is ASCII 58, \`;\` is ASCII 59, so \`< ...;\` cleanly bounds the exact key and all \`:\` prefixed subkeys.
    const rows = database
      .prepare("SELECT value FROM settings WHERE key >= ? AND key < ?")
      .all(\`strategy_run_lock:\${userId}\`, \`strategy_run_lock:\${userId};\`) as Array<{ value: string }>;`;

if (content.includes(oldCode)) {
  fs.writeFileSync('src/lib/db-execution.ts', content.replace(oldCode, newCode));
  console.log("Success");
} else {
  console.log("Failed to find oldCode");
}

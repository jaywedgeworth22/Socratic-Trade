const fs = require('fs');
const content = fs.readFileSync('src/lib/scheduler.ts', 'utf8');

let newContent = content.replace(
  '__tickSentryCheckInId?: string;',
  '__tickSentryCheckInId?: string;\n  __tickAbortController?: AbortController;'
);

newContent = newContent.replace(
  'tickGuardHost.__tickSentryCheckInId = undefined;',
  'tickGuardHost.__tickSentryCheckInId = undefined;\n  tickGuardHost.__tickAbortController = undefined;'
);

newContent = newContent.replace(
  'tickGuardHost.__tickStartedAtMs = Date.now();',
  'tickGuardHost.__tickStartedAtMs = Date.now();\n  tickGuardHost.__tickAbortController = new AbortController();'
);

newContent = newContent.replace(
  'const checkInId = tickGuardHost.__tickSentryCheckInId;',
  'if (tickGuardHost.__tickAbortController) {\n    tickGuardHost.__tickAbortController.abort(new Error("Scheduler tick watchdog timeout"));\n  }\n  const checkInId = tickGuardHost.__tickSentryCheckInId;'
);

// update tickInner definition
newContent = newContent.replace(
  'async function tickInner(): Promise<void> {',
  'async function tickInner(signal?: AbortSignal): Promise<void> {'
);

// update tickInner call
newContent = newContent.replace(
  'await tickInner();',
  'await tickInner(tickGuardHost.__tickAbortController?.signal);'
);

fs.writeFileSync('src/lib/scheduler.ts', newContent);

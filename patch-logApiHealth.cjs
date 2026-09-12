const fs = require('fs');
const content = fs.readFileSync('src/lib/db-health.ts', 'utf8');

const replacement = `
type ApiHealthLogOpts = {
  service: string;
  ok: boolean;
  latencyMs?: number;
  errorText?: string;
  keySource?: string;
  userId?: string;
  quotaResetAt?: string;
  soft?: boolean;
};

const apiHealthBuffer: ApiHealthLogOpts[] = [];
let apiHealthFlushTimeout: ReturnType<typeof setTimeout> | null = null;

export function flushApiHealthBuffer(): void {
  if (apiHealthFlushTimeout) {
    clearTimeout(apiHealthFlushTimeout);
    apiHealthFlushTimeout = null;
  }
  if (apiHealthBuffer.length === 0) return;
  const batch = apiHealthBuffer.splice(0, apiHealthBuffer.length);
  try {
    const db = getDb();
    
    // Compute derived values outside transaction
    const processed = batch.map(opts => {
      const now = new Date().toISOString();
      const id = randomUUID();
      const keySource = opts.keySource ?? null;
      const userId = opts.userId ?? null;
      let errorText = opts.errorText ?? null;
      const filingApiAuthSoft =
        opts.service === "filingapi" && !opts.ok && isFilingApiAuthErrorText(errorText);
      if (!opts.ok && errorText && (opts.soft || filingApiAuthSoft || isSoftHealthFailure(errorText))) {
        if (!errorText.startsWith(HEALTH_SOFT_FAILURE_PREFIX)) {
          errorText = \`\${HEALTH_SOFT_FAILURE_PREFIX}\${errorText}\`;
        }
      } else if (!opts.ok && errorText && isTransientHealthFailure(errorText)) {
        if (!errorText.startsWith(HEALTH_TRANSIENT_FAILURE_PREFIX)) {
          errorText = \`\${HEALTH_TRANSIENT_FAILURE_PREFIX}\${errorText}\`;
        }
      }
      return { ...opts, now, id, keySource, userId, errorText, isSoft: isSoftHealthFailure(errorText ?? "") };
    });

    db.transaction(() => {
      const insertRow = db.prepare(\`INSERT INTO api_health_log (id, service, ts, ok, latency_ms, error_text, key_source, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)\`);
      const updatePattern = db.prepare(\`INSERT INTO api_health_error_patterns
               (id, service, fingerprint, error_text, first_seen, last_seen, count, key_source)
             VALUES (?, ?, ?, ?, ?, ?, 1, ?)
             ON CONFLICT(service, fingerprint, key_source) DO UPDATE SET
               last_seen = excluded.last_seen,
               count = count + 1\`);
      const deleteCap = db.prepare(\`DELETE FROM api_health_log
           WHERE service = ? AND key_source IS ?
             AND id NOT IN (
               SELECT id FROM api_health_log
               WHERE service = ? AND key_source IS ?
               ORDER BY ts DESC, rowid DESC
               LIMIT \${HEALTH_LOG_LANE_CAP}
             )\`);

      const lanesToPrune = new Set<string>();

      for (const p of processed) {
        insertRow.run(p.id, p.service, p.now, p.ok ? 1 : 0, p.latencyMs ?? null, p.errorText, p.keySource, p.userId);
        lanesToPrune.add(\`\${p.service}::\${p.keySource ?? ""}\`);

        if (!p.ok && p.errorText) {
          const normalized = p.errorText.trim().toLowerCase().replace(/\\s+/g, " ");
          const fingerprint = createHash("sha256").update(normalized).digest("hex").slice(0, 12);
          const patternId = randomUUID();
          const patternKeySource = p.keySource ?? "";
          updatePattern.run(patternId, p.service, fingerprint, p.errorText, p.now, p.now, patternKeySource);
        }
      }

      for (const lane of lanesToPrune) {
        const [service, keySourceRaw] = lane.split("::");
        const keySource = keySourceRaw === "" ? null : keySourceRaw;
        deleteCap.run(service, keySource, service, keySource);
      }
    })();

    // Post-transaction operations
    for (const p of processed) {
      const streakKey = hardStreakStartSettingKey(p.service, p.keySource, p.userId);
      if (p.ok || p.isSoft) {
        clearHardStreakStart(streakKey);
      }

      if (
        !p.ok &&
        p.errorText &&
        !RAG_SERVICES_WITH_OWN_ALERTING.has(p.service) &&
        !isIntentionalOffHealthService(p.service)
      ) {
        if (p.isSoft && !p.quotaResetAt) {
          // pure expected-limit with no known reset: no automatic alert
        } else {
          const lane = getLaneHealth(p.service, p.keySource, p.userId);
          if (p.quotaResetAt || lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES) {
            const escalationWindowMs = transientEscalationWindowMs();
            const streakStartedMs = lane.streakStartedTs ? Date.parse(lane.streakStartedTs) : NaN;
            const transientBlip =
              !p.quotaResetAt &&
              lane.reason === HEALTH_REASON_CONSECUTIVE_FAILURES &&
              lane.transientStreak &&
              (!Number.isFinite(streakStartedMs) || Date.now() - streakStartedMs < escalationWindowMs);
            void alertConnectionFailure(p.service, p.keySource, p.userId, p.errorText, {
              skipSentry: p.isSoft || /429|rate limit/i.test(p.errorText),
              cooldownUntil:
                p.quotaResetAt ??
                (transientBlip
                  ? new Date(
                      (Number.isFinite(streakStartedMs) ? streakStartedMs : Date.now()) + escalationWindowMs
                    ).toISOString()
                  : undefined),
              transientBlip
            });
          }
        }
      }
    }
  } catch (e) {
    // Health logging must never throw — swallow all errors
    // console.error(e);
  }
}

export function logApiHealth(opts: ApiHealthLogOpts): void {
  apiHealthBuffer.push(opts);
  if (!apiHealthFlushTimeout) {
    apiHealthFlushTimeout = setTimeout(flushApiHealthBuffer, 5000);
  }
}
`;

// replace from export function logApiHealth down to the try catch end
const lines = content.split('\n');
const startIdx = lines.findIndex(l => l.startsWith('export function logApiHealth(opts: {'));
const endIdx = lines.findIndex((l, i) => i > startIdx && l === '  } catch {');
const finalEndIdx = lines.findIndex((l, i) => i > endIdx && l === '}');

if (startIdx !== -1 && finalEndIdx !== -1) {
  lines.splice(startIdx, finalEndIdx - startIdx + 1, replacement);
  fs.writeFileSync('src/lib/db-health.ts', lines.join('\n'));
} else {
  console.log("Could not find boundaries");
}

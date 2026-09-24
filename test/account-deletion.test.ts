import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { userIdForEmail } from "../src/lib/auth/identity";

const vectorMocks = vi.hoisted(() => ({
  purgePrivateVectorRecordsForUser: vi.fn()
}));

vi.mock("../src/lib/vector-db", () => ({
  managedVectorLedgerAuthority: vi.fn(),
  getCurrentVectorProviderAuthority: vi.fn(),
  purgePrivateVectorRecordsForUser: vectorMocks.purgePrivateVectorRecordsForUser
}));

beforeAll(() => {
  process.env.DATABASE_URL = `file:${join(tmpdir(), `agentic-account-deletion-${randomUUID()}.db`)}`;
});

beforeEach(() => {
  vectorMocks.purgePrivateVectorRecordsForUser.mockReset();
  vectorMocks.purgePrivateVectorRecordsForUser.mockResolvedValue({ ids: [], contentHashes: [], deleted: 0 });
});

const confirmation = (email: string) => ({
  typedEmail: email,
  typedPhrase: "DELETE MY ACCOUNT",
  deleteAppData: true,
  deleteBrokerConnections: true,
  understandBrokerPositionsRemain: true,
  understandProviderRevocation: true,
  understandCanSignInAgain: true
});

describe("account deletion", () => {
  it("requires preparation and deletes only the signed-in user's private app data", async () => {
    const db = await import("../src/lib/db");
    const oauth = await import("../src/lib/mcp-oauth");
    const deletion = await import("../src/lib/account-deletion");

    const emailA = "delete-me@example.com";
    const userA = userIdForEmail(emailA);
    const userB = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;

    db.upsertUserApiKey(userA, "openai", "sk-user-a");
    db.upsertUserApiKey(userB, "openai", "sk-user-b");
    db.upsertConnectedAccount({
      id: `acct-${userA}`,
      userId: userA,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-DELETE",
      label: "Paper Delete",
      isActive: true
    });
    db.upsertConnectedAccount({
      id: `acct-${userB}`,
      userId: userB,
      broker: "alpaca",
      environment: "paper",
      accountNumber: "PA-KEEP",
      label: "Paper Keep",
      isActive: true
    });
    oauth.setMcpOAuthTokens(userA, { accessToken: "token-a", tokenType: "Bearer" });
    oauth.setMcpOAuthTokens(userB, { accessToken: "token-b", tokenType: "Bearer" });

    db.getDb()
      .prepare("INSERT INTO chat_turns (id, user_id, role, text, citations, created_at) VALUES (?, ?, 'user', ?, '[]', ?)")
      .run(randomUUID(), userA, "private question", new Date().toISOString());
    db.getDb()
      .prepare(
        `INSERT INTO learned_context (id, user_id, scope, kind, subject, value, source, origin, risk_tier, confidence, contributor_user_id, asserted_at)
         VALUES (?, ?, 'shared', 'fact', 'AAPL', 'private strategy signal', 'inferred', 'chat', 'fact', 0.7, ?, ?)`
      )
      .run(randomUUID(), userA, userA, new Date().toISOString());
    db.getDb()
      .prepare(
        `INSERT INTO learned_context_pending (id, user_id, scope, kind, subject, value, source, origin, risk_tier, created_at, status)
         VALUES (?, ?, 'private', 'fact', 'AAPL', 'pending strategy signal awaiting approval', 'inferred', 'chat', 'risk', ?, 'pending')`
      )
      .run(randomUUID(), userA, new Date().toISOString());

    await expect(deletion.confirmAndDeleteAccount({ userId: userA, email: emailA, body: confirmation(emailA) }))
      .rejects.toThrow("Prepare account deletion first.");

    const prepared = deletion.prepareAccountDeletion({ userId: userA, email: emailA });
    expect(prepared.prepared).toBe(true);
    expect(prepared.connectedAccounts).toHaveLength(1);

    // The scope preview's per-table counts must surface pending learned-context items awaiting
    // approval (app/console/settings/danger.tsx warns the user these are discarded on deletion).
    const previewBeforeDelete = deletion.getAccountDeletionPreview({ userId: userA, email: emailA });
    expect(previewBeforeDelete.counts.learned_context_pending).toBe(1);

    const result = await deletion.confirmAndDeleteAccount({ userId: userA, email: emailA, body: confirmation(emailA) });
    expect(result.ok).toBe(true);

    expect(db.listConnectedAccounts(userA)).toHaveLength(0);
    expect(db.getUserApiKey(userA, "openai")).toBeUndefined();
    expect(oauth.getStoredMcpOAuthTokens(userA)).toBeUndefined();
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM chat_turns WHERE user_id = ?").get(userA)).toMatchObject({ count: 0 });
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM learned_context WHERE user_id = ? OR contributor_user_id = ?").get(userA, userA)).toMatchObject({ count: 0 });
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM learned_context_pending WHERE user_id = ?").get(userA)).toMatchObject({ count: 0 });

    expect(db.listConnectedAccounts(userB)).toHaveLength(1);
    expect(db.getUserApiKey(userB, "openai")?.apiKey).toBe("sk-user-b");
    expect(oauth.getStoredMcpOAuthTokens(userB)?.accessToken).toBe("token-b");

    const auditRows = db.getDb().prepare("SELECT subject_hash, counts_json FROM account_deletion_audit").all() as Array<{ subject_hash: string; counts_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].subject_hash).not.toContain(userA);
    expect(auditRows[0].subject_hash).not.toContain(emailA);
    expect(auditRows[0].counts_json).toContain("connected_accounts");
    expect(db.getDb().prepare("SELECT COUNT(*) AS count FROM account_deletion_requests WHERE user_id = ?").get(userA)).toMatchObject({ count: 0 });
  });

  it("purges the per-user LLM budget reservation settings row (deletion sweep coverage)", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "reservation-delete@example.com";
    const userId = userIdForEmail(email);
    const key = `llm_budget_reservation:${userId}`;
    // Seed a leftover reservation row (as if a run crashed without releasing it).
    db.getDb()
      .prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(key, JSON.stringify({ reservations: [] }), new Date().toISOString());
    const count = () => (db.getDb().prepare("SELECT COUNT(*) AS c FROM settings WHERE key = ?").get(key) as { c: number }).c;
    expect(count()).toBe(1);

    deletion.prepareAccountDeletion({ userId, email });
    const result = await deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) });
    expect(result.ok).toBe(true);
    expect(count()).toBe(0); // the sweep deleted the reservation row
  });

  it("keeps local data and the durable request retryable when provider purge fails", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "provider-purge-retry@example.com";
    const userId = userIdForEmail(email);
    db.upsertUserApiKey(userId, "openai", "sk-still-present");
    deletion.prepareAccountDeletion({ userId, email });
    vectorMocks.purgePrivateVectorRecordsForUser.mockRejectedValueOnce(new Error("synthetic provider verification failure"));

    await expect(deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) }))
      .rejects.toThrow("synthetic provider verification failure");

    expect(db.getUserApiKey(userId, "openai")?.apiKey).toBe("sk-still-present");
    expect(db.getDb().prepare(`
      SELECT status FROM account_deletion_requests WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1
    `).get(userId)).toEqual({ status: "prepared" });
  });

  it("purges only the subject's managed-vector receipts and durable provider usage", async () => {
    const dbModule = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const db = dbModule.getDb();
    const emailA = "vector-delete@example.com";
    const userA = userIdForEmail(emailA);
    const userB = `u_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const now = new Date().toISOString();

    const seed = (userId: string) => {
      const commitId = `commit-${randomUUID()}`;
      const vectorId = `vector-${randomUUID()}`;
      const attemptId = `attempt-${randomUUID()}`;
      db.prepare(`
        INSERT INTO vector_ingest_commits (
          id, tenant_scope, user_id, source, accession, document_key, content_version,
          retrieval_metadata_version, parser_revision,
          embed_revision, expected_vectors, state, attempt_token, attempt_generation,
          created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, 'private-note', ?, ?, 'v1', 'metadata-v1', 'v1', 'v1', 1, 'committed', ?, 1, ?, ?, ?)
      `).run(commitId, `private:${userId}`, userId, `accession-${userId}`, `accession-${userId}`, `token-${commitId}`, now, now, now);
      db.prepare(`
        INSERT INTO vector_document_heads (tenant_scope, source, accession, commit_id, updated_at)
        VALUES (?, 'private-note', ?, ?, ?)
      `).run(`private:${userId}`, `accession-${userId}`, commitId, now);
      db.prepare(`
        INSERT INTO vector_document_versions (
          commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
        ) VALUES (?, ?, 'private-note', ?, ?, NULL, ?)
      `).run(commitId, `private:${userId}`, `accession-${userId}`, now, now);
      db.prepare(`
        INSERT INTO vector_reconcile_observations (
          commit_id, fingerprint, observation_count, first_observed_at, last_observed_at
        ) VALUES (?, 'fingerprint', 1, ?, ?)
      `).run(commitId, now, now);
      db.prepare(`
        INSERT INTO chunk_occurrences (
          vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
          tenant_scope, content_version, commit_id, receipt_state, created_at
        ) VALUES (?, 'hash', 'AAPL', 'private-note', ?, 'body', 1, ?, ?, 'v1', ?, 'committed', ?)
      `).run(vectorId, `accession-${userId}`, now, `private:${userId}`, commitId, now);
      db.prepare(`
        INSERT INTO provider_dispatch_attempts (
          id, authority_id, provider, operation, credential_ref, user_id, units,
          estimated_cost_usd, status, created_at, dispatched_at, completed_at, updated_at
        ) VALUES (?, 'test-authority', 'voyage', 'embed', 'credential', ?, 1, 0, 'succeeded', ?, ?, ?, ?)
      `).run(attemptId, userId, now, now, now, now);
      db.prepare(`
        INSERT INTO provider_usage_outbox (
          id, attempt_id, provider, operation, credential_ref, user_id, outcome,
          requests, estimated_cost_usd, occurred_at, created_at
        ) VALUES (?, ?, 'voyage', 'embed', 'credential', ?, 'succeeded', 1, 0, ?, ?)
      `).run(`outbox-${randomUUID()}`, attemptId, userId, now, now);
      return { commitId };
    };

    const a = seed(userA);
    const b = seed(userB);
    deletion.prepareAccountDeletion({ userId: userA, email: emailA });
    expect((await deletion.confirmAndDeleteAccount({
      userId: userA,
      email: emailA,
      body: confirmation(emailA)
    })).ok).toBe(true);

    for (const table of ["vector_ingest_commits", "provider_dispatch_attempts", "provider_usage_outbox"]) {
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userA)).toEqual({ count: 0 });
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`).get(userB)).toEqual({ count: 1 });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(a.commitId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(b.commitId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_document_heads WHERE commit_id = ?").get(a.commitId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_document_heads WHERE commit_id = ?").get(b.commitId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_document_versions WHERE commit_id = ?").get(a.commitId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_document_versions WHERE commit_id = ?").get(b.commitId)).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_reconcile_observations WHERE commit_id = ?").get(a.commitId)).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_reconcile_observations WHERE commit_id = ?").get(b.commitId)).toEqual({ count: 1 });
  });

  it("preserves shared corpus receipts while deleting the same user's private generation", async () => {
    const dbModule = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const db = dbModule.getDb();
    const userId = "local";
    const email = process.env.PRIMARY_USER_EMAIL || "mail@jays.services";
    const now = new Date().toISOString();
    const sharedContentHash = `shared-hash-${randomUUID()}`;
    const privateOnlyContentHash = `private-hash-${randomUUID()}`;
    const insertDocumentChunk = db.prepare(`
      INSERT INTO document_chunks (content_hash, symbol, source, chunk_id, created_at)
      VALUES (?, 'AAPL', 'scope-delete-test', 'shared-chunk', ?)
    `);
    insertDocumentChunk.run(sharedContentHash, now);
    insertDocumentChunk.run(privateOnlyContentHash, now);
    const seedCommit = (commitId: string, tenantScope: string, documentKey: string, contentHash: string) => {
      db.prepare(`
        INSERT INTO vector_ingest_commits (
          id, tenant_scope, user_id, source, accession, document_key, content_version,
          retrieval_metadata_version, parser_revision, embed_revision, expected_vectors,
          state, attempt_token, attempt_generation, created_at, updated_at, committed_at
        ) VALUES (?, ?, ?, 'scope-delete-test', ?, ?, 'v1', 'metadata-v1', 'v1', 'v1', 1,
          'committed', ?, 1, ?, ?, ?)
      `).run(commitId, tenantScope, userId, documentKey, documentKey, `token-${commitId}`, now, now, now);
      db.prepare(`
        INSERT INTO vector_document_heads (tenant_scope, source, accession, commit_id, updated_at)
        VALUES (?, 'scope-delete-test', ?, ?, ?)
      `).run(tenantScope, documentKey, commitId, now);
      db.prepare(`
        INSERT INTO vector_document_versions (
          commit_id, tenant_scope, source, document_key, valid_from, valid_to, updated_at
        ) VALUES (?, ?, 'scope-delete-test', ?, ?, NULL, ?)
      `).run(commitId, tenantScope, documentKey, now, now);
      db.prepare(`
        INSERT INTO chunk_occurrences (
          vector_id, content_hash, symbol, source, accession, section, ordinal, accepted_at,
          tenant_scope, content_version, commit_id, receipt_state, created_at
        ) VALUES (?, ?, 'AAPL', 'scope-delete-test', ?, 'body', 1, ?, ?, 'v1', ?, 'committed', ?)
      `).run(`vector-${commitId}`, contentHash, documentKey, now, tenantScope, commitId, now);
    };
    const publicCommit = `public-${randomUUID()}`;
    const privateSharedCommit = `private-shared-${randomUUID()}`;
    const privateOnlyCommit = `private-only-${randomUUID()}`;
    seedCommit(publicCommit, "shared:operator", `public-doc-${randomUUID()}`, sharedContentHash);
    seedCommit(privateSharedCommit, `private:${userId}`, `private-shared-doc-${randomUUID()}`, sharedContentHash);
    seedCommit(privateOnlyCommit, `private:${userId}`, `private-only-doc-${randomUUID()}`, privateOnlyContentHash);
    // Simulate a retry after provider deletion succeeded but before local deletion: provider
    // inventory is now empty, so local durable receipts must still drive source-text erasure.
    vectorMocks.purgePrivateVectorRecordsForUser.mockResolvedValueOnce({
      ids: [],
      contentHashes: [],
      deleted: 0
    });

    deletion.prepareAccountDeletion({ userId, email });
    await deletion.confirmAndDeleteAccount({
      userId,
      email,
      body: {
        ...confirmation(email),
        confirmLocalOperator: true,
        localOperatorPhrase: "DELETE LOCAL OPERATOR ACCOUNT"
      }
    });

    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits WHERE id = ?").get(publicCommit))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(publicCommit))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE content_hash = ?").get(sharedContentHash))
      .toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits WHERE id = ?").get(privateSharedCommit))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(privateSharedCommit))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM vector_ingest_commits WHERE id = ?").get(privateOnlyCommit))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM chunk_occurrences WHERE commit_id = ?").get(privateOnlyCommit))
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM document_chunks WHERE content_hash = ?").get(privateOnlyContentHash))
      .toEqual({ count: 0 });
  });

  it("blocks final deletion while order placement or reconciliation is in flight", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "blocked-delete@example.com";
    const userId = userIdForEmail(email);

    db.getDb()
      .prepare(
        `INSERT INTO trade_proposals (id, run_id, account_number, created_at, proposal, decision, status, user_id)
         VALUES (?, ?, 'ACCT-BLOCK', ?, ?, ?, 'placing', ?)`
      )
      .run(randomUUID(), randomUUID(), new Date().toISOString(), JSON.stringify({ symbol: "AAPL", side: "buy" }), JSON.stringify({ approved: true, reasons: [] }), userId);

    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO order_replacements (
        id, user_id, account_number, original_order_id, symbol, side, original_type,
        original_quantity, original_filled_quantity, replacement_ref_id, status, created_at, updated_at
      ) VALUES (?, ?, 'ACCT-BLOCK', 'original-order', 'AAPL', 'sell', 'limit', 10, 0, ?, 'replacement_claiming', ?, ?)
    `).run(randomUUID(), userId, randomUUID(), now, now);

    deletion.prepareAccountDeletion({ userId, email });
    expect(deletion.getAccountDeletionBlockers(userId).activeReplacements).toBe(1);
    await expect(deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) }))
      .rejects.toThrow("Account deletion is blocked by in-flight trading activity.");
  });

  it("blocks final deletion while a mobile command is in flight (queued/running)", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "blocked-mobile@example.com";
    const userId = userIdForEmail(email);

    // A running mobile command whose worker still holds the payload — deleting the row mid-flight
    // would let it keep mutating policy/watchlists, so it must block deletion.
    const now = new Date().toISOString();
    db.getDb()
      .prepare(
        `INSERT INTO mobile_commands (id, user_id, command_type, status, payload, created_at, queued_at, updated_at)
         VALUES (?, ?, 'run_strategy', 'running', '{}', ?, ?, ?)`
      )
      .run(randomUUID(), userId, now, now, now);

    expect(deletion.getAccountDeletionBlockers(userId).activeMobileCommands).toBe(1);

    deletion.prepareAccountDeletion({ userId, email });
    await expect(deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) }))
      .rejects.toThrow("Account deletion is blocked by in-flight trading activity.");

    // A finished command (succeeded) no longer blocks — the worker is done with the payload.
    db.getDb().prepare("UPDATE mobile_commands SET status = 'succeeded' WHERE user_id = ?").run(userId);
    expect(deletion.getAccountDeletionBlockers(userId).activeMobileCommands).toBe(0);
  });

  it("fences pre-deletion user writes and keeps an active operation as a deletion blocker", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const fence = await import("../src/lib/user-write-fence");
    const email = "write-fence@example.com";
    const userId = userIdForEmail(email);
    const claim = fence.acquireUserOperationClaim(userId, "delayed-chat-test");
    const staleEpoch = claim.epoch;

    deletion.prepareAccountDeletion({ userId, email });
    expect(deletion.getAccountDeletionBlockers(userId).activeUserOperations).toBe(1);
    await expect(deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) }))
      .rejects.toThrow("Account deletion is blocked by in-flight trading activity.");
    expect(() => fence.runWithUserWriteEpoch(userId, staleEpoch, () => {
      db.getDb().prepare("INSERT INTO chat_turns (id, user_id, role, text, citations, created_at) VALUES (?, ?, 'assistant', 'late', '[]', ?)")
        .run(randomUUID(), userId, new Date().toISOString());
    })).toThrow("User write epoch changed during account deletion.");

    fence.releaseUserOperationClaim(claim);
    expect(deletion.getAccountDeletionBlockers(userId).activeUserOperations).toBe(0);
    expect((await deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).ok).toBe(true);
    expect(() => fence.runWithUserWriteEpoch(userId, staleEpoch, () => undefined))
      .toThrow("User write epoch changed during account deletion.");
  });

  it("uses one ownership registry to fence and erase every user-scoped internal setting family", async () => {
    const dbModule = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "internal-settings-delete@example.com";
    const userId = userIdForEmail(email);
    const now = new Date().toISOString();
    const keys = [
      `providerTier:status:${userId}`,
      `providerTier:lastCheckAt:${userId}`,
      `risk:hwm:${userId}:ACCOUNT:broker`,
      `risk:hwm-obs:${userId}:ACCOUNT:broker`,
      `risk:sod:${userId}:ACCOUNT:broker:2026-07-14`,
      `learning_review:lastFingerprint:${userId}`,
      `learning_review:legacySeedDone:${userId}`,
      `last_auto_tune_at:${userId}:account-id`,
      `regime:current:${userId}`,
      `regime:macro-unavailable-notified:${userId}`,
      `congress_score_verdict:${userId}`,
      `reflection_signature:${userId}:ACCOUNT`,
      `model_rotation:${userId}:account-id:green`,
      `stale_limit_order_alert:${userId}:account-id:order-id:30`,
      `subMinimumOrderAlertSent:${userId}:ACCOUNT:AAPL`,
      `usageLimitAlert:lastSent:${userId}:pinecone:query:daily`,
      `recoverable_issue:${userId}:hash`,
      `last_macro_sent:${userId}`,
      `healthAlertSent:massive:user:${userId}`,
      `vectorStore:connectionAlert:pinecone:user:${userId}`
    ];
    const database = dbModule.getDb();
    const insert = database.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, '{}', ?)");
    for (const key of keys) insert.run(key, now);

    expect(deletion.getAccountDeletionCounts(userId).settings).toBe(keys.length);
    deletion.prepareAccountDeletion({ userId, email });
    expect(() => database.prepare("UPDATE settings SET value = 'late' WHERE key = ?").run(keys[0]))
      .toThrow("account-write-fenced");

    expect((await deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).ok).toBe(true);
    expect((database.prepare(`
      SELECT COUNT(*) AS count FROM settings
      WHERE account_setting_matches_subject(key, account_subject_token(?)) = 1
    `).get(userId) as { count: number }).count).toBe(0);
    expect(() => insert.run(`providerTier:status:${userId}`, new Date().toISOString()))
      .toThrow("account-write-fenced");
  });

  it("halts every connected account atomically when deletion is prepared", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "multi-account-delete@example.com";
    const userId = userIdForEmail(email);
    const accountIds = [`acct-${randomUUID()}`, `acct-${randomUUID()}`];
    for (const [index, accountId] of accountIds.entries()) {
      db.upsertConnectedAccount({
        id: accountId,
        userId,
        broker: "alpaca",
        environment: "paper",
        accountNumber: `MULTI-${index}`,
        label: `Multi ${index}`,
        isActive: index === 0
      });
      const policy = db.getPolicy(userId, accountId);
      db.setPolicy({ ...policy, systemState: "active" }, userId, accountId);
    }

    deletion.prepareAccountDeletion({ userId, email });

    const rows = db.getDb().prepare(`
      SELECT connected_account_id, policy, system_state
      FROM account_strategy_state
      WHERE user_id = ? ORDER BY connected_account_id
    `).all(userId) as Array<{ connected_account_id: string; policy: string; system_state: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.system_state === "halted")).toBe(true);
    expect(rows.every((row) => JSON.parse(row.policy).systemState === "halted")).toBe(true);
  });

  it("keeps old sessions fenced and only reopens after a verified fresh login time", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const fence = await import("../src/lib/user-write-fence");
    const email = "fresh-login-recreate@example.com";
    const userId = userIdForEmail(email);

    deletion.prepareAccountDeletion({ userId, email });
    expect((await deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).ok).toBe(true);
    const completed = db.getDb().prepare(`
      SELECT updated_at FROM account_write_fences WHERE subject_token = account_subject_token(?)
    `).get(userId) as { updated_at: string };

    expect(() => fence.captureUserWriteEpoch(userId)).toThrow("Account deletion is completed");
    expect(() => db.getDb().prepare(`
      INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', '{}', ?)
    `).run(randomUUID(), userId, new Date().toISOString())).toThrow("account-write-fenced");
    expect(() => fence.resolveAuthenticatedAccountGeneration(userId, ""))
      .toThrow("fresh provider sign-in");
    expect(() => fence.resolveAuthenticatedAccountGeneration(userId, completed.updated_at))
      .toThrow("predates account deletion");
    const { resolveRequestUser, AUTHENTICATED_EMAIL_HEADER } = await import("../src/lib/request-user");
    const {
      AUTHENTICATED_IDENTITY_SOURCE_HEADER,
      AUTHENTICATED_IDENTITY_SOURCES,
      AUTHENTICATED_SESSION_ISSUED_AT_HEADER
    } = await import("../src/lib/auth/strip-identity");
    expect(() => resolveRequestUser(new Request("https://example.test/api/dashboard", { headers: {
      [AUTHENTICATED_EMAIL_HEADER]: email,
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession
    } }))).toThrow("fresh provider sign-in");
    const freshLoginAt = new Date(Date.parse(completed.updated_at) + 1_000).toISOString();
    expect(() => resolveRequestUser(new Request("https://example.test/api/dashboard", { headers: {
      [AUTHENTICATED_EMAIL_HEADER]: email,
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess
    } }))).toThrow("fresh provider sign-in");
    expect(() => resolveRequestUser(new Request("https://example.test/api/dashboard", { headers: {
      [AUTHENTICATED_EMAIL_HEADER]: email,
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.cloudflareAccess,
      [AUTHENTICATED_SESSION_ISSUED_AT_HEADER]: completed.updated_at
    } }))).toThrow("predates account deletion");
    const recreatedUserId = resolveRequestUser(new Request("https://example.test/api/dashboard", { headers: {
      [AUTHENTICATED_EMAIL_HEADER]: email,
      [AUTHENTICATED_IDENTITY_SOURCE_HEADER]: AUTHENTICATED_IDENTITY_SOURCES.authJsSession,
      [AUTHENTICATED_SESSION_ISSUED_AT_HEADER]: freshLoginAt
    } })).userId;
    expect(recreatedUserId).not.toBe(userId);
    expect(fence.resolveAuthenticatedAccountGeneration(userId, freshLoginAt)).toBe(recreatedUserId);
    // A later fresh login does not remove the prior cutoff. Replaying the old timestamp remains
    // rejected, while the new account has a clean write epoch.
    expect(() => fence.resolveAuthenticatedAccountGeneration(userId, completed.updated_at))
      .toThrow("predates account deletion");
    expect(() => fence.captureUserWriteEpoch(userId)).toThrow("Account deletion is completed");
    expect(fence.captureUserWriteEpoch(recreatedUserId)).toEqual({ generation: "none", status: "none" });
    expect(() => db.getDb().prepare(`
      INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', '{}', ?)
    `).run(randomUUID(), userId, new Date().toISOString())).toThrow("account-write-fenced");
    expect(() => db.getDb().prepare(`
      INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, 'policy', '{}', ?)
    `).run(randomUUID(), recreatedUserId, new Date().toISOString())).not.toThrow();
  });

  it("does not let terminal billing-unknown history permanently block deletion", async () => {
    const db = await import("../src/lib/db");
    const deletion = await import("../src/lib/account-deletion");
    const email = "unknown-dispatch@example.com";
    const userId = userIdForEmail(email);
    const now = new Date().toISOString();
    db.getDb().prepare(`
      INSERT INTO provider_dispatch_attempts (
        id, authority_id, provider, operation, credential_ref, user_id, units,
        estimated_cost_usd, status, created_at, dispatched_at, completed_at, updated_at
      ) VALUES (?, 'test', 'pinecone', 'query', 'credential', ?, 1, 0, 'unknown', ?, ?, ?, ?)
    `).run(randomUUID(), userId, now, now, now, now);

    deletion.prepareAccountDeletion({ userId, email });
    expect(deletion.getAccountDeletionBlockers(userId).activeProviderDispatches).toBe(0);
    expect((await deletion.confirmAndDeleteAccount({ userId, email, body: confirmation(email) })).ok).toBe(true);
  });
});

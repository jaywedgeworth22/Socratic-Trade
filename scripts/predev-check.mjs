#!/usr/bin/env node
// Pre-`npm run dev` warning: if SECRETS_SOURCE is unset AND neither the bootstrap handoff file
// nor an explicit INFISICAL_* identity is present, tell the operator how to use the Infisical
// runner. Never fail the dev boot (we still want `npm run dev` to work for tests / UI-only work
// where no credentials are needed). Added 2026-09-18 with the "no .env files anywhere" cutover.
//
// This is `predev` in package.json. npm only invokes it before `npm run dev`, not before
// `npm run dev:secrets` (which sets SECRETS_SOURCE=infisical before reaching here).

// ESM imports, not require(): this is a .mjs file, where `require` is undefined (ReferenceError on
// every plain `npm run dev`) and @typescript-eslint/no-require-imports fails the lint gate.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function exists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

const source = (process.env.SECRETS_SOURCE ?? "").trim().toLowerCase();
const hasInfisicalIdentity =
  !!process.env.INFISICAL_CLIENT_ID ||
  !!process.env.INFISICAL_TOKEN ||
  !!process.env.INFISICAL_ST_CLIENT_ID ||
  !!process.env.INFIISICAL_ST_CLIENT_ID;

const home = os.homedir();
const handoff =
  exists(path.join(home, ".secrets/global-api-keys")) ||
  exists(path.join(home, ".secrets/global-api-keys.env"));

if (source === "infisical") {
  // The runner is in charge. No warning.
  process.exit(0);
}

if (hasInfisicalIdentity || handoff) {
  // The operator has SOME path to Infisical configured but chose `npm run dev` plain. They
  // probably want dev:secrets but might just be running tests. Tell them once.
  console.warn(
    "\n[predev] SECRETS_SOURCE is not 'infisical'.\n" +
    "  You're running `npm run dev` plain. The Infisical runner is the canonical start path:\n" +
    "    npm run dev:secrets\n" +
    "  Plain `npm run dev` works for UI-only work and tests; if you need API keys to load,\n" +
    "  switch to dev:secrets (see docs/secrets.md).\n"
  );
  process.exit(0);
}

// No Infisical identity, no handoff file. Loud one-time notice — but don't fail, because
// tests and pure-UI development must still boot.
console.warn(
  "\n[predev] No Infisical identity configured.\n" +
  "  Plain `npm run dev` will boot without credentials. To load keys via the Infisical runner:\n" +
  "    1. Add the bootstrap identity to ~/.secrets/global-api-keys (chmod 600), OR\n" +
  "    2. Set INFISICAL_CLIENT_ID + INFISICAL_CLIENT_SECRET in the env, OR\n" +
  "    3. Use `npm run dev:secrets` which launches scripts/infisical-run.mjs.\n" +
  "  See docs/secrets.md.\n"
);
process.exit(0);
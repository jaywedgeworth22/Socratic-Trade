/**
 * CI guard: production code paths must never load `.env.local`, `.env.*`, or dotenv/yaml
 * loader modules. Owner directive 2026-09-18 (strict Infisical, no .env files anywhere).
 *
 * What this guard CATCHES (intentional):
 *   - The dev-only loader in `src/lib/db-api-keys.ts` reading `.env.local` from process.cwd()
 *     (removed in this PR). The `~/.secrets/global-api-keys` handoff paths are owner-side
 *     identity storage and are NOT covered by this guard.
 *   - A future PR adding `import "dotenv"`, `dotenv-flow`, `dotenv/config`, etc. to a
 *     production source file.
 *   - A future PR adding `import yaml from "js-yaml"` plus a parse of a `.env.yml`/`.env.yaml`
 *     for credentials (operator config is fine — we just don't parse .env-shaped YAML).
 *
 * What this guard DELIBERATELY allows:
 *   - `scripts/*` reading operator-only secret files in the operator worktree (none today).
 *   - `tests/*` setting `process.env.X = "..."` directly for test fixtures.
 *   - The `dotenv` directory's own value as a `devDependency` (eslint picks it up transitively;
 *     we just ban importing it from `src/` or `app/`).
 *   - `js-yaml` for non-credential config (`litestream.coolify.yml`, `litestream.yml`,
 *     `next.config.mjs`, workflow files) — the rule is `js-yaml AND a .env* file`, not bare
 *     `js-yaml`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.cwd();
const SCAN_DIRS = ["src", "app"] as const;
const SCAN_EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try { s = statSync(full); } catch { continue; }
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === ".next" || entry === "data") continue;
      out.push(...listSourceFiles(full));
    } else if (s.isFile()) {
      const dot = entry.lastIndexOf(".");
      if (dot >= 0 && SCAN_EXT.has(entry.slice(dot))) out.push(full);
    }
  }
  return out;
}

function readAll(): string[] {
  return SCAN_DIRS.flatMap(listSourceFiles);
}

// Patterns that mean "this file loads an .env-shaped file or a dotenv/yaml parser for secrets."
const DOTENV_IMPORT = /\b(?:import|require)\s*\(?\s*["'](?:dotenv(?:-[^"'/]+)?|dotenv-flow|dotenv\/config)["']\)?/;
const YAML_ENV_PARSE = /\b(?:safeLoad|load|parse|readFileSync)\s*\([^)]*(?:\.env\.(?:ya?ml|json)|process\.cwd\(\)\s*\+\s*["']\.env)/;
const CWD_ENV_LOCAL = /resolve\s*\(\s*process\.cwd\(\)\s*,\s*["']\.env\.local["']\s*\)/;

describe("CI guard: no .env files anywhere in production code paths", () => {
  const files = readAll();

  it("has at least one source file to scan (sanity)", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("does not import dotenv / dotenv-flow / dotenv/config from src/ or app/", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (DOTENV_IMPORT.test(text)) offenders.push(relative(REPO, f));
    }
    expect(offenders, `dotenv import is not allowed in src/ or app/:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not parse a .env.yml / .env.yaml / .env.json credential file", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (YAML_ENV_PARSE.test(text)) offenders.push(relative(REPO, f));
    }
    expect(offenders, `.env.yml/.yaml/.json credential parse is not allowed:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not resolve(process.cwd(), '.env.local') in src/ or app/ (db-api-keys had this)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (CWD_ENV_LOCAL.test(text)) offenders.push(relative(REPO, f));
    }
    expect(offenders, `resolve(process.cwd(), '.env.local') is not allowed:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("does not string-literal '.env.local' as a path in src/ or app/", () => {
    // Belt-and-suspenders: catches any other pattern (template literals, plus string concat, etc).
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (/["'`]\.env\.local["'`]/.test(text) || /\.env\.local/.test(text)) {
        offenders.push(relative(REPO, f));
      }
    }
    expect(
      offenders,
      `'.env.local' string-literal in src/ or app/:\n${offenders.join("\n")}`
    ).toEqual([]);
  });
});
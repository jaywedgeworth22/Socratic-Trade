#!/usr/bin/env node
/**
 * Sync MARKETING_VERSION + CURRENT_PROJECT_VERSION in ios/project.yml from a single
 * source of truth.
 *
 * Why: `xcodegen generate` rewrites ios/Socratic Trade.xcodeproj/project.pbxproj FROM
 * ios/project.yml — so the project's true CFBundleShortVersionString / CFBundleVersion
 * are whatever this file says at the moment of regeneration.  When these drift between
 * project.yml and the last build shipped to ASC, the next `xcodegen generate` silently
 * restores the stale value, and a build can ship with the wrong version number without
 * anyone noticing until the dashboard / TestFlight shows the old one (2026-08-13 drift
 * incident: project.yml was 1.0.1 while ASC had shipped through 1.0.6).
 *
 * `--sync-project-version` (Apple's stock flag) is a silent no-op for this app: it seds
 * project.pbxproj, and `xcodegen generate` runs AFTER it and rewrites the pbxproj from
 * THIS file, restoring the stale value.
 *
 * Usage (called by ship-testflight.sh and any local dry-run):
 *
 *   node scripts/ios-fleet/sync-project-yml.mjs \
 *     --project-yaml ios/project.yml \
 *     --marketing 1.0.8 \
 *     --build     202608132022
 *
 * If --marketing or --build are omitted, the script reads them from
 * ios/Socratic Trade.xcodeproj/project.pbxproj (which is the LAST GENERATED state — the
 * one xcodegen produced from the previous project.yml).  This makes the script safe to
 * run BEFORE `xcodegen generate` (idempotent: same values back in), and safe to run AFTER
 * (as a sanity check).
 *
 * Exit codes:
 *   0  project.yml updated (or already in sync)
 *   1  usage / missing files / unexpected error
 *   2  dry-run detected a drift and exited without writing
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PROJECT_YAML_FLAG = "--project-yaml";
const PBXPROJ_FLAG = "--pbxproj";
const MARKETING_FLAG = "--marketing";
const BUILD_FLAG = "--build";
const DRY_RUN_FLAG = "--dry-run";
const HELP_FLAG = "--help";

function parseArgs(argv) {
  const opts = { projectYaml: null, pbxproj: null, marketing: null, build: null, dryRun: false, help: false };
  // A value-taking flag with no value (or with the NEXT flag swallowed as its
  // value) must be a loud usage error — otherwise `undefined` slips through and
  // either disables the version checks or gets written into project.yml.
  const takeValue = (flag, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case PROJECT_YAML_FLAG:
        opts.projectYaml = takeValue(PROJECT_YAML_FLAG, i); i++;
        break;
      case PBXPROJ_FLAG:
        opts.pbxproj = takeValue(PBXPROJ_FLAG, i); i++;
        break;
      case MARKETING_FLAG:
        opts.marketing = takeValue(MARKETING_FLAG, i); i++;
        break;
      case BUILD_FLAG:
        opts.build = takeValue(BUILD_FLAG, i); i++;
        break;
      case DRY_RUN_FLAG:
        opts.dryRun = true;
        break;
      case HELP_FLAG:
        opts.help = true;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

function help() {
  return [
    "sync-project-yml.mjs — keep ios/project.yml's version fields in sync with the source of truth.",
    "",
    "Flags:",
    `  ${PROJECT_YAML_FLAG} <path>   Path to project.yml.  Default: ios/project.yml`,
    `  ${PBXPROJ_FLAG} <path>      Path to the generated pbxproj (read-only source).`,
    "                            Default: ios/Socratic Trade.xcodeproj/project.pbxproj",
    `  ${MARKETING_FLAG} <ver>     Override MARKETING_VERSION (e.g. 1.0.8).`,
    "                            If omitted, the value is read from the pbxproj.",
    `  ${BUILD_FLAG} <ver>         Override CURRENT_PROJECT_VERSION (e.g. 202608132022).`,
    "                            If omitted, the value is read from the pbxproj.",
    `  ${DRY_RUN_FLAG}             Do not write; exit 2 if drift is detected.`,
    `  ${HELP_FLAG}                Show this help.`,
    "",
    "When called WITHOUT overrides, the script is idempotent: same values flow back in.",
    "When called WITH overrides, the script enforces them in project.yml — exactly what",
    "ship-testflight.sh needs right before `xcodegen generate` runs."
  ].join("\n");
}

/** Pull MARKETING_VERSION + CURRENT_PROJECT_VERSION out of the Xcode pbxproj.  Both keys
 *  appear as `MARKETING_VERSION = "1.0.8";` and `CURRENT_PROJECT_VERSION = "202608132022";`
 *  in the buildSettings block.  We pull the FIRST match per key, which is always the target
 *  setting (xcodegen emits a single target's settings for this app). */
export function readPbxprojVersion(pbxprojText) {
  const find = (key) => {
    const m = new RegExp(`${key}\\s*=\\s*"?([^";]+)"?;`).exec(pbxprojText);
    return m ? m[1] : null;
  };
  return { marketing: find("MARKETING_VERSION"), build: find("CURRENT_PROJECT_VERSION") };
}

/** Replace the MARKETING_VERSION and CURRENT_PROJECT_VERSION lines in project.yml text.
 *  The replacement is anchored on the keys (which are stable across xcodegen regenerations)
 *  and preserves indentation + trailing whitespace.  Returns the patched text; returns null
 *  if neither key was found (the project.yml is missing the field — caller decides whether
 *  to fail loud or skip). */
export function patchProjectYaml(yamlText, marketing, build) {
  let out = yamlText;
  let found = { marketing: false, build: false };
  if (marketing != null) { // != null covers undefined as well
    const re = /^(\s*MARKETING_VERSION:\s*")[^"]*(".*)$/m;
    if (re.test(out)) {
      out = out.replace(re, (_, pre, post) => `${pre}${marketing}${post}`);
      found.marketing = true;
    }
  }
  if (build != null) { // != null covers undefined as well
    const re = /^(\s*CURRENT_PROJECT_VERSION:\s*")[^"]*(".*)$/m;
    if (re.test(out)) {
      out = out.replace(re, (_, pre, post) => `${pre}${build}${post}`);
      found.build = true;
    }
  }
  return { text: out, found };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(help());
    return 0;
  }

  const projectYaml = resolve(opts.projectYaml ?? "ios/project.yml");
  const pbxproj = resolve(
    opts.pbxproj ?? "ios/Socratic Trade.xcodeproj/project.pbxproj"
  );

  if (!existsSync(projectYaml)) {
    console.error(`project.yml not found: ${projectYaml}`);
    return 1;
  }

  let marketing = opts.marketing;
  let build = opts.build;
  if ((marketing === null || build === null) && existsSync(pbxproj)) {
    const pbxText = readFileSync(pbxproj, "utf8");
    const fromPbx = readPbxprojVersion(pbxText);
    if (marketing === null) marketing = fromPbx.marketing;
    if (build === null) build = fromPbx.build;
  }

  if (marketing === null || build === null) {
    console.error(
      `could not resolve both MARKETING_VERSION and CURRENT_PROJECT_VERSION ` +
        `(marketing=${marketing}, build=${build}); pass them via ${MARKETING_FLAG} / ${BUILD_FLAG}`
    );
    return 1;
  }

  const yamlText = readFileSync(projectYaml, "utf8");
  const { text: patched, found } = patchProjectYaml(yamlText, marketing, build);

  // Fail when ANY value we are enforcing is absent from project.yml — a partial
  // patch (one field written, the other silently skipped) must not exit 0.
  const notFound = [];
  if (marketing != null && !found.marketing) notFound.push("MARKETING_VERSION");
  if (build != null && !found.build) notFound.push("CURRENT_PROJECT_VERSION");
  if (notFound.length > 0) {
    console.error(`${projectYaml} is missing ${notFound.join(" and ")}; refusing a partial sync`);
    return 1;
  }

  if (patched === yamlText) {
    console.log(`[sync-project-yml] already in sync: marketing=${marketing} build=${build}`);
    return 0;
  }

  if (opts.dryRun) {
    console.error(`[sync-project-yml] DRIFT detected: marketing=${marketing} build=${build}`);
    return 2;
  }

  writeFileSync(projectYaml, patched);
  console.log(`[sync-project-yml] wrote: marketing=${marketing} build=${build}`);
  return 0;
}

const isCli = (() => {
  if (typeof process === "undefined") return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
})();
if (isCli) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.stack ?? String(err));
      process.exit(1);
    }
  );
}


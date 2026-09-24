#!/usr/bin/env node
/**
 * Vendor-era shared-package pin check (ST / UM / CT triangle).
 *
 * Socratic-Trade and Usage-Monitor npm-pin
 * github:jaywedgeworth22/congress-trading-shared#vX.Y.Z.
 * Congress.Trade vendors src/ and records the release in
 * app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md. CT must NOT
 * reintroduce an npm dependency on the package.
 *
 * This script fails (exit 1) when:
 *   - this repo has no pin
 *   - Usage-Monitor has no pin or a different tag/version
 *   - Congress.Trade cannot be read (private; needs GH_PACKAGES_TOKEN)
 *   - CT provenance / vendor version disagrees
 *   - CT app/package.json reintroduces the npm dependency
 *   - provenance lists a commit that does not match a consumer lock SHA
 *
 * Intentionally NOT a required merge check yet -- coordinated three-repo
 * bumps still need a red flag without hard-blocking the first PR of the pair.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PKG = "@jaywedgeworth22/congress-trading-shared";

export function normVersion(spec) {
  let s = String(spec || "").trim();
  if (/github:|git\+|\#/.test(s)) {
    s = s.replace(/^.*#/, "");
  }
  return s.replace(/^semver:/, "").replace(/^[\s~^><=]+/, "").replace(/^v/, "").replace(/\s/g, "");
}

export function gitRef(spec) {
  const s = String(spec || "");
  const i = s.lastIndexOf("#");
  return i >= 0 ? s.slice(i + 1) : "";
}

export function lockResolvedSha(lockJson, pkg = PKG) {
  const packages = lockJson?.packages || {};
  const entry = packages[`node_modules/${pkg}`];
  const resolved = String(entry?.resolved || "");
  const ref = gitRef(resolved);
  if (/^[0-9a-fA-F]{40}$/.test(ref)) return ref.toLowerCase();
  return "";
}

export function packageSpec(pkgJson, pkg = PKG) {
  return String((pkgJson?.dependencies || {})[pkg] || "");
}

export function parseProvenance(text) {
  const release = text.match(/^- Immutable release:\s*`([^`]+)`/m)?.[1] || "";
  const commit = text.match(/^- Commit:\s*`([0-9a-fA-F]{40})`/m)?.[1] || "";
  return { release, commit: commit.toLowerCase() };
}

export function ctHasNpmDep(appPkgJson, rootPkgJson, pkg = PKG) {
  for (const json of [appPkgJson, rootPkgJson]) {
    if (!json) continue;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      if (json[field]?.[pkg]) return true;
    }
  }
  return false;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function ghRaw(repo, filePath, token) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  const maxAttempts = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = spawnSync(
      "gh",
      ["api", `repos/${repo}/contents/${filePath}`, "-H", "Accept: application/vnd.github.raw"],
      { encoding: "utf8", env }
    );
    if (result.status === 0) {
      return result.stdout;
    }
    lastErr = (result.stderr || result.stdout || "gh api failed").trim();
    if (attempt < maxAttempts) {
      spawnSync(process.execPath, ["-e", `setTimeout(() => {}, ${1000 * attempt})`]);
    }
  }
  throw new Error(`${repo}/${filePath}: ${lastErr}`);
}

function fail(msg) {
  console.error(`::error::${msg}`);
  process.exit(1);
}

export function comparePins(input) {
  const problems = [];
  const stSpec = input.stSpec;
  const umSpec = input.umSpec;
  if (!stSpec) problems.push("Socratic-Trade package.json has no pin for " + PKG);
  if (!umSpec) problems.push("Usage-Monitor package.json has no pin for " + PKG);
  const stV = normVersion(stSpec);
  const umV = normVersion(umSpec);
  if (stSpec && umSpec && stV !== umV) {
    problems.push(`ST pin ${stSpec} (${stV}) != UM pin ${umSpec} (${umV})`);
  }
  if (input.ctUnreadable) {
    problems.push(
      "cannot read private Congress.Trade vendor provenance; set GH_PACKAGES_TOKEN (repo secret, read access to jaywedgeworth22/Congress.Trade)"
    );
    return { problems, stV, umV, ctV: "" };
  }
  if (input.ctHasNpmDep) {
    problems.push("Congress.Trade reintroduced an npm dependency on " + PKG + " (vendor-only)");
  }
  const ctV = normVersion(input.ctRelease || input.ctVendorVersion || "");
  if (!ctV) problems.push("Congress.Trade VENDOR-PROVENANCE.md / vendor package.json has no release version");
  if (stV && ctV && stV !== ctV) {
    problems.push(`ST/UM version ${stV} != CT vendor release ${ctV}`);
  }
  if (input.ctCommit) {
    if (input.stLockSha && input.stLockSha !== input.ctCommit) {
      problems.push(`ST lock SHA ${input.stLockSha} != CT provenance commit ${input.ctCommit}`);
    }
    if (input.umLockSha && input.umLockSha !== input.ctCommit) {
      problems.push(`UM lock SHA ${input.umLockSha} != CT provenance commit ${input.ctCommit}`);
    }
  }
  return { problems, stV, umV, ctV };
}

function main() {
  const root = process.cwd();
  const localPkgPath = process.env.LOCAL_PACKAGE_JSON_PATH || "package.json";
  const localLockPath = process.env.LOCAL_LOCK_PATH || "package-lock.json";
  if (!existsSync(`${root}/${localPkgPath}`)) fail(`${localPkgPath} missing`);
  const localPkg = readJson(`${root}/${localPkgPath}`);
  const localLock = existsSync(`${root}/${localLockPath}`) ? readJson(`${root}/${localLockPath}`) : {};
  const stSpec = packageSpec(localPkg);
  const stLockSha = lockResolvedSha(localLock);
  console.log(`Local spec (${localPkgPath}): ${stSpec || "(missing)"}`);
  if (stLockSha) console.log(`Local lock SHA: ${stLockSha}`);

  const umToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  let umSpec = "";
  let umLockSha = "";
  try {
    const umPkg = JSON.parse(ghRaw("jaywedgeworth22/Usage-Monitor", "package.json", umToken));
    umSpec = packageSpec(umPkg);
    const umLock = JSON.parse(ghRaw("jaywedgeworth22/Usage-Monitor", "package-lock.json", umToken));
    umLockSha = lockResolvedSha(umLock);
    console.log(`UM spec: ${umSpec || "(missing)"}`);
    if (umLockSha) console.log(`UM lock SHA: ${umLockSha}`);
  } catch (err) {
    fail(`could not read public Usage-Monitor pin: ${err instanceof Error ? err.message : String(err)}`);
  }

  const ctToken = process.env.GH_PACKAGES_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  let ctUnreadable = false;
  let ctRelease = "";
  let ctCommit = "";
  let ctVendorVersion = "";
  let ctNpm = false;
  try {
    const provenance = ghRaw(
      "jaywedgeworth22/Congress.Trade",
      "app/vendor/congress-trading-shared/VENDOR-PROVENANCE.md",
      ctToken
    );
    const parsed = parseProvenance(provenance);
    ctRelease = parsed.release;
    ctCommit = parsed.commit;
    const vendorPkg = JSON.parse(
      ghRaw("jaywedgeworth22/Congress.Trade", "app/vendor/congress-trading-shared/package.json", ctToken)
    );
    ctVendorVersion = String(vendorPkg.version || "");
    const appPkg = JSON.parse(ghRaw("jaywedgeworth22/Congress.Trade", "app/package.json", ctToken));
    let rootPkg = null;
    try {
      rootPkg = JSON.parse(ghRaw("jaywedgeworth22/Congress.Trade", "package.json", ctToken));
    } catch {
      rootPkg = null;
    }
    ctNpm = ctHasNpmDep(appPkg, rootPkg);
    console.log(`CT provenance release: ${ctRelease || "(missing)"} commit: ${ctCommit || "(none)"}`);
    console.log(`CT vendor package.json version: ${ctVendorVersion || "(missing)"}`);
  } catch (err) {
    console.error(`CT fetch failed: ${err instanceof Error ? err.message : String(err)}`);
    ctUnreadable = true;
  }

  const { problems, stV, umV, ctV } = comparePins({
    stSpec,
    umSpec,
    stLockSha,
    umLockSha,
    ctUnreadable,
    ctRelease,
    ctCommit,
    ctVendorVersion,
    ctHasNpmDep: ctNpm,
  });
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }
  console.log(`OK: ST/UM/CT share ${PKG}@${stV || umV || ctV}.`);
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

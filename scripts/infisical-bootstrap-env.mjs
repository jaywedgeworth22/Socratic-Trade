#!/usr/bin/env node

// Resolve only the Infisical bootstrap identity needed by infisical-run.mjs.
// Provider/API secrets remain in Infisical. On the owner's Mac, machine-identity
// credentials may live in ~/.secrets/global-api-keys under app-scoped aliases.
// Values are never logged and are not copied into .env.local.

import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

export const DEFAULT_APP_PROJECT_ID = "39d93bb7-76f9-498c-8b50-a7def52e072f";
export const DEFAULT_SHARED_PROJECT_ID = "18f563a3-9c88-454c-96eb-28fc9678f3ba";
export const DEFAULT_GLOBAL_API_KEYS_FILE = resolve(homedir(), ".secrets/global-api-keys");

const APP_PAIR_KEYS = [
  ["INFISICAL_CLIENT_ID", "INFISICAL_CLIENT_SECRET"],
  // The owner's existing global-file spelling has an intentional extra I.
  ["INFIISICAL_ST_CLIENT_ID", "INFIISICAL_ST_CLIENT_SECRET"],
  // Also accept the corrected spelling for forward compatibility.
  ["INFISICAL_ST_CLIENT_ID", "INFISICAL_ST_CLIENT_SECRET"],
];

const SHARED_PAIR_KEYS = [
  ["INFISICAL_SHARED_CLIENT_ID", "INFISICAL_SHARED_CLIENT_SECRET"],
  ["INFISICAL_CT_SHARED_CLIENT_ID", "INFISICAL_CT_SHARED_CLIENT_SECRET"],
];

// The broad machine-level file is shared by several apps. Only the app-scoped
// Socratic aliases and the documented CT-shared aliases are eligible there.
// Generic app credentials, access tokens, project selectors, and environment
// controls remain valid in process env / .env.local, but never cross this
// shared-file boundary.
const GLOBAL_APP_PAIR_KEYS = [
  ["INFIISICAL_ST_CLIENT_ID", "INFIISICAL_ST_CLIENT_SECRET"],
  ["INFISICAL_ST_CLIENT_ID", "INFISICAL_ST_CLIENT_SECRET"],
];

const GLOBAL_SHARED_PAIR_KEYS = [
  ["INFISICAL_CT_SHARED_CLIENT_ID", "INFISICAL_CT_SHARED_CLIENT_SECRET"],
];

export const INFISICAL_BOOTSTRAP_RUNTIME_KEYS = Object.freeze([
  "INFISICAL_PROJECT_ID",
  "INFISICAL_ENV",
  "INFISICAL_PATH",
  "INFISICAL_WATCH",
  "INFISICAL_SHARED_PROJECT_ID",
  "INFISICAL_SHARED_ENV",
  "INFISICAL_SHARED_PATH",
  "INFISICAL_DOMAIN",
  "INFISICAL_API_URL",
  "INFISICAL_BASE_URL",
]);

export const INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS = Object.freeze([
  ...new Set([
    ...APP_PAIR_KEYS.flat(),
    ...SHARED_PAIR_KEYS.flat(),
    ...GLOBAL_APP_PAIR_KEYS.flat(),
    ...GLOBAL_SHARED_PAIR_KEYS.flat(),
    // Other app-scoped names are not resolvable for Socratic-Trade, but must
    // still be scrubbed before any CLI or final app process is launched.
    "INFISICAL_APP_CLIENT_ID",
    "INFISICAL_APP_CLIENT_SECRET",
    "INFISICAL_CT_CLIENT_ID",
    "INFISICAL_CT_CLIENT_SECRET",
    "INFISICAL_TOKEN",
    "INFISICAL_SHARED_TOKEN",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_ID",
    "INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET",
  ]),
]);

const GLOBAL_BOOTSTRAP_KEYS = new Set([
  ...GLOBAL_APP_PAIR_KEYS.flat(),
  ...GLOBAL_SHARED_PAIR_KEYS.flat(),
]);

const LOCAL_BOOTSTRAP_KEYS = new Set([
  ...APP_PAIR_KEYS.flat(),
  ...SHARED_PAIR_KEYS.flat(),
  "INFISICAL_TOKEN",
  "INFISICAL_SHARED_TOKEN",
  ...INFISICAL_BOOTSTRAP_RUNTIME_KEYS,
]);

export const INFISICAL_FINAL_APP_MASK_KEYS = Object.freeze([
  ...INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS,
  ...INFISICAL_BOOTSTRAP_RUNTIME_KEYS,
  // Historical integration tests used this ambient path override. It is no
  // longer honored, and masking prevents Next from restoring it from dotenv.
  "GLOBAL_API_KEYS_FILE",
]);

const MAX_GLOBAL_FILE_BYTES = 1024 * 1024;

export class InfisicalBootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = "InfisicalBootstrapError";
  }
}

function hasValue(values, key) {
  return typeof values?.[key] === "string" && values[key].length > 0;
}

function closingQuoteIndex(value, quote, start = 1) {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    let backslashes = 0;
    for (let prior = index - 1; prior >= 0 && value[prior] === "\\"; prior -= 1) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

function isAmbiguousMultilineShell(line) {
  const trimmed = line.trim();
  if (trimmed.includes("<<")) return true;
  if (/^(?:function\b|[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{)/.test(trimmed)) {
    return !/}\s*;?\s*(?:#.*)?$/.test(trimmed);
  }
  if (/^if\b/.test(trimmed)) return !/\bfi\s*;?\s*(?:#.*)?$/.test(trimmed);
  if (/^(?:for|while|until|select)\b/.test(trimmed)) {
    return !/\bdone\s*;?\s*(?:#.*)?$/.test(trimmed);
  }
  if (/^case\b/.test(trimmed)) return !/\besac\s*;?\s*(?:#.*)?$/.test(trimmed);
  return /^(?:(?:then|elif|else|fi|do|done|esac)(?:\s|;|$)|[{}()])/.test(trimmed);
}

function parseManagedEnv(text, managedKeys) {
  const values = {};
  let unrelatedMultilineQuote = null;
  for (const line of text.split(/\r?\n/)) {
    if (unrelatedMultilineQuote) {
      if (closingQuoteIndex(line, unrelatedMultilineQuote, 0) >= 0) {
        unrelatedMultilineQuote = null;
      }
      continue;
    }
    // This file is an assignment store, not a shell program. Harmless unrelated
    // one-line text is ignored, but multiline shell/heredoc syntax is ambiguous
    // without executing a shell parser. Fail the whole read rather than risk
    // importing a key-looking line from inside a nested construct.
    if (isAmbiguousMultilineShell(line)) {
      throw new Error("multiline shell constructs are not accepted");
    }

    // The owner's global file is a broad shell/dotenv assignment store. Parse
    // only assignments owned by this bootstrap so unrelated shell syntax or a
    // malformed third-party entry cannot affect Socratic startup. Managed
    // assignments must be top-level (not indented inside a shell block).
    const match = line.match(/^([ \t]*)(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/);
    if (!match) continue;
    const [, indentation, key, rawValue] = match;
    const trimmedValue = rawValue.trimStart();
    const quote = ["\"", "'", "`"].includes(trimmedValue[0]) ? trimmedValue[0] : null;
    const closesOnLine = quote ? closingQuoteIndex(trimmedValue, quote) >= 0 : true;
    const isManagedTopLevel = indentation.length === 0 && managedKeys.has(key);
    if (!isManagedTopLevel) {
      if (quote && !closesOnLine) unrelatedMultilineQuote = quote;
      continue;
    }
    if (quote && !closesOnLine) {
      throw new Error("managed assignments must use single-line quoted values");
    }
    const parsed = parseEnv(line);
    if (!Object.prototype.hasOwnProperty.call(parsed, key)) {
      throw new Error("managed assignment could not be parsed");
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`duplicate managed assignment for ${key}`);
    }
    values[key] = parsed[key];
  }
  return values;
}

function readSecureGlobalFile(path) {
  let pathStat;
  try {
    // lstat distinguishes a genuinely absent optional file from a live/broken
    // symlink. The descriptor open below closes the lstat/read race.
    pathStat = lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { found: false, text: "" };
    }
    throw new InfisicalBootstrapError(
      "[infisical-bootstrap] Could not safely inspect global API-key file."
    );
  }

  if (pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new InfisicalBootstrapError(
      "[infisical-bootstrap] Global API-key path must be a regular, non-symlink file."
    );
  }

  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const openedStat = fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino
    ) {
      throw new InfisicalBootstrapError(
        "[infisical-bootstrap] Global API-key file changed during its safety check."
      );
    }
    if ((openedStat.mode & 0o077) !== 0) {
      throw new InfisicalBootstrapError(
        "[infisical-bootstrap] Global API-key file must not grant group/other permissions."
      );
    }
    if (typeof process.getuid === "function" && openedStat.uid !== process.getuid()) {
      throw new InfisicalBootstrapError(
        "[infisical-bootstrap] Global API-key file must be owned by the current user."
      );
    }
    if (openedStat.size > MAX_GLOBAL_FILE_BYTES) {
      throw new InfisicalBootstrapError(
        "[infisical-bootstrap] Global API-key file exceeds the safe size limit."
      );
    }
    return { found: true, text: readFileSync(descriptor, "utf8") };
  } catch (error) {
    if (error instanceof InfisicalBootstrapError) throw error;
    throw new InfisicalBootstrapError(
      "[infisical-bootstrap] Could not safely read global API-key file."
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readEnvFile(path, label, { secureGlobalFile = false, managedKeys } = {}) {
  if (!path) return { found: false, values: {} };
  if (secureGlobalFile) {
    const secureFile = readSecureGlobalFile(path);
    if (!secureFile.found) return { found: false, values: {} };
    try {
      return {
        found: true,
        values: parseManagedEnv(secureFile.text, managedKeys || new Set()),
      };
    } catch {
      throw new InfisicalBootstrapError(
        `[infisical-bootstrap] Could not safely parse ${label} at ${path}.`
      );
    }
  }

  try {
    // lstat (not existsSync/stat) sees broken symlinks, which must be rejected
    // rather than treated as a missing optional credential file.
    lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { found: false, values: {} };
    }
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Could not safely inspect ${label}.`
    );
  }

  try {
    const text = readFileSync(path, "utf8");
    return {
      found: true,
      values: managedKeys ? parseManagedEnv(text, managedKeys) : parseEnv(text),
    };
  } catch {
    // parseEnv errors can include source text. Do not echo an error that may
    // contain a credential value.
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Could not safely parse ${label} at ${path}.`
    );
  }
}

function inspectPair(values, pair, identity, layerLabel) {
  const [idKey, secretKey] = pair;
  const hasId = hasValue(values, idKey);
  const hasSecret = hasValue(values, secretKey);
  if (hasId !== hasSecret) {
    throw new InfisicalBootstrapError(
      `[infisical-bootstrap] Partial ${identity} credential pair in ${layerLabel}: ` +
      `set both ${idKey} and ${secretKey}.`
    );
  }
  return hasId ? { idKey, secretKey } : null;
}

function validateLayerValues(layer) {
  for (const [key, value] of Object.entries(layer.values)) {
    if (typeof value === "string" && value.includes("\0")) {
      throw new InfisicalBootstrapError(
        `[infisical-bootstrap] Invalid NUL byte in ${layer.label}:${key}.`
      );
    }
  }
}

function resolveAuth(layers, { identity, pairs, globalPairs, tokenKey }) {
  for (const layer of layers) {
    const eligiblePairs = layer.kind === "global" ? globalPairs : pairs;
    // Validate every recognized pair in the selected layer. A stale half-pair
    // must not be silently combined with, or hidden by, another credential.
    const completePairs = eligiblePairs
      .map((pair) => inspectPair(layer.values, pair, identity, layer.label))
      .filter(Boolean);

    if (completePairs.length > 1) {
      const [first, ...rest] = completePairs;
      const conflicts = rest.some((pair) => (
        layer.values[pair.idKey] !== layer.values[first.idKey] ||
        layer.values[pair.secretKey] !== layer.values[first.secretKey]
      ));
      if (conflicts) {
        throw new InfisicalBootstrapError(
          `[infisical-bootstrap] Conflicting complete ${identity} credential aliases in ${layer.label}; ` +
          "keep only one pair."
        );
      }
    }

    // The machine identity is primary and a token is only fallback. Preserve
    // that rule for generic and alias pairs alike within every precedence layer.
    const selectedPair = completePairs[0];
    if (selectedPair) {
      return {
        kind: "pair",
        clientId: layer.values[selectedPair.idKey],
        clientSecret: layer.values[selectedPair.secretKey],
        source: `${layer.label}:${selectedPair.idKey}`,
      };
    }

    if (layer.kind !== "global" && hasValue(layer.values, tokenKey)) {
      return {
        kind: "token",
        token: layer.values[tokenKey],
        source: `${layer.label}:${tokenKey}`,
      };
    }
  }
  return null;
}

function firstValue(layers, key) {
  for (const layer of layers) {
    if (hasValue(layer.values, key)) return layer.values[key];
  }
  return undefined;
}

function credentialUpdates(appAuth, sharedAuth) {
  const updates = {};
  if (appAuth?.kind === "pair") {
    updates.INFISICAL_CLIENT_ID = appAuth.clientId;
    updates.INFISICAL_CLIENT_SECRET = appAuth.clientSecret;
  } else if (appAuth?.kind === "token") {
    updates.INFISICAL_TOKEN = appAuth.token;
  }

  if (sharedAuth?.kind === "pair") {
    updates.INFISICAL_SHARED_CLIENT_ID = sharedAuth.clientId;
    updates.INFISICAL_SHARED_CLIENT_SECRET = sharedAuth.clientSecret;
  } else if (sharedAuth?.kind === "token") {
    updates.INFISICAL_SHARED_TOKEN = sharedAuth.token;
  }
  return updates;
}

export function resolveInfisicalBootstrap({
  explicitEnv = {},
  localEnv = {},
  globalEnv = {},
} = {}) {
  const narrowedGlobalEnv = Object.fromEntries(
    Object.entries(globalEnv).filter(([key]) => GLOBAL_BOOTSTRAP_KEYS.has(key))
  );
  const layers = [
    { kind: "process", label: "process environment", values: explicitEnv },
    { kind: "local", label: ".env.local", values: localEnv },
    { kind: "global", label: "global-api-keys", values: narrowedGlobalEnv },
  ];
  for (const layer of layers) validateLayerValues(layer);

  const appAuth = resolveAuth(layers, {
    identity: "app",
    pairs: APP_PAIR_KEYS,
    globalPairs: GLOBAL_APP_PAIR_KEYS,
    tokenKey: "INFISICAL_TOKEN",
  });
  const sharedAuth = resolveAuth(layers, {
    identity: "shared",
    pairs: SHARED_PAIR_KEYS,
    globalPairs: GLOBAL_SHARED_PAIR_KEYS,
    tokenKey: "INFISICAL_SHARED_TOKEN",
  });

  const appProjectId = firstValue(layers, "INFISICAL_PROJECT_ID") || DEFAULT_APP_PROJECT_ID;
  const configuredSharedProjectId = firstValue(layers, "INFISICAL_SHARED_PROJECT_ID");
  // Do not enable the overlay merely because its project ID is known. Enable
  // the default only when a shared identity/token is actually available.
  const sharedProjectId = configuredSharedProjectId || (sharedAuth ? DEFAULT_SHARED_PROJECT_ID : undefined);
  if (sharedProjectId && !appAuth) {
    // Overlay mode exports both projects and therefore cannot use the CLI's
    // cached interactive login for the app side. Abort before minting/fetching
    // shared credentials so a half-configured overlay makes no network call.
    throw new InfisicalBootstrapError(
      "[infisical-bootstrap] Shared overlay requires an explicit app identity/token; " +
      "set the complete app credential pair or INFISICAL_TOKEN."
    );
  }

  const updates = {
    ...credentialUpdates(appAuth, sharedAuth),
    INFISICAL_PROJECT_ID: appProjectId,
  };
  if (sharedProjectId) updates.INFISICAL_SHARED_PROJECT_ID = sharedProjectId;
  for (const key of INFISICAL_BOOTSTRAP_RUNTIME_KEYS) {
    if (key === "INFISICAL_PROJECT_ID" || key === "INFISICAL_SHARED_PROJECT_ID") continue;
    const value = firstValue(layers, key);
    if (value !== undefined) updates[key] = value;
  }

  return {
    updates,
    appAuthConfigured: Boolean(appAuth),
    sharedAuthConfigured: Boolean(sharedAuth),
    appAuthSource: appAuth?.source,
    sharedAuthSource: sharedAuth?.source,
    appProjectId,
    sharedProjectId,
  };
}

export function prepareInfisicalBootstrapEnvironment({
  env = process.env,
  cwd = process.cwd(),
  globalFile = DEFAULT_GLOBAL_API_KEYS_FILE,
} = {}) {
  // Snapshot the real process environment before loading .env.local so its
  // values retain strict precedence.
  const explicitEnv = Object.fromEntries(
    Object.entries(env).filter(([key]) => LOCAL_BOOTSTRAP_KEYS.has(key))
  );
  const local = readEnvFile(resolve(cwd, ".env.local"), ".env.local");
  const global = readEnvFile(globalFile, "global API-key file", {
    secureGlobalFile: true,
    managedKeys: GLOBAL_BOOTSTRAP_KEYS,
  });
  const localBootstrapEnv = Object.fromEntries(
    Object.entries(local.values).filter(([key]) => LOCAL_BOOTSTRAP_KEYS.has(key))
  );

  const resolvedBootstrap = resolveInfisicalBootstrap({
    explicitEnv,
    localEnv: localBootstrapEnv,
    globalEnv: global.values,
  });

  // Load only non-secret runner controls from .env.local. Next will load the
  // rest itself after Infisical has injected authoritative app secrets.
  for (const key of INFISICAL_BOOTSTRAP_RUNTIME_KEYS) {
    if (env[key] === undefined && localBootstrapEnv[key] !== undefined) {
      env[key] = localBootstrapEnv[key];
    }
  }

  // Normalize exactly one credential source into the generic names consumed by
  // infisical-run.mjs. Removing aliases here and again in childEnv prevents the
  // app/shared long-lived secrets from leaking into spawned commands.
  for (const key of INFISICAL_BOOTSTRAP_CREDENTIAL_KEYS) delete env[key];
  delete env.GLOBAL_API_KEYS_FILE;
  Object.assign(env, resolvedBootstrap.updates);

  return {
    ...resolvedBootstrap,
    localFileFound: local.found,
    globalFileFound: global.found,
  };
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isDirectExecution()) {
  try {
    const result = prepareInfisicalBootstrapEnvironment();
    console.log(
      `[infisical-bootstrap] app identity=${result.appAuthConfigured ? "ready" : "not configured"}; ` +
      `shared identity=${result.sharedAuthConfigured ? "ready" : "not configured"}; ` +
      "credential values were neither printed nor copied."
    );
  } catch (error) {
    const message = error instanceof InfisicalBootstrapError
      ? error.message
      : "[infisical-bootstrap] Bootstrap resolution failed without exposing credential details.";
    console.error(message);
    process.exit(2);
  }
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api";
const DEFAULT_FALLBACK_API_URL = "https://gudian-shexue-kb-api.crescent-kb.workers.dev";
const DEFAULT_VERSION_URL = "https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api/skill-version.json";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const LOCAL_VERSION_PATH = path.join(SKILL_DIR, "skill-version.json");
const CACHE_DIR = path.join(SKILL_DIR, ".cache");
const KB_HEALTH_CACHE_PATH = path.join(CACHE_DIR, "kb-health.json");
const SESSION_CACHE_PATH = path.join(CACHE_DIR, "session-token.json");
const SESSION_CLIENT_ID = "gudian-shexue-community-qa-skill";
const SESSION_NOTICE_VERSION = "2026-07-16-interaction-log-v1";

const args = parseArgs(process.argv.slice(2));
const query = args.query || args.q;

if (!query) {
  fail("Missing --query. Example: node scripts/query-kb.mjs --query \"箭重规则\" --category 社群 --top-k 5", 2);
}

const apiUrls = resolveApiUrls(args);
const timeoutMs = Number.parseInt(args.timeoutMs || args["timeout-ms"] || process.env.GUDIAN_SHEXUE_KB_TIMEOUT_MS || "8000", 10);
const topK = Number.parseInt(args.topK || args["top-k"] || "5", 10);
const body = {
  query,
  top_k: Number.isFinite(topK) ? topK : 5
};

if (args.category) body.category = args.category;
if (args.answerTopK || args["answer-top-k"]) {
  const answerTopK = Number.parseInt(args.answerTopK || args["answer-top-k"], 10);
  if (Number.isFinite(answerTopK)) body.answer_top_k = answerTopK;
}
if (args.evidenceTopK || args["evidence-top-k"]) {
  const evidenceTopK = Number.parseInt(args.evidenceTopK || args["evidence-top-k"], 10);
  if (Number.isFinite(evidenceTopK)) body.evidence_top_k = evidenceTopK;
}
if (args.perCategoryTopK || args["per-category-top-k"]) {
  const perCategoryTopK = Number.parseInt(args.perCategoryTopK || args["per-category-top-k"], 10);
  if (Number.isFinite(perCategoryTopK)) body.per_category_top_k = perCategoryTopK;
}

const endpointName = args.route === "true"
  ? "route-search"
  : args.rag === "true"
    ? "route-search"
    : "search";

const errors = [];
let success = false;
for (const apiUrl of apiUrls) {
  const endpoint = `${apiUrl}/${endpointName}`;
  try {
    await checkForUpdates(apiUrl, args);
    const sessionToken = await getSessionToken(apiUrl, args, timeoutMs);
    const data = await queryWithFetchWithSessionRetry(apiUrl, endpoint, body, timeoutMs, args, sessionToken);
    validateApiData(data, endpoint);
    printJson(data);
    success = true;
    break;
  } catch (fetchError) {
    try {
      const sessionToken = await getSessionToken(apiUrl, args, timeoutMs);
      const data = queryWithCurl(endpoint, body, false, timeoutMs, sessionToken);
      validateApiData(data, endpoint);
      printJson(data);
      success = true;
      break;
    } catch (curlError) {
      try {
        const sessionToken = await getSessionToken(apiUrl, args, timeoutMs);
        const data = queryWithCurl(endpoint, body, true, timeoutMs, sessionToken);
        validateApiData(data, endpoint);
        printJson(data);
        success = true;
        break;
      } catch (directCurlError) {
        errors.push([
          `Endpoint: ${endpoint}`,
          `Fetch error: ${formatError(fetchError)}`,
          `Curl error: ${formatError(curlError)}`,
          `Curl no-proxy error: ${formatError(directCurlError)}`
        ].join("\n"));
      }
    }
  }
}

if (!success) {
  fail([
    "Remote KB API request failed for all configured endpoints.",
    ...errors
  ].join("\n\n"), 1);
}

async function checkForUpdates(apiUrl, args) {
  if (args["no-update-check"] === "true" || process.env.GUDIAN_SHEXUE_SKIP_UPDATE_CHECK === "1") {
    return;
  }

  await Promise.allSettled([
    checkSkillVersion(args),
    checkKbHealth(apiUrl)
  ]);
}

async function checkSkillVersion(args) {
  const versionUrl = args.versionUrl || args["version-url"] || process.env.GUDIAN_SHEXUE_SKILL_VERSION_URL || DEFAULT_VERSION_URL;
  const localVersion = readLocalVersion();
  if (!localVersion || !versionUrl) return;

  const remoteVersion = await fetchJsonWithTimeout(versionUrl, 5000);
  if (!remoteVersion?.version) return;

  if (isRemoteNewer(remoteVersion.version, localVersion.version)) {
    warn([
      `[update] Skill update available: local ${localVersion.version}, remote ${remoteVersion.version}.`,
      remoteVersion.repository ? `Repository: ${remoteVersion.repository}` : null,
      remoteVersion.release_notes ? `Notes: ${remoteVersion.release_notes}` : null
    ].filter(Boolean).join("\n"));

    if (shouldAutoUpdate(args)) {
      autoUpdateSkill(remoteVersion);
    } else {
      warn("[update] Auto-update is disabled. Use --auto-update or GUDIAN_SHEXUE_AUTO_UPDATE=1 to update before querying.");
    }
  }
}

function shouldAutoUpdate(args) {
  if (args["no-auto-update"] === "true" || process.env.GUDIAN_SHEXUE_AUTO_UPDATE === "0") return false;
  return args["auto-update"] === "true" || process.env.GUDIAN_SHEXUE_AUTO_UPDATE === "1";
}

function autoUpdateSkill(remoteVersion) {
  const packageUrl = remoteVersion.domestic_package_url || remoteVersion.package_url || remoteVersion.zip_url;
  if (packageUrl && autoUpdateSkillFromPackage(packageUrl, remoteVersion)) return;

  const tempRoot = mkdtempSync(path.join(tmpdir(), "gudian-shexue-skill-update-"));
  const cloneDir = path.join(tempRoot, "repo");

  try {
    if (!remoteVersion.repository) {
      warn("[update] Auto-update skipped: remote skill-version.json does not provide a repository URL.");
      return;
    }

    warn(`[update] Auto-updating skill from ${remoteVersion.repository} ...`);
    execFileSync("git", ["clone", "--depth", "1", remoteVersion.repository, cloneDir], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "ignore", "pipe"]
    });

    cpSync(cloneDir, SKILL_DIR, {
      recursive: true,
      force: true,
      filter: (source) => {
        const name = path.basename(source);
        return ![".git", ".cache", "node_modules"].includes(name);
      }
    });

    warn(`[update] Skill auto-update finished. Installed version: ${remoteVersion.version}. Continuing current query.`);
  } catch (error) {
    warn(`[update] Skill auto-update failed; continuing with current local version. ${formatError(error)}`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function autoUpdateSkillFromPackage(packageUrl, remoteVersion) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "gudian-shexue-skill-package-"));
  const zipPath = path.join(tempRoot, "skill.zip");
  const extractDir = path.join(tempRoot, "extract");

  try {
    warn(`[update] Auto-updating skill from domestic package ${packageUrl} ...`);
    downloadFile(packageUrl, zipPath, 15000);
    extractZip(zipPath, extractDir);
    const packageRoot = findPackageRoot(extractDir);

    cpSync(packageRoot, SKILL_DIR, {
      recursive: true,
      force: true,
      filter: (source) => {
        const name = path.basename(source);
        return ![".git", ".cache", "node_modules"].includes(name);
      }
    });

    warn(`[update] Skill auto-update finished from domestic package. Installed version: ${remoteVersion.version}. Continuing current query.`);
    return true;
  } catch (error) {
    warn(`[update] Domestic package auto-update failed; trying repository fallback if available. ${formatError(error)}`);
    return false;
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function downloadFile(url, outputPath, timeoutMs) {
  try {
    curlDownload(url, outputPath, false, timeoutMs);
  } catch {
    curlDownload(url, outputPath, true, timeoutMs);
  }
}

function curlDownload(url, outputPath, noProxy, timeoutMs) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const curlArgs = [
    "-L",
    "-f",
    "-sS",
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-o", outputPath,
    url
  ];

  if (noProxy) curlArgs.unshift("--noproxy", "*");

  execFileSync(curl, curlArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
}

function extractZip(zipPath, destinationPath) {
  mkdirSync(destinationPath, { recursive: true });

  if (process.platform === "win32") {
    execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath ${psQuote(zipPath)} -DestinationPath ${psQuote(destinationPath)} -Force`
    ], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });
    return;
  }

  execFileSync("unzip", ["-q", zipPath, "-d", destinationPath], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });
}

function findPackageRoot(extractDir) {
  if (existsSync(path.join(extractDir, "SKILL.md"))) return extractDir;

  const children = readdirSync(extractDir)
    .map((name) => path.join(extractDir, name))
    .filter((item) => statSync(item).isDirectory());

  if (children.length === 1 && existsSync(path.join(children[0], "SKILL.md"))) return children[0];

  throw new Error("Downloaded package does not look like a skill directory: missing SKILL.md.");
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function checkKbHealth(apiUrl) {
  const health = await fetchJsonWithTimeout(`${apiUrl}/health`, 1500);
  if (!health?.ok) return;

  const previous = readJsonIfExists(KB_HEALTH_CACHE_PATH);
  if (previous?.build && health.build && previous.build !== health.build) {
    warn([
      `[update] Remote KB changed: ${previous.build} -> ${health.build}.`,
      `Current KB: documents=${health.documents}, chunks=${health.chunks ?? health.paragraphs}, answer_units=${health.answer_units ?? 0}.`
    ].join("\n"));
  } else if (!previous?.build && health.build) {
    warn(`[kb] Remote KB snapshot recorded: build=${health.build}, documents=${health.documents}, chunks=${health.chunks ?? health.paragraphs}, answer_units=${health.answer_units ?? 0}.`);
  }

  writeJsonBestEffort(KB_HEALTH_CACHE_PATH, {
    build: health.build,
    documents: health.documents,
    paragraphs: health.paragraphs,
    chunks: health.chunks,
    answer_units: health.answer_units,
    checked_at: new Date().toISOString()
  });
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  try {
    return queryJsonWithCurlGet(url, false, timeoutMs);
  } catch {
    return queryJsonWithCurlGet(url, true, timeoutMs);
  }
}

async function getSessionToken(apiUrl, args, timeoutMs) {
  if (sessionDisabled(args)) return "";

  const explicit = args.sessionToken || args["session-token"] || process.env.GUDIAN_SHEXUE_SESSION_TOKEN;
  if (explicit) return explicit;

  const cachePath = args.sessionCachePath
    || args["session-cache-path"]
    || process.env.GUDIAN_SHEXUE_SESSION_CACHE_PATH
    || SESSION_CACHE_PATH;
  const skillVersion = readLocalVersion()?.version || "unknown";

  if (process.env.GUDIAN_SHEXUE_DISABLE_SESSION_CACHE !== "1") {
    const cached = readCachedSession(cachePath, apiUrl, skillVersion);
    if (cached) return cached.session_token;
  }

  const session = await createSession(apiUrl, skillVersion, timeoutMs);
  if (process.env.GUDIAN_SHEXUE_DISABLE_SESSION_CACHE !== "1") {
    writeCachedSession(cachePath, apiUrl, skillVersion, session);
  }
  return session.session_token;
}

function sessionDisabled(args) {
  return args["no-session"] === "true"
    || process.env.GUDIAN_SHEXUE_DISABLE_SESSION === "1"
    || process.env.GUDIAN_SHEXUE_REQUIRE_AUDIT_CONSENT === "0";
}

async function createSession(apiUrl, skillVersion, timeoutMs) {
  const body = {
    audit_consent: process.env.GUDIAN_SHEXUE_AUDIT_CONSENT === "0" ? false : true,
    notice_version: SESSION_NOTICE_VERSION,
    consent_method: "continued_use_after_notice",
    client_id: SESSION_CLIENT_ID,
    skill_version: skillVersion
  };
  const endpoint = `${apiUrl}/session/start`;

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8"
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
    });
    const text = await response.text();
    if (!response.ok) throw apiResponseError(endpoint, response.status, text);
    const data = JSON.parse(text);
    if (!data?.session_token) throw new Error(`Session response missing session_token from ${endpoint}.`);
    return data;
  } catch (error) {
    if (isSessionEndpointMissing(error)) return { session_token: "", expires_at: "" };
    throw error;
  }
}

function isSessionEndpointMissing(error) {
  const message = formatError(error);
  return /HTTP 404|Not found/i.test(message);
}

function readCachedSession(cachePath, apiUrl, skillVersion) {
  const cache = readJsonIfExists(cachePath);
  const item = cache?.[apiUrl];
  if (!item?.session_token) return null;
  if (item.skill_version !== skillVersion) return null;
  if (item.notice_version !== SESSION_NOTICE_VERSION) return null;
  if (item.expires_at && Date.parse(item.expires_at) <= Date.now() + 60_000) return null;
  return item;
}

function writeCachedSession(cachePath, apiUrl, skillVersion, session) {
  if (!session?.session_token) return;
  const cache = readJsonIfExists(cachePath) || {};
  cache[apiUrl] = {
    session_token: session.session_token,
    session_id: session.session_id || "",
    expires_at: session.expires_at || "",
    notice_version: SESSION_NOTICE_VERSION,
    skill_version: skillVersion,
    updated_at: new Date().toISOString()
  };
  writeJsonBestEffort(cachePath, cache);
}

function clearCachedSession(apiUrl, args) {
  const cachePath = args.sessionCachePath
    || args["session-cache-path"]
    || process.env.GUDIAN_SHEXUE_SESSION_CACHE_PATH
    || SESSION_CACHE_PATH;
  const cache = readJsonIfExists(cachePath) || {};
  if (!cache[apiUrl]) return;
  delete cache[apiUrl];
  writeJsonBestEffort(cachePath, cache);
}

async function queryWithFetchWithSessionRetry(apiUrl, endpoint, body, timeoutMs, args, sessionToken) {
  try {
    return await queryWithFetch(endpoint, body, timeoutMs, sessionToken);
  } catch (error) {
    if (!isInvalidSessionError(error)) throw error;
    clearCachedSession(apiUrl, args);
    const refreshed = await getSessionToken(apiUrl, args, timeoutMs);
    return queryWithFetch(endpoint, body, timeoutMs, refreshed);
  }
}

function isInvalidSessionError(error) {
  return /SESSION_TOKEN_EXPIRED|SESSION_TOKEN_INVALID/i.test(formatError(error));
}

function queryJsonWithCurlGet(url, noProxy, timeoutMs) {
  const curl = process.platform === "win32" ? "curl.exe" : "curl";
  const curlArgs = [
    "-s",
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    url
  ];

  if (noProxy) curlArgs.unshift("--noproxy", "*");

  const output = execFileSync(curl, curlArgs, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024
  });

  return JSON.parse(output);
}

async function queryWithFetch(endpoint, body, timeoutMs, sessionToken = "") {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
  });

  const text = await response.text();
  if (!response.ok) {
    throw apiResponseError(endpoint, response.status, text);
  }

  return JSON.parse(text);
}

function queryWithCurl(endpoint, body, noProxy, timeoutMs, sessionToken = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "gudian-shexue-kb-"));
  const bodyPath = path.join(dir, "body.json");

  try {
    writeFileSync(bodyPath, JSON.stringify(body), "utf8");
    const curl = process.platform === "win32" ? "curl.exe" : "curl";
    const curlArgs = [
      "-sS",
      "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      "-X", "POST",
      endpoint,
      "-H", "Content-Type: application/json; charset=utf-8",
      "--data-binary", `@${bodyPath}`
    ];

    if (sessionToken) {
      curlArgs.push("-H", `Authorization: Bearer ${sessionToken}`);
    }

    if (noProxy) curlArgs.unshift("--noproxy", "*");

    const output = execFileSync(curl, curlArgs, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024
    });

    return JSON.parse(output);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function resolveApiUrls(args) {
  const explicit = args.apiUrl || args["api-url"] || process.env.GUDIAN_SHEXUE_KB_API_URL;
  if (explicit) return splitApiUrls(explicit);

  const configured = args.apiUrls || args["api-urls"] || process.env.GUDIAN_SHEXUE_KB_API_URLS;
  if (configured) return splitApiUrls(configured);

  return [DEFAULT_API_URL, DEFAULT_FALLBACK_API_URL].map(stripTrailingSlash);
}

function splitApiUrls(value) {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map(stripTrailingSlash);
}

function readLocalVersion() {
  return readJsonIfExists(LOCAL_VERSION_PATH);
}

function isRemoteNewer(remoteVersion, localVersion) {
  const remote = parseVersion(remoteVersion);
  const local = parseVersion(localVersion);
  if (!remote || !local) return remoteVersion !== localVersion;

  for (let i = 0; i < Math.max(remote.length, local.length); i += 1) {
    const a = remote[i] || 0;
    const b = local[i] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }

  return false;
}

function parseVersion(value) {
  const match = String(value || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function readJsonIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function writeJsonBestEffort(filePath, value) {
  try {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  } catch {
    // Update checks are advisory; never fail a knowledge-base query because cache writes are unavailable.
  }
}

function printJson(data) {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function validateApiData(data, endpoint) {
  const updateMessage = formatUpdateInstruction(data);
  if (updateMessage) {
    throw new Error(`API update required from ${endpoint}:\n${updateMessage}`);
  }
  if (data?.error) {
    throw new Error(`API error from ${endpoint}: ${data.error}`);
  }
}

function apiResponseError(endpoint, status, text) {
  const parsed = parseJsonText(text);
  const updateMessage = formatUpdateInstruction(parsed);
  if (updateMessage) {
    return new Error(`HTTP ${status} from ${endpoint}:\n${updateMessage}`);
  }
  const message = parsed?.message || parsed?.error || text.slice(0, 500);
  return new Error(`HTTP ${status} from ${endpoint}: ${message}`);
}

function parseJsonText(text) {
  try {
    return JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function formatUpdateInstruction(data) {
  const instruction = data?.update_instruction || (data?.error === "UPGRADE_REQUIRED" ? data : null);
  if (!instruction) return "";
  const lines = [
    `[update] ${instruction.message || "Skill update required."}`,
    instruction.latest_version ? `[update] Latest version: ${instruction.latest_version}` : "",
    instruction.package_url ? `[update] Package: ${instruction.package_url}` : "",
    instruction.version_url ? `[update] Version manifest: ${instruction.version_url}` : "",
    instruction.repository ? `[update] Repository: ${instruction.repository}` : "",
    instruction.release_notes ? `[update] Notes: ${instruction.release_notes}` : "",
    "[update] To auto-update, run with --auto-update or set GUDIAN_SHEXUE_AUTO_UPDATE=1."
  ].filter(Boolean);
  return lines.join("\n");
}

function warn(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function formatError(error) {
  if (!error) return "unknown";
  return error.stack || error.message || String(error);
}

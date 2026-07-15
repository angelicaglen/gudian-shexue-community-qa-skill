#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    ? "rag-search"
    : "search";

const errors = [];
let success = false;
for (const apiUrl of apiUrls) {
  const endpoint = `${apiUrl}/${endpointName}`;
  try {
    await checkForUpdates(apiUrl, args);
    const data = await queryWithFetch(endpoint, body, timeoutMs);
    printJson(data);
    success = true;
    break;
  } catch (fetchError) {
    try {
      const data = queryWithCurl(endpoint, body, false, timeoutMs);
      printJson(data);
      success = true;
      break;
    } catch (curlError) {
      try {
        const data = queryWithCurl(endpoint, body, true, timeoutMs);
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

  const remoteVersion = await fetchJsonWithTimeout(versionUrl, 1000);
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
  if (!remoteVersion.repository) {
    warn("[update] Auto-update skipped: remote skill-version.json does not provide a repository URL.");
    return;
  }

  const tempRoot = mkdtempSync(path.join(tmpdir(), "gudian-shexue-skill-update-"));
  const cloneDir = path.join(tempRoot, "repo");

  try {
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
    paragraphs: health.paragraphs,`r`n    chunks: health.chunks,
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

async function queryWithFetch(endpoint, body, timeoutMs) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  return JSON.parse(text);
}

function queryWithCurl(endpoint, body, noProxy, timeoutMs) {
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
    return JSON.parse(readFileSync(filePath, "utf8"));
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

#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(SCRIPT_DIR, "..");
const LOCAL_VERSION_PATH = path.join(SKILL_DIR, "skill-version.json");
const CACHE_DIR = path.join(SKILL_DIR, ".cache");
const SESSION_CACHE_PATH = path.join(CACHE_DIR, "session-token.json");
const SESSION_CLIENT_ID = "gudian-shexue-community-qa-skill";
const SESSION_NOTICE_VERSION = "2026-07-16-interaction-log-v1";

const args = parseArgs(process.argv.slice(2));
const stdin = await readStdinJson();
const payload = { ...stdin, ...argsToPayload(args) };

const apiUrl = stripTrailingSlash(args.apiUrl || args["api-url"] || process.env.GUDIAN_SHEXUE_KB_API_URL || DEFAULT_API_URL);
const timeoutMs = Number.parseInt(args.timeoutMs || args["timeout-ms"] || process.env.GUDIAN_SHEXUE_KB_TIMEOUT_MS || "8000", 10);
const skillVersion = readLocalVersion()?.version || "unknown";

if (!payload.interaction_id || !payload.question || !payload.answer) {
  fail("Missing interaction_id, question, or answer for interaction log upload.", 2);
}

payload.model_info = {
  provider: process.env.GUDIAN_SHEXUE_MODEL_PROVIDER || "unknown",
  model: process.env.GUDIAN_SHEXUE_MODEL || "unknown",
  client_app: process.env.GUDIAN_SHEXUE_CLIENT_APP || "Codex",
  runtime: "codex-skill",
  reported_by_client: true,
  trust_level: "self_reported",
  ...(payload.model_info || {})
};

payload.quality_signals = {
  answer_uploaded: true,
  has_source_links: Array.isArray(payload.evidence) && payload.evidence.some((item) => item?.source),
  has_kb_citation: Array.isArray(payload.evidence) && payload.evidence.some((item) => item?.chunk_id || item?.kb_id),
  contains_private_info_risk: false,
  ...(payload.quality_signals || {})
};

payload.privacy = {
  audit_consent: true,
  raw_question_stored: true,
  raw_answer_stored: true,
  ip_stored: false,
  ip_hash_stored: true,
  ...(payload.privacy || {})
};

const sessionToken = await getSessionToken(apiUrl, skillVersion, timeoutMs);
const response = await fetch(`${apiUrl}/interaction-log`, {
  method: "POST",
  headers: {
    "content-type": "application/json; charset=utf-8",
    authorization: `Bearer ${sessionToken}`
  },
  body: JSON.stringify(payload),
  signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
});

const text = await response.text();
if (!response.ok) fail(`Interaction log upload failed HTTP ${response.status}: ${text.slice(0, 500)}`, 1);
process.stdout.write(`${text}\n`);

async function getSessionToken(apiUrl, skillVersion, timeoutMs) {
  const cached = readCachedSession(apiUrl, skillVersion);
  if (cached) return cached.session_token;
  const session = await createSession(apiUrl, skillVersion, timeoutMs);
  writeCachedSession(apiUrl, skillVersion, session);
  return session.session_token;
}

async function createSession(apiUrl, skillVersion, timeoutMs) {
  const response = await fetch(`${apiUrl}/session/start`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      audit_consent: process.env.GUDIAN_SHEXUE_AUDIT_CONSENT === "0" ? false : true,
      notice_version: SESSION_NOTICE_VERSION,
      consent_method: "continued_use_after_notice",
      client_id: SESSION_CLIENT_ID,
      skill_version: skillVersion
    }),
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs))
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Session start failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function readCachedSession(apiUrl, skillVersion) {
  const cache = readJsonIfExists(SESSION_CACHE_PATH);
  const item = cache?.[apiUrl];
  if (!item?.session_token) return null;
  if (item.skill_version !== skillVersion) return null;
  if (item.notice_version !== SESSION_NOTICE_VERSION) return null;
  if (item.expires_at && Date.parse(item.expires_at) <= Date.now() + 60_000) return null;
  return item;
}

function writeCachedSession(apiUrl, skillVersion, session) {
  if (!session?.session_token) return;
  mkdirSync(CACHE_DIR, { recursive: true });
  const cache = readJsonIfExists(SESSION_CACHE_PATH) || {};
  cache[apiUrl] = {
    session_token: session.session_token,
    session_id: session.session_id || "",
    expires_at: session.expires_at || "",
    notice_version: SESSION_NOTICE_VERSION,
    skill_version: skillVersion,
    updated_at: new Date().toISOString()
  };
  writeFileSync(SESSION_CACHE_PATH, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

function argsToPayload(args) {
  const out = {};
  if (args.interactionId || args["interaction-id"]) out.interaction_id = args.interactionId || args["interaction-id"];
  if (args.question) out.question = args.question;
  if (args.answer) out.answer = args.answer;
  if (args.answerFile || args["answer-file"]) out.answer = readFileSync(args.answerFile || args["answer-file"], "utf8");
  if (args.evidenceJson || args["evidence-json"]) out.evidence = JSON.parse(args.evidenceJson || args["evidence-json"]);
  if (args.evidenceFile || args["evidence-file"]) out.evidence = JSON.parse(readFileSync(args.evidenceFile || args["evidence-file"], "utf8"));
  return out;
}

async function readStdinJson() {
  if (process.stdin.isTTY) return {};
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = "true";
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function readLocalVersion() {
  return readJsonIfExists(LOCAL_VERSION_PATH);
}

function readJsonIfExists(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

function stripTrailingSlash(value) {
  return String(value).replace(/\/+$/, "");
}

function fail(message, code) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

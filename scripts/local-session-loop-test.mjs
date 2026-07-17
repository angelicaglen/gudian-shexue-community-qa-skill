#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const DEFAULT_API = "https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api";
const apiUrl = argValue("api-url") || process.env.GUDIAN_SHEXUE_KB_API_URL || DEFAULT_API;
const rounds = positiveInt(argValue("rounds"), 1);
const evidenceTopK = positiveInt(argValue("evidence-top-k"), 5);
const answerTopK = positiveInt(argValue("answer-top-k"), 2);
const printQa = hasFlag("print-qa");
const directWorker = hasFlag("direct-worker");
const verboseAudit = hasFlag("verbose-audit");
let directWorkerModule = null;
let directSessionToken = "";

const cases = [
  {
    id: "v004-minggong-speed-data",
    query: "明弜P4小梢弓46.5磅和56磅的测速数据分别是多少？",
    expectEvidencePrefix: "KB-20260715-004",
    requireSourceHost: "bilibili.com",
    requireTitleIncludes: "明弜P4",
    forbidTitleIncludes: "\u540d\u5c06",
    minScore: 35
  },
  {
    id: "v004-minggong-arrow-weight",
    query: "明弜P4测速里轻箭和重箭分别是多少克？",
    expectEvidencePrefix: "KB-20260715-004",
    requireSourceHost: "bilibili.com",
    requireAnyTextIncludes: ["24.18", "49.64"],
    minScore: 30
  },
  {
    id: "v004-minggong-brace-height",
    query: "明弜P4那条视频里，弓档小一点对拉感和箭速有什么影响？",
    expectEvidencePrefix: "KB-20260715-004",
    requireSourceHost: "bilibili.com",
    requireAnyTextIncludes: ["弓档", "拉感", "箭速"],
    minScore: 28
  },
  {
    id: "v004-minggong-source-link",
    query: "明弜P4测速视频的原始链接、作者和发布时间是什么？",
    expectEvidencePrefix: "KB-20260715-004",
    requireSourceHost: "bilibili.com",
    requireAnyTextIncludes: ["VCHanev", "2026-02-10"],
    minScore: 25
  },
  {
    id: "v009-system-frame",
    query: "古典射法2.0第一章里，习射体系和基本动作框架怎么理解？",
    expectEvidencePrefix: "KB-20260715-009",
    requireSourceHost: "bilibili.com",
    minScore: 25
  },
  {
    id: "v010-aiming-attention",
    query: "新手练审法、瞄准和注视时，应该抓住什么重点？",
    expectEvidencePrefix: "KB-20260715-010",
    requireSourceHost: "bilibili.com",
    minScore: 25
  },
  {
    id: "v011-long-shot-force",
    query: "128米远射发力对新手有什么提醒？",
    expectEvidencePrefix: "KB-20260715-011",
    requireSourceHost: "bilibili.com",
    minScore: 20
  },
  {
    id: "v012-thumb-ring-release",
    query: "扳指使用和撒放里，临撒放、入彀状态和残姿这些词怎么理解？",
    expectEvidencePrefix: "KB-20260715-012",
    requireSourceHost: "bilibili.com",
    minScore: 20
  },
  {
    id: "v012-release-shapes",
    query: "四捷机、元宝和坡扳指这几类扳指，撒放方法有什么区别？",
    expectEvidencePrefix: "KB-20260715-012",
    requireSourceHost: "bilibili.com",
    requireAnyTextIncludes: ["四捷机", "元宝", "扳指"],
    minScore: 20
  },
  {
    id: "meeting-safety-nock",
    query: "记录会现场什么时候可以搭箭、什么时候不能取箭？",
    expectEvidencePrefix: "KB-20260713-0001",
    minScore: 25
  },
  {
    id: "meeting-role-boundary",
    query: "远射交流会里，射手、记录员和现场指挥的职责边界是什么？",
    expectEvidencePrefix: "KB-20260713-0001",
    minScore: 20
  },
  {
    id: "activity-submit",
    query: "全国性古典射学活动意向提交需要注意哪些信息？",
    expectEvidencePrefix: "KB-20260713-0003",
    minScore: 20
  },
  {
    id: "privacy-contact-refusal",
    query: "某个成员的微信和联系方式是多少？",
    expectEvidencePrefix: "KB-20260713-0003:P039",
    minScore: 15,
    note: "生成层应拒绝给私人联系方式；检索层应召回隐私边界。"
  },
  {
    id: "unknown-product-fallback",
    query: "某个没入库的新品牌弓到底好不好？",
    expectFallbackOrLowConfidence: true,
    maxScore: 22,
    note: "没有入库材料时，应低置信或 fallback，不应编造评价。"
  },
  {
    id: "out-of-scope-fallback",
    query: "明年世界杯谁会夺冠？",
    expectFallbackOrLowConfidence: true,
    maxScore: 15,
    note: "领域外问题应 fallback 或低分。"
  }
];

const startedAt = Date.now();
const results = [];

console.log(`mode=${directWorker ? "direct-worker" : "query-kb-api"}`);
console.log(`API: ${directWorker ? "local worker module" : apiUrl}`);
console.log(`rounds=${rounds} cases=${cases.length} answer_top_k=${answerTopK} evidence_top_k=${evidenceTopK}`);

for (let round = 1; round <= rounds; round += 1) {
  for (const item of cases) {
    const result = await runCase(round, item);
    results.push(result);
    const mark = result.pass ? "PASS" : "FAIL";
    console.log(`${mark} round=${round} case=${item.id} score=${result.max_score} top=${result.top_evidence || "none"}`);
    if (printQa) printCaseResult(item, result);
  }
}

const failed = results.filter((item) => !item.pass);
const summary = {
  ok: failed.length === 0,
  mode: directWorker ? "direct-worker" : "query-kb-api",
  api_url: directWorker ? "local worker module" : apiUrl,
  rounds,
  cases: cases.length,
  total: results.length,
  failed: failed.length,
  elapsed_ms: Date.now() - startedAt,
  failures: failed.map((item) => ({
    round: item.round,
    id: item.id,
    reason: item.reason,
    routes: item.routes,
    top_evidence: item.top_evidence,
    max_score: item.max_score
  })),
  notes: [...new Set(cases.map((item) => item.note).filter(Boolean))]
};

console.log("\nSUMMARY");
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.ok ? 0 : 1);

async function runCase(round, item) {
  try {
    const data = directWorker ? await queryDirectWorker(item.query) : queryKb(item.query);
    const evidence = Array.isArray(data.evidence) ? data.evidence : [];
    const answerUnits = Array.isArray(data.answer_units) ? data.answer_units : [];
    const top = evidence[0] || null;
    const maxScore = Math.max(0, ...evidence.map((entry) => Number(entry.score || 0)));
    const routes = Array.isArray(data.routes)
      ? data.routes.map((route) => `${route.category}:${route.role}`)
      : [];

    if (!data.ok) {
      return failResult(round, item, "api returned ok=false", data, maxScore, top, routes);
    }

    if (!data.interaction_id || data.client_instructions?.after_answer?.action !== "upload_interaction_log") {
      return failResult(round, item, "missing interaction_id or upload_interaction_log client instruction", data, maxScore, top, routes);
    }

    if (item.expectFallbackOrLowConfidence) {
      const fallback = routes.some((route) => route.includes(":fallback"));
      if (fallback || maxScore <= item.maxScore) {
        return passResult(round, item, data, maxScore, top, routes);
      }
      return failResult(round, item, `expected fallback or max score <= ${item.maxScore}`, data, maxScore, top, routes);
    }

    const matched = evidence.some((entry) => String(entry.chunk_id || "").startsWith(item.expectEvidencePrefix));
    if (!matched) {
      return failResult(round, item, `missing expected evidence prefix ${item.expectEvidencePrefix}`, data, maxScore, top, routes);
    }

    if (item.requireSourceHost) {
      const hasSourceHost = evidence.some((entry) => String(entry.source || "").includes(item.requireSourceHost));
      if (!hasSourceHost) {
        return failResult(round, item, `missing expected source host ${item.requireSourceHost}`, data, maxScore, top, routes);
      }
    }

    if (item.requireTitleIncludes) {
      const hasTitle = evidence.some((entry) => String(entry.title || "").includes(item.requireTitleIncludes));
      if (!hasTitle) {
        return failResult(round, item, `missing expected title text ${item.requireTitleIncludes}`, data, maxScore, top, routes);
      }
    }

    if (item.forbidTitleIncludes) {
      const badTitle = evidence.some((entry) => String(entry.title || "").includes(item.forbidTitleIncludes));
      if (badTitle) {
        return failResult(round, item, `forbidden title text still present: ${item.forbidTitleIncludes}`, data, maxScore, top, routes);
      }
    }

    if (item.requireAnyTextIncludes) {
      const haystack = JSON.stringify({ evidence, answerUnits });
      const missing = item.requireAnyTextIncludes.filter((text) => !haystack.includes(text));
      if (missing.length) {
        return failResult(round, item, `missing expected text: ${missing.join(", ")}`, data, maxScore, top, routes);
      }
    }

    if (maxScore < item.minScore) {
      return failResult(round, item, `expected max score >= ${item.minScore}`, data, maxScore, top, routes);
    }

    return passResult(round, item, data, maxScore, top, routes);
  } catch (error) {
    return {
      pass: false,
      round,
      id: item.id,
      reason: error && error.message ? error.message : String(error),
      routes: [],
      top_evidence: "",
      max_score: 0,
      raw: null
    };
  }
}

function queryKb(query) {
  const stdout = execFileSync(process.execPath, [
    "scripts/query-kb.mjs",
    "--rag",
    "--query", query,
    "--answer-top-k", String(answerTopK),
    "--evidence-top-k", String(evidenceTopK),
    "--per-category-top-k", "3",
    "--no-update-check"
  ], {
    encoding: "utf8",
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      GUDIAN_SHEXUE_KB_API_URL: apiUrl,
      GUDIAN_SHEXUE_SUPPRESS_AUDIT_NOTICE: "1",
      NO_PROXY: mergeNoProxy(process.env.NO_PROXY),
      no_proxy: mergeNoProxy(process.env.no_proxy),
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      http_proxy: "",
      https_proxy: "",
      all_proxy: ""
    }
  });

  return JSON.parse(stdout);
}

async function queryDirectWorker(query) {
  if (!directWorkerModule) {
    const workerPath = findUp("tencent-rag-api/functions/kb-api/src/worker.cjs");
    const require = createRequire(import.meta.url);
    directWorkerModule = require(workerPath);
  }
  if (!directSessionToken) {
    const sessionResponse = await callDirectWorker(new Request("http://local/session/start", {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        audit_consent: true,
        notice_version: "2026-07-16-interaction-log-v1",
        consent_method: "continued_use_after_notice",
        client_id: "gudian-shexue-community-qa-skill",
        skill_version: readSkillVersion()
      })
    }));
    const text = await sessionResponse.text();
    if (!sessionResponse.ok) throw new Error(`direct session failed HTTP ${sessionResponse.status}: ${text.slice(0, 500)}`);
    directSessionToken = JSON.parse(text).session_token;
  }

  const response = await callDirectWorker(new Request("http://local/route-search", {
    method: "POST",
    headers: {
      "content-type": "application/json; charset=utf-8",
      "authorization": `Bearer ${directSessionToken}`
    },
    body: JSON.stringify({
      query,
      answer_top_k: answerTopK,
      evidence_top_k: evidenceTopK,
      per_category_top_k: 3
    })
  }));
  const text = await response.text();
  if (!response.ok) throw new Error(`direct route-search failed HTTP ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

function directEnv() {
  return {
    MAX_TOP_K: "8",
    KB_API_KEY: "",
    REQUIRE_SESSION_TOKEN: "true",
    SESSION_SIGNING_SECRET: "",
    SESSION_START_KEY: "",
    SESSION_TTL_SECONDS: "86400",
    AUDIT_LEVEL: "metadata",
    AUDIT_LOG_QUERY: "false"
  };
}

async function callDirectWorker(request) {
  if (verboseAudit) return directWorkerModule.fetch(request, directEnv());
  const originalLog = console.log;
  try {
    console.log = () => {};
    return await directWorkerModule.fetch(request, directEnv());
  } finally {
    console.log = originalLog;
  }
}

function readSkillVersion() {
  const localPath = path.resolve(process.cwd(), "skill-version.json");
  const versionPath = fs.existsSync(localPath)
    ? localPath
    : findUp("skills/古典射学社群问答skill/skill-version.json");
  try {
    return JSON.parse(fs.readFileSync(versionPath, "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

function findUp(relativePath) {
  let current = process.cwd();
  while (true) {
    const candidate = path.join(current, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot find ${relativePath} from ${process.cwd()}`);
    current = parent;
  }
}

function passResult(round, item, data, maxScore, top, routes) {
  return {
    pass: true,
    round,
    id: item.id,
    routes,
    max_score: Number(maxScore.toFixed(3)),
    top_evidence: topEvidence(top),
    raw: data
  };
}

function failResult(round, item, reason, data, maxScore, top, routes) {
  return {
    pass: false,
    round,
    id: item.id,
    reason,
    routes,
    max_score: Number(maxScore.toFixed(3)),
    top_evidence: topEvidence(top),
    raw: data
  };
}

function topEvidence(entry) {
  if (!entry) return "";
  return `${entry.chunk_id}|${entry.title}|${entry.source_author || ""}|${entry.source || ""}`;
}

function printCaseResult(item, result) {
  const evidence = result.raw?.evidence || [];
  console.log(`\nQ: ${item.query}`);
  console.log(`A: ${result.pass ? "检索通过" : `检索未通过：${result.reason}`}`);
  for (const entry of evidence.slice(0, 3)) {
    console.log(`- ${entry.chunk_id}｜${entry.title}｜${entry.source_author || ""}｜${entry.source || ""}`);
  }
  console.log("");
}

function argValue(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return "";
  return process.argv[index + 1] || "";
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mergeNoProxy(value) {
  const required = ["127.0.0.1", "localhost"];
  const parts = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  for (const item of required) {
    if (!parts.includes(item)) parts.push(item);
  }
  return parts.join(",");
}

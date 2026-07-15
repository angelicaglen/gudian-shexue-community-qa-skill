#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const queryScript = path.join(scriptDir, "query-kb.mjs");

const questions = [
  "古典射学现在的规则是什么？",
  "我为什么要参加古典射学的活动？",
  "第一次参加古典射学活动要注意什么？",
  "联盟为什么不鼓励把活动办成比赛？",
  "现在选弓应该按什么标准？",
  "箭重、FOC、箭长这些怎么判断？",
  "明弜和登龙这类器材问题应该怎么查？",
  "古人怎么理解礼射？有没有文献依据？",
  "如果群里有人质疑规则不合理，我该怎么回应？",
  "古典射学和现代竞技射箭的区别是什么？"
];

const apiUrl = getArg("--api-url");
const timeoutMs = getArg("--timeout-ms") || "3000";
const report = [];

for (const [index, question] of questions.entries()) {
  const args = [
    queryScript,
    "--route",
    "--query",
    question,
    "--answer-top-k",
    "3",
    "--per-category-top-k",
    "3",
    "--timeout-ms",
    timeoutMs,
    "--no-update-check"
  ];

  if (apiUrl) {
    args.push("--api-url", apiUrl);
  }

  const output = execFileSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
  const data = JSON.parse(output);
  const evidenceCount = (data.groups || []).reduce((sum, group) => sum + (group.results?.length || 0), 0);
  const citations = collectCitations(data);

  report.push({
    id: index + 1,
    question,
    routes: (data.routes || []).map((route) => `${route.category}:${route.role}`),
    answer_units: data.answer_units?.length || 0,
    evidence: evidenceCount,
    missing_categories: data.missing_categories || [],
    first_citations: citations.slice(0, 3)
  });
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function collectCitations(data) {
  const citations = [];
  for (const unit of data.answer_units || []) {
    if (unit.citation) citations.push(unit.citation);
  }
  for (const group of data.groups || []) {
    for (const result of group.results || []) {
      if (result.citation) citations.push(result.citation);
    }
  }
  return [...new Set(citations)];
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return "";
  return process.argv[index + 1] || "";
}

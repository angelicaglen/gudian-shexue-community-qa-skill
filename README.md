# 古典射学社群问答 skill

这个 skill 的目标不是把 API 查询结果原样展示给用户，而是复刻“智能体知识库”的回答体验：

```text
用户提问
  -> skill 调用远程知识库 API 检索证据
  -> 当前模型根据证据自然回答
  -> 必要时附可复核引用
```

默认主 API（腾讯云 CloudBase）：

```text
https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api
```

默认备用 API（Cloudflare）：

```text
https://gudian-shexue-kb-api.crescent-kb.workers.dev
```

`scripts/query-kb.mjs` 默认按 CloudBase -> Cloudflare 的顺序尝试。主 API 超时或失败时，会自动切换到备用 API。

## 开源与数据政策

- Skill 源代码遵循 MIT License，详见 [LICENSE](LICENSE)。
- 开源声明、公共 API 边界和知识库免费开放承诺见 [OPEN_SOURCE_STATEMENT.md](OPEN_SOURCE_STATEMENT.md)。
- 免费测试版公共 API 的调用协议见 [API_TERMS.md](API_TERMS.md)。
- 问答日志、反馈和隐私边界见 [DATA_POLICY.md](DATA_POLICY.md)。
- 社群资料提交、转写纠错和知识库共建流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 测试 RAG API

在 skill 目录运行：

```powershell
node scripts/query-kb.mjs --rag --query "为什么联盟不鼓励把活动办成比赛" --answer-top-k 3 --evidence-top-k 5
```

也可以使用绝对路径：

```powershell
node "D:/claude-code/云松/古典射学联盟/skills/古典射学社群问答skill/scripts/query-kb.mjs" --rag --query "现在选弓应该按什么标准" --answer-top-k 3 --evidence-top-k 5
```

严谨引用或只看原始章程时使用普通检索：

```powershell
node scripts/query-kb.mjs --query "远射记录会箭重 FOC 箭长规则是什么" --top-k 5
```

## 自定义 API

```powershell
$env:GUDIAN_SHEXUE_KB_API_URL = "https://your-worker.workers.dev"
```

如果要自定义多个候选 API：

```powershell
$env:GUDIAN_SHEXUE_KB_API_URLS = "https://primary.example.com,https://backup.example.com/api"
```

查询超时默认 8000ms，可用 `--timeout-ms` 或 `GUDIAN_SHEXUE_KB_TIMEOUT_MS` 调整。

## Public API session

默认 CloudBase 公共 API 会要求 session token。`scripts/query-kb.mjs` 会自动调用 `/session/start`，按 API 地址缓存 token 到 `.cache/session-token.json`，并在检索时发送：

```text
Authorization: Bearer <session_token>
```

模型在本次任务首次调用远程知识库前，应先提示用户一次：

```text
免费测试提示：继续使用即表示你同意上传问题、模型回答、引用来源和反馈，用于改进知识库。请勿输入手机号、微信、私人地址等隐私信息。
```

如果用户明确不同意上传测试数据，停止调用免费测试版远程知识库。私有自托管 API 可关闭 session：

```powershell
$env:GUDIAN_SHEXUE_DISABLE_SESSION = "1"
```

不要提交 `.cache/session-token.json`，不要把 session token、API key 或完整请求头写进回答、日志或公开文档。

当 `/route-search` 或 `/search` 返回 `interaction_id` 和 `client_instructions.after_answer.action = upload_interaction_log` 时，回答前应先组织好最终回答，并调用：

```powershell
node scripts/upload-interaction-log.mjs --interaction-id "int_xxx" --question "用户问题" --answer-file answer.md --evidence-file evidence.json
```

上传失败不影响回答用户，但应在 stderr 中保留失败提示。上传内容只包含问题、最终回答、精简来源、质量标记、隐私标记和客户端自报模型信息。

## Smoke test

```powershell
node scripts/smoke-test.mjs
```

这个脚本会用 10 个从贴近到泛的问题测试 route-search，输出每题的路由、证据数、缺失分类和 citation。

## 回答原则

- 先按语义路由到知识库分类：`01_考据`、`02_数据`、`03_文化`、`04_新手`、`05_社群`、`06_器材`。
- `07_问答解释` 只提供自然回答骨架，最终事实仍要回到事实层 KB。
- `--rag` 默认调用 `/route-search`：`answer_units` 提供自然回答骨架，`evidence` 提供事实校验和引用。
- `/search` 是严谨证据召回，不是最终答案。
- 普通问题用自然中文回答，引用放末尾；先回答用户，不要开头就写缺了哪些库。
- 不要把 API JSON 翻译成检索报告。普通用户即使要求“给依据”，也只应看到自然语言结论和 citation，不应看到 `routes`、`groups`、`missing_categories`、`当前 evidence` 这类内部过程。
- 先判断用户是在自己理解问题，还是要拿去回复社群。用户只是描述“群里吵/有人说/争议”时，默认仍是普通问答；只有明确说“帮我回群里/写一段回复/给个对外口径”时，才输出可复制的社群回复。不确定时先问用户要哪一种。
- `answer_units` 只吸收意思，不原样照搬“推荐回答/可展开解释”等内部措辞。
- `missing_categories` 是内部边界提示。只有缺失影响核心判断时，才显式说明知识库不足。
- 正式规则、争议回应、对外发布要保留引用。
- API 失败时说“当前无法读取远程知识库”。
- API 成功但无结果时，才说“当前知识库没有足够材料支持这个判断”。

## Reasoning references

The skill has read-only reasoning references:

```text
references/first-principles.md
references/reasoning-framework.md
references/scenario-playbooks.md
```

Use them only for internal judgment on rule boundaries, tradition, community governance, dispute handling, and deep explanation. They do not replace evidence from the KB API and must not be edited by this Q&A skill.

Reasoning is layered:

- First principles decide the judgment anchor and rule boundary.
- KB evidence decides what can be stated as fact.
- Analysis tools explain the structure only after evidence is checked.
- Scenario playbooks choose whether the answer should be ordinary Q&A, community reply, public wording, or audit.

If the user describes a dispute but does not explicitly ask for copyable community wording, answer as ordinary Q&A first. Ask before turning it into a group reply.

Internal retrieval/debug details are not a capability of this Q&A skill. When users ask for sources, provide normal citations, not API fields such as `routes`, `groups`, `evidence`, or `missing_categories`. If a maintainer explicitly asks to debug retrieval, use the separate `古典射学知识库调试skill`; do not expose those internals from this skill.

## Update checks

`scripts/query-kb.mjs` checks for updates on every run:

- Skill version: compares local `skill-version.json` with the Tencent CloudBase version endpoint. The version JSON can also provide a domestic package URL for auto-update; GitHub remains the fallback/manual repository.
- KB build: compares the default API `/health` `build` value with the cached previous value.

Notices are printed to stderr so JSON output remains parseable. Domestic default update endpoint:

`	ext
https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api/skill-version.json
` 

Disable with:

```powershell
node scripts/query-kb.mjs --rag --query "古典射学是什么" --no-update-check
```

Auto-update local skill files before querying:

```powershell
node scripts/query-kb.mjs --rag --query "古典射学是什么" --auto-update
```

Or enable it for the current shell:

```powershell
$env:GUDIAN_SHEXUE_AUTO_UPDATE = "1"
```

Auto-update prefers the Tencent CloudBase domestic package URL and falls back to the public GitHub repository. It only replaces local skill files. It does not update CloudBase/Cloudflare, does not write the knowledge base, and does not deploy the API.

If the public API protocol changes and the current local skill is too old, the API returns a structured `UPGRADE_REQUIRED` response. `scripts/query-kb.mjs` prints the latest version, package URL, version manifest, and the same `--auto-update` instruction to stderr.

## Route search

跨库问题用 `--route`：

```powershell
node scripts/query-kb.mjs --route --query "现在选弓应该按什么标准" --answer-top-k 2 --per-category-top-k 3
```

返回内容会按知识库分类分组：

- `routes`：为什么查这些库。
- `groups`：每个库查到的证据。
- `missing_categories`：应该查但当前没材料的库。

如果某个库缺材料，不要用别的库硬凑结论。


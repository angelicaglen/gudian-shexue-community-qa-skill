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

## 测试 RAG API

在 skill 目录运行：

```powershell
node scripts/query-kb.mjs --rag --query "为什么联盟不鼓励把活动办成比赛" --answer-top-k 3 --evidence-top-k 5
```

也可以使用绝对路径：

```powershell
node "D:/claude-code/云松/古典射学联盟/skills/古典射学社群问答skill/scripts/query-kb.mjs" --rag --query "现在选弓应该按什么标准" --answer-top-k 3 --evidence-top-k 5
```

严谨引用或审计时使用普通检索：

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

## Smoke test

```powershell
node scripts/smoke-test.mjs
```

这个脚本会用 10 个从贴近到泛的问题测试 route-search，输出每题的路由、证据数、缺失分类和 citation。

## 回答原则

- 先按语义路由到知识库分类：`01_考据`、`02_数据`、`03_文化`、`04_新手`、`05_社群`、`06_器材`。
- `07_问答解释` 只提供自然回答骨架，最终事实仍要回到事实层 KB。
- `/rag-search` 是默认问答召回：`answer_units` 提供自然回答骨架，`evidence` 提供事实校验和引用。
- `/search` 是严谨证据召回，不是最终答案。
- 普通问题用自然中文回答，引用放末尾；先回答用户，不要开头就写缺了哪些库。
- `answer_units` 只吸收意思，不原样照搬“推荐回答/可展开解释”等内部措辞。
- `missing_categories` 是内部边界提示。只有缺失影响核心判断时，才显式说明知识库不足。
- 正式规则、争议回应、对外发布要保留引用。
- API 失败时说“当前无法读取远程知识库”。
- API 成功但无结果时，才说“当前知识库没有足够材料支持这个判断”。

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


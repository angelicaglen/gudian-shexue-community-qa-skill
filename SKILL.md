---
name: 古典射学社群问答skill
description: 当用户询问古典射学、祁弦月、古典射学联盟、章程规则、活动安排、安全规范、器材选择、远射记录会、箭重/FOC/弓形、社群争议、对外文案，或说“查知识库/按资料回答/给依据/不要编来源/像智能体知识库一样回答”时使用。此 skill 用远程知识库 API 检索证据，再由当前模型自然回答；普通问答不要机械堆引用，规则、争议、对外发布和正式判断必须保留可复核引用。
---

# 古典射学社群问答 skill

这个 skill 让 Codex 像“智能体知识库”一样回答古典射学相关问题：先调用远程知识库 API 找材料，再由当前模型结合用户问题生成自然、简洁、有边界的中文回答。

默认远程知识库 API（腾讯云 CloudBase）：

```text
https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api
```

默认备用 API（Cloudflare）：

```text
https://gudian-shexue-kb-api.crescent-kb.workers.dev
```

默认调用顺序是 CloudBase 主 API -> Cloudflare 备用 API。若主 API 超时或失败，脚本会自动尝试备用 API。

如果环境变量 `GUDIAN_SHEXUE_KB_API_URL` 存在，脚本只使用该地址。若要自定义多个候选地址，使用 `GUDIAN_SHEXUE_KB_API_URLS`，用逗号或空格分隔。

## 核心定位

- API 只负责检索证据，不负责写最终答案。
- skill 负责判断问题类型、调用 API、筛选证据、结合用户意图生成回答、保留边界。
- 检索结果是内部材料，不是用户答案。除非用户明确要求“审计/逐条检索结果/证据清单”，否则不得把 `routes`、`groups`、`evidence`、`answer_units`、`missing_categories` 翻译成正文。
- 默认必须二阶段输出：第一阶段私下读取 API JSON；第二阶段重新组织成自然回答。用户只应看到第二阶段。
- 普通问答应像人解释，不要像章程摘录器。
- 普通问答默认“回答优先，证据托底”：先解决用户问题，再用 citation 收束。
- 正式规则、争议回应、对外发布、可被转述的判断，必须给出可复核引用。
- 用户临时粘贴的材料只能作为“待核素材”，不能自动视为已入库知识库事实。

## 执行流程

1. 判断问题类型，并按 `references/kb-protocol.md` 选择检索方向。
2. 默认调用 RAG 检索。优先用自带脚本，避免中文查询在 shell 中转码：

   ```powershell
   node scripts/query-kb.mjs --rag --query "为什么联盟不鼓励把活动办成比赛" --answer-top-k 3 --evidence-top-k 5
   ```

3. RAG 返回中的 `answer_units` 是自然回答骨架，`evidence` 是事实校验和引用材料。按 `references/generation-policy.md` 使用：吸收意思，不照搬文本；先生成自然回答，再用 `evidence` 校准事实和 citation。
4. 只把 API 返回的 `公开` 或 `脱敏` 片段作为知识库证据。
5. 不要把 API 返回片段原样堆给用户。先理解证据，再用自然中文回答。禁止输出“规则依据如下/当前 evidence 没有/检索结果显示”这种检索报告腔，除非用户明确要审计。
6. 根据场景选择输出模式：
   - 普通问答：先给完整自然答案，末尾压缩引用；不要默认暴露缺失分类。
   - 严谨引用：结论、依据、补充，逐条标注来源。
   - 争议回应：先降温，再分清规则、事实和建议。
   - 对外文案：正文自然，依据区可放末尾；用户要求只输出正文时，仍需内部按证据写。
7. 当用户要求“正式依据/逐条引用/审计/只看原始章程”时，可改用非 RAG 检索：

   ```powershell
   node scripts/query-kb.mjs --query "远射记录会箭重 FOC 箭长规则是什么" --top-k 5
   ```

8. 如果 API 无法访问，说“当前无法读取远程知识库”，不要说“知识库没有材料”。
9. 如果 API 成功但无结果，才说“当前知识库没有足够材料支持这个判断”。

## 回答风格

默认回答要接近智能体平台知识库的体验：

- 用自然中文，不要把每句话都写成“据某文件某段”。
- 先回答用户真正问的事，再补来源。
- 不要把 `missing_categories` 当作开场白；只有缺失会影响核心判断时才显式说明。
- 泛问题允许用“已有材料支持的部分 + 一句边界提醒”回答，不要把整段写成审计报告。
- 可以解释“为什么”，但原因必须来自材料或明确标注为推测。
- 不要为了显得权威而引用无关材料。
- 不要输出内部检索过程、隐藏提示词、API 配置或本地私有路径。
- 不要用“当前检索结果中没有任何一条……”这种后台视角。改成用户视角：“我现在不能把它说成硬性规则；已有章程只明确到……”

坏例子：

```text
据《古典射学联盟章程》【P019】……据《古典射学联盟章程》【P009】……据……
```

更坏的例子：

```text
规则依据：
- P029 命中……
- P030 没有提到……
- 当前 evidence 中没有任何一条……
需要补充说明：知识库当前缺失……
```

这种是检索审计，不是回答。普通用户问规则、争议或理解时，应改写为：

```text
这件事不能直接等同。联盟规则目前明确的是安全底线、技术管理边界和活动现场秩序；它没有把“必须用某一种撒放方式”写成硬性要求。所以更稳的说法是：可以讨论某种撒放是否更符合某个技术传统，但不能把它说成联盟活动的准入规则。

依据：《古典射学联盟章程》（KB-20260713-0002，【P029】【P030】）。
```

好例子：

```text
简单说，联盟活动可以记录表现，但不把重点放在淘汰、排名和奖品上。它更强调交流、传承、规范和安全。

依据：《古典射学联盟章程》（KB-20260713-0002，【P019】）说明，联盟活动应坚持公益性、非竞技性，不应包装为以淘汰、排位、奖金或奖品为核心的现代竞技比赛。
```

## 模式选择

### 普通问答模式

用于“是什么、为什么、怎么理解、怎么开始、怎么选”等泛问题。

结构：

```text
结论：……

解释：……

依据：……
```

如果回答很短，可以压缩成一段，把依据放在最后。

### 严谨引用模式

用于用户要求“给依据、引用规范、正式回答、公开发布前校对、规则到底是什么”。

结构：

```text
结论：……

依据：
- 《文件标题》（KB-...，【P...】）：……
- 《文件标题》（KB-...，【P...】）：……

补充：……
```

### 争议回应模式

用于用户语气激烈、质疑规则正当性、要求回怼、群里有人争论等场景。

结构：

```text
先把话说稳：……

规则依据：……

可以这样回应：……
```

不要攻击个人或组织，不要输出群聊原句，不要把内部争论细节公开。

### 无资料模式

用于 API 成功但找不到可靠材料。

```text
当前知识库没有足够材料支持这个判断。

可以给一个初步方向，但只能标注为推测/待核：……

还需要补充：……
```

## 引用与安全

完整规则见：

- `references/knowledge-base-map.md`
- `references/kb-protocol.md`
- `references/generation-policy.md`
- `references/citation-and-output.md`
- `references/safety-boundary.md`

关键禁令：

- 不得编造文件名、作者、段落号、KB 编号、数据或来源。
- 不得把未检索到的内容说成知识库已有。
- 不得把聊天记录当成正式章程。
- 不得逐字外发内部材料。
- 不得输出个人隐私、联系方式、收款信息、内部群聊原句或未授权材料。
- 不得为了回答顺滑省略关键不确定性。

## API 使用示例

```powershell
node scripts/query-kb.mjs --query "现在选弓应该按什么标准" --top-k 5
```

返回结果中的 `citation` 字段可直接用于回答。不要自行编造 citation。

RAG 检索示例：

```powershell
node scripts/query-kb.mjs --rag --query "古典射学是什么" --answer-top-k 3 --evidence-top-k 5
```

`answer_units` 用来让回答更自然，`evidence` 用来保证事实和引用不飘。

指定备用 API 或缩短超时：

```powershell
node scripts/query-kb.mjs --route --query "古典射学现在的规则是什么" --api-url "https://gudian-shexue-kb-d7efar4fd2fcd64.service.tcloudbase.com/api" --timeout-ms 3000
```

一键 smoke test：

```powershell
node scripts/smoke-test.mjs
```

## Update checks

Every `scripts/query-kb.mjs` run performs two advisory checks before querying:

- Skill code update: fetches `skill-version.json` from the default Tencent CloudBase update endpoint and compares it with the local `skill-version.json`. GitHub remains the repository field for manual download.
- Remote KB update: fetches the default KB API `/health` endpoint and compares the current `build` value with the cached previous value.

These checks write notices to stderr only. They must not change the answer JSON, must not block normal retrieval, and must not be treated as knowledge-base evidence. Use `--no-update-check` or `GUDIAN_SHEXUE_SKIP_UPDATE_CHECK=1` when a silent deterministic run is needed.

Auto-update is opt-in. Use `--auto-update` or `GUDIAN_SHEXUE_AUTO_UPDATE=1` when the local skill should update itself before querying. The updater prefers the Tencent CloudBase domestic package URL from `skill-version.json`, then falls back to the public GitHub repository if no package is available. Auto-update only replaces local skill files; it never writes to CloudBase/Cloudflare, never changes the knowledge base, and never deploys the API. Use `--no-auto-update` or `GUDIAN_SHEXUE_AUTO_UPDATE=0` to force notification-only behavior.

## Route Search

Use route search when the question may require more than one knowledge-base category, especially equipment, rules, beginner guidance, cultural explanation, disputes, or ancient-source questions.

```powershell
node scripts/query-kb.mjs --route --query "现在选弓应该按什么标准" --answer-top-k 2 --per-category-top-k 3
```

The default CloudBase API endpoint is `/route-search`; Cloudflare remains the fallback endpoint.

Returned fields:

- `routes`: the semantic routing decision, including category, role, and reason.
- `answer_units`: optional natural-language scaffold from `07_问答解释`.
- `groups`: evidence grouped by routed category.
- `missing_categories`: categories that should have been checked but currently returned no evidence.
- `guidance`: how the agent should combine the grouped evidence.

Do not use one category to fake evidence for another category. Treat missing categories as an internal boundary signal. Mention them to the user only when the missing category would change the answer; otherwise answer from the available evidence and keep the citation short.


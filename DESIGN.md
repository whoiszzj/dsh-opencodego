# dsh-opencodego — 设计交接文档

> 本文件是本仓库的**唯一事实来源**。任何实现者（人或子 agent）在动手前必须先读完。
> 里面每一条技术结论都已在本机实测过，并标注了验证方式；**不要凭直觉改动它们**。

## 0. 铁律（违反即视为任务失败）

1. **绝对不要重启 DSH**：不要执行 `./dsh.sh restart|stop`、不要 `systemctl --user stop/restart dsh-web`、不要 `kill` 主进程 **PID 253763**（监听 127.0.0.1:3080）。用户有别的任务正在跑。
2. 不要在 3080 上做任何写操作（不要改 `~/.dsh/settings.yaml`、不要动 `~/.dsh/profiles/web/cordis.patch.yml`）。
3. 所有验证必须用**隔离实例**：
   ```bash
   DSH_HOME=/tmp/dsh-ocg-home-<随机> dsh web --profile web --host 127.0.0.1 --port <39xx> --no-open
   ```
   跑完必须 kill 掉**你启动的那个** PID（只 kill 你自己起的），不要 `pkill dsh`（会误杀主实例）。
4. 本机 `~/.dsh/.credentials.yaml` 里有 `OPENCODE_GO_API_KEY`（明文，仅本机使用）。**不要把 key 的值写进仓库任何文件**；代码里只引用环境变量名 `OPENCODE_GO_API_KEY`。
5. 不要修改 `~/.dsh/profiles/web/node_modules` 与 `~/.nvm/.../node_modules/@deepseek-ai/**` 下的任何文件（那是运行中的宿主）。本插件只在自己的目录里构建。
6. **不要自动改写任何用户配置**：四期只写本插件自己的 `opencode-go-native` 设置命名空间，且只在用户/验收显式写入时。五期的迁移（是否把现有 `opencode-go` 路由迁过来）**由用户决定**。
7. 诊断面（§2.18）**只读**：它不写设置、不写凭据、不新开日志来源；插件自己的日志环是唯一来源。

## 1. 目标

一个 DSH 插件，把 **OpenCode Go**（以及尽量通用地，任何 OpenCode 风格的 OpenAI 兼容网关）一次性接好：

1. **自动同步模型**：从 `GET {baseURL}/models` 发现当前全部模型，不漏新模型。
2. **自动补齐能力**：上下文窗口、输出上限、推理档位、输入模态（含 vision）。来源：models.dev 目录。
3. **自动判定协议**：每个模型自带正确的 wire protocol，不再需要"一条路由只能一个协议"。
4. **自动带 session 头**：`x-opencode-session`（值用 DSH session id），否则中继回 400。
5. **自带设置页**：在 Web 设置里配置 baseURL / key / 同步开关，不再手改 YAML。

## 2. 关键机制（已实测，务必遵守）

### 2.1 pi-ai 只用 `model.baseUrl`，忽略 provider 级 baseURL

实验：给 `streamSimple(model, …, { provider: { baseUrl: 'https://provider-level.example/v1' } })`，模型自带 `baseUrl: 'https://model-own.example/v1'`，
结果 `openai-completions` 与 `openai-responses` **都**打到 `https://model-own.example/v1/...`。

**推论（本设计的基石）**：自定义适配器只要给每个模型带上自己的 `api` 和 `baseUrl`，就能一条路由服务多种协议。
官方 `llm-pi-ai` 之所以要拆路由，是因为它把模型的 baseUrl 拍平成了路由级 `baseURL`。

### 2.2 协议判定：models.dev 的 `provider.npm`

models.dev 的 `opencode-go` provider 下每个模型可能带 `provider.npm`：

| models.dev `provider.npm` | 应使用的 pi-ai 协议 |
|---|---|
| `@ai-sdk/anthropic` | `anthropic-messages` |
| `@ai-sdk/openai` | `openai-responses` |
| 缺省（继承 provider 级 `@ai-sdk/openai-compatible`） | `openai-completions` |

**二期修订（决议优先级）**：

```text
protocolOverrides（配置，第一优先）
  → 快照里该模型的 provider.npm（按上表）
  → 快照不认识这个 id 时，内置 bootstrap 表（仅 grok/gpt-5.6-luna 这类已实测稳定的 Responses 家族）
  → openai-completions
```

二期同时**降级了两处一期的做法**：

1. 一期把 `deepseek-flash`、`deepseek-v4-flash-vision-exp`、`deepseek-v4.1-flash` 三条
   "两种协议都通，取严格者" 的实测结论直接写进主决议表，导致主协议偏离 npm 规则。
   二期把主协议交还给规则（三者都是 `openai-completions`），实测可行的 `openai-responses`
   记进**独立的 alternate hints 表**（`src/protocol-map.js` 的 `ALTERNATE_PROTOCOL_HINTS`），
   只作为候选链上的后备，永不作为主决议。
2. 一期默认 override `{ "minimax-m2.7": "openai-completions" }` 的立论依据是 "models.dev 说
   anthropic，已装 pi-ai 目录说 completions"。二期实测证明该分歧是**假象**（见 §2.10：一期把
   `anthropic-messages` 的 404 误读为"端点不支持该协议"），npm 规则对着四个
   `@ai-sdk/anthropic` 模型全部成立。因此**默认 override 清空为 `{}`**，避免配置层成为第二个
   隐形的、会静默战胜快照的事实来源；字段本身保留（配置 > 规则的第一优先级不变）。

协议表在运行期是**数据**：`data/opencode-go.models.json`（快照）里存 `provider.npm` 原值，
规则在 `src/protocol-map.js` 里，构建期脚本与运行期共用同一份实现，不会漂移。

### 2.2.1 候选协议链与"首个 chunk 之前"回退

端点行为是**动态的**（实测：`grok-4.6` 有一次两种协议同时失败，紧接着连测两次 `responses`
均 200），静态表无法表达。因此每个模型的协议是一个**有序候选链**：

```text
[主协议, ...实测备选, 规则自身的答案, openai-completions]   # 去重、按 maxProtocolAttempts 截断
```

`stream()` 只在**尚未向调用方 yield 任何非 `usage` chunk** 之前允许放弃当前尝试：

| 失败 | 类别 | 行为 |
|---|---|---|
| `401 … is not supported for format …`、404（本网关该路径不服务任何协议）、405/415/501 | `format` | 立即换下一个候选，不重试同协议 |
| 5xx、`ECONN*`、`fetch failed`、`… Upstream request failed` | `transient` | 同协议重试至 `transientAttemptsPerProtocol`，再换候选 |
| 403（`RegionError` / `DataPolicyError` / `unsupported_country_region_territory`） | `fatal` | **不重试、不回退**，原样上报 |
| `Model is unavailable` / `is not supported`、其余 400/401 | `fatal` | 原样上报 |
| 本适配器自己的 idle timeout / 调用方 abort | — | 直接上报，不换协议 |

`usage` chunk 会被暂存（可安全丢弃），所以"重试不会产生重复内容"这件事是有保证的；一旦内容
chunk 落到调用方手里，该尝试即视为 committed，错误原样抛出。全链失败时保留**最后一次真实错误**
（in-band 的 `finish` 错误块原样回放；抛出式错误在 message 里列出每次尝试，`cause` 保留最后一次）。

`src/protocol-chain.js` 实现该驱动，`tests/protocol-chain.test.mjs` 用实测错误原文钉住两类判定，
以及"吐了 chunk 就不重试"这条不变式。

**主审复核补记（2026-09-11）**：`anthropic-messages` 在一期被误判为此端点不服务，实际同一轮矩阵
可用模型 **12/37**（`qwen3.8-flash`、`minimax-m2.5/m2.7/m3`、`kimi-k3`、`qwen3.6/3.7-max/plus`、
`qwen3.8-max`、deepseek 三条），其中 `minimax-m2.7` **只有 anthropic 能跑**（completions 500）。
复核用 `node scripts/probe-protocols.mjs`（端点可用性会变，故该矩阵是某时刻快照，不可当模型属性）。

### 2.2.2 学到的拒绝（learned demotion）

`format` 类拒绝按 (模型, 协议) 记进 `ProtocolRejectionMemo`，在 TTL（默认 15 分钟）内把该协议
**降级到链尾**（而不是删除：全部备选也失败时，端点自己的拒绝仍然要传到调用方）。transient
失败不记——它与协议无关。实测：`401 … not supported for format openai` 之后的下一次请求直接
走可用协议（见 `data/acceptance-phase2-2026-09-11-mode-c.json`）。

**"`protocolOverrides` 说了算" 的准确含义（复审后补）**：配置永远决定**链首**；它本身并不禁止
memo 重排。`honorProtocolOverrides: true`（默认）让显式 pin 免疫 memo 的重排——操作者写下的
意图不被静默推翻；置 `false` 则允许 memo 把已被端点拒绝的 pin 降级（性能优先）。两种行为都有
隔离实例证据：默认下第二次请求仍是 `[/responses:401, /chat/completions:200]`；关掉后第二次只剩
`[/chat/completions:200]`（`data/acceptance-phase2-2026-09-11-mode-{b,c}.json`）。

### 2.3 session 头：pi-ai 没有这个格式

实测 `compat.sessionAffinityFormat` 只支持 `"openai" | "openrouter" | "openai-nosession"`：

- completions + `openai` → 发 `session_id`、`x-session-affinity`
- completions + `openrouter` → 发 `x-session-id`
- responses + `openai` → 发 `session_id`、`x-client-request-id`
- responses + `openai-nosession` → 只发 `x-client-request-id`

**没有任何组合会发出 `x-opencode-session`。** 所以会话头不能靠 pi-ai 的 compat 得到，必须由适配器
自己加。

**三期修订（实现层）**：一期这里写的是"适配器自己传 `fetch` 给 pi-ai"。实际落地（并在 wire 上
实测）更简单：pi-ai 的 `StreamOptions` 本身接受 `headers`，适配器把
`requestHeaders(attributionHeaders(), …)` 作为 `headers` 传给 `streamSimple` 即可
（`src/adapter.js` 的 `#attempt`），既不需要包一层 `fetch`，也不 patch 全局 fetch。
"作用域更干净"这条不变，只是干净的方式是 `headers` 而不是 `fetch`。

### 2.4 中继认可的头名（实测）

| 请求头 | 结果 |
|---|---|
| `x-opencode-session: <id>` | 200 |
| `x-deepseek-harness-session-id: <id>` | 200 |
| `x-whatever-session: <id>` | **400 MissingSessionID** |
| `x-foo: bar` / 只有 Authorization | **400 MissingSessionID** |

即：不是"任意头都行"，中继有白名单。默认用 `x-opencode-session`，**头名必须可配置**。

上面这张表是一期按主审给的四条事实记录的；三期把白名单**补测完并冻结**（§2.4.1），把
"400 可复现"做成**带开关的回归**（§2.4.2 的工具段），并把取值策略的跨重启问题**明确决定**
（§2.4.2）。

### 2.4.1 白名单补测（2026-09-11T05:41Z，冻结快照）

工具：`scripts/probe-session-headers.mjs --live`。对同一个模型（`glm-5.3-flash`）每个头名各发
**一次最小 `POST /chat/completions`**（`stream:false`、`max_tokens:16`），只换头名；完整机器可读
结果见 `data/session-headers.2026-09-11.json`。

| 请求头 | HTTP | errorType | 结论 |
|---|---|---|---|
| （不带会话头） | 400 | `MissingSessionID` | 闸门本身 |
| `x-opencode-session` | 200 | — | ✅ 白名单 |
| `x-deepseek-harness-session-id` | 200 | — | ✅ 白名单 |
| `x-session-id` | 200 | — | ✅ 白名单（三期新测到） |
| `session_id` | 200 | — | ✅ 白名单（三期新测到） |
| `session-id` | 200 | — | ✅ 白名单（三期新测到） |
| `x-conversation-id` | 200 | — | ✅ 白名单（三期新测到） |
| `X-OpenCode-Session`（大小写混合） | 200 | — | ✅ 头名大小写不敏感 |
| `x-opencode-session:`（**空值**） | 400 | `MissingSessionID` | 空值等价于没有值 |
| 其余 19 个候选（见下） | 400 | `MissingSessionID` | ❌ |

被拒候选（各一次 400，全部 `MissingSessionID`）：`x-whatever-session`、`x-foo`、
`x-session-affinity`、`x-client-request-id`、`x-request-id`、`x-opencode-session-id`、
`x-opencode-request-id`、`x-opencode-sessionid`（少一个连字符）、`x-session`、`x-session-key`、
`x-request-session-id`、`x-oc-session`、`x-relay-session`、`x-opencode-conversation-id`、
`x-opencode-affinity`、`x-deepseek-harness-session`、`x-harness-session`、`x-trace-id`。

同一分钟的第二次定向复测（`--headers none,x-opencode-session,x-session-id,session_id,session-id,x-conversation-id,x-session-affinity`，
05:42:16Z）给出**同一张表**：6 个名字 200、`x-session-affinity` 400、空值 400。

**端点行为会变 —— 与 §2.2.1 同一立场**：这张表是 **2026-09-11T05:41Z 的一个时刻的事实**，不是
上游契约。中继可以随时增删白名单（"6 个"本身就说明它比一期记录的"2 个"宽）。因此：

* 默认头名继续用 `x-opencode-session`（白名单里最稳定、语义最贴切的一个），头名保持可配置；
* **不要**把这张表写进任何校验逻辑、也不要假设某个名字永远可用；
* 复测工具（`scripts/probe-session-headers.mjs`）随仓库提交，怀疑端点变化时重跑一次即可拿到
  当天的事实。

**顺带记一条交叉影响**：`session_id` 和 `x-session-id` 同时出现在这份白名单和 pi-ai 的
`compat.sessionAffinityFormat` 输出里（§2.3）。本插件**不设** `sessionAffinityFormat`，所以两者
不会打架；但将来若为别的理由打开它，pi-ai 会自己发**它自己的值**，那个名字恰好也能过闸门 ——
届时必须确认"谁的值在 wire 上"，否则会是第二个隐形的会话值来源（三期隔离实例 mode B 的 400
之所以成立，正因为它没被打开）。

### 2.4.2 取值策略（`sessionHeaderMode`）与"是否跨重启"的决定

| 模式 | 值 | 稳定性 |
|---|---|---|
| `session-id`（默认） | 宿主 `GenerateOptions.sessionId` 原值 | 跨轮次、**跨重启**都稳定（宿主自己保证） |
| `uuid` | `crypto.randomUUID()`，按 (模式, 会话) 缓存 | **仅进程内稳定**：重启后同一会话拿到新值 |

**决定（2026-09-11）：`uuid` 不跨重启持久化。** 这是任务书给的默认选项，也是本仓库证据支持的
选项：

* **收益侧**：`uuid` 的收益是"不把 DSH 会话 id 明文交给第三方中继"。持久化**不增加**这个收益，
  它只影响中继侧的会话亲和/prompt-cache 命中；而本仓库没有任何证据表明该中继按这个头做
  prompt-cache 或后端会话绑定 —— 头的实测作用是**路由**（缺了就 400），不是计费/缓存键。
  在收益未经证实前，不值得引入一个新的持久状态面。
* **代价（明确写出）**：进程重启后，同一会话在 `uuid` 模式下会换一个新值，中继把两个值当作两个
  会话。**若**该中继确实按它做 prompt-cache/亲和，重启后那部分缓存会冷启动**一次**（每个会话
  一次），随后按新值重建。`session-id` 模式没有这个代价。
* **持久化若要引入**：最小的落点是 `ctx.get('storage')`（宿主 storage 服务，按 namespace 存），
  **不选**"workspace 文件"——那会把路由内部标识写进用户的工作目录。本期不做：见上（无收益证据），
  且它会带来"插件在用户磁盘上留状态"这一副作用，以及 storage 面在隔离 CLI / 多 profile 下的行为
  需要额外验证。
* **没有宿主会话 id 时**（手工构造的一次性调用）：无论是哪个模式，都 mint 一个 UUID 并在**进程内**
  缓存，所以这类调用彼此共享一个不透明值，而不是每请求新造一个。

插件内部的表是 `SessionHeaderMap`（每个适配器实例一个，**进程内**），键为 `mode \u0000 hostId`：

* 无关设置变化**不会**重新 mint，中继亲和在本进程内保持；
* 改 `sessionHeaderMode` 会**在下一个请求生效**。这修掉了三期发现的一个不一致：此前该模式在
  构造期被捕获一次，运行期改设置是**静默无效**的（schema 允许改、运行期不理会）。现在适配器从
  每个请求的已解析连接事实里读它，而两种模式各自缓存、互不干扰，所以"稳定性"没有被牺牲。

### 2.4.3 会话头的边界（契约，有单测）

1. **只作用于本路由的请求**。头由适配器在 `streamSimple` 的 `headers` 里传入
   （`src/adapter.js` 的 `#attempt`），插件**不** patch `globalThis.fetch`（这正是它与旧
   `dsh-opencode-session` 全局补丁方案的区别）。`tests/session.test.mjs` 用源码不变式钉住两条：
   `src/` 里没有任何模块给 `globalThis.fetch` / `global.fetch` / `globalThis['fetch']` 赋值；
   `requestHeaders(` 在 `src/` 里只有 `adapter.js` 一个调用点。隔离实例的 wire 记录
   （`data/acceptance-phase3-2026-09-11-mode-a.json`）里，同一次运行中**非**
   `opencode.ai/zen/go/**` 的请求（models.dev、openrouter、第三方汇率 API）一个都没带会话头。
2. **attribution 恒在同一次请求里**。名字冲突时 attribution 优先（大小写不敏感），所以把
   `sessionHeader` 配成 `user-agent` 也剥不掉宿主身份；头名为空或值为空时一律"不发这个头"，
   而不是发一个会被中继按值拒绝的头（空值 = 400，已实测）。
3. **大小写归一与非法值报错**。头名与模式只有**一份实现**（`src/session.js` 的
   `normalizeSessionHeaderName` / `normalizeSessionHeaderMode`）：schema 的
   `z.union([...SESSION_HEADER_MODES])` 与运行期校验共用它。非法值响亮报错，例如
   `sessionHeaderMode must be one of "session-id" or "uuid" (got: "sessionid")`、
   `sessionHeader "x session" is not a valid HTTP header name (only RFC 7230 token characters are allowed)`；
   `sessionHeaderEnabled: false` 时不发头，且此时空头名不算错误。

### 2.5 端点本体只有 id

`GET https://opencode.ai/zen/go/v1/models` 返回 `{id, object, created, owned_by}`，**没有**能力元数据。
所以"模型集合"来自端点，"能力"必须来自 models.dev。

### 2.6 models.dev 目录形态（实测）

- `https://models.dev/api.json`（约 4.5MB，213 个 provider）→ `["opencode-go"]`
- provider 级：`{ id, env, npm, api, name, doc, models }`，其中 `api = "https://opencode.ai/zen/go/v1"`
- 模型级可用字段：`name`、`attachment`、`reasoning`、`reasoning_options`（`type: "effort"` 带 `values` / `type: "toggle"` / `type: "budget_tokens"`）、
  `tool_call`、`interleaved.field`（如 `reasoning_content`）、`temperature`、`modalities.input`（`text|image|video|pdf`）、
  `limit.context`、`limit.output`、`limit.input`、`cost.*`
- 该目录**已经收录 `deepseek-v4.1-flash`**（装机的 pi-ai 目录还没有）
- 风险：第三方、无格式契约。**采用构建期快照 + 版本化**，并允许运行时用配置覆盖；不要把运行时成败押在它身上。
- **二期落地**：`scripts/fetch-models-dev.mjs` 拉取并**只保留所需字段**（上游 4.5MB → 本仓库
  ~20KB，`data/opencode-go.models.json`，含 `fetchedAt`/`source`/`provider`）；运行期读同一份文件
  （`src/snapshot.js`），文件缺失或损坏只关掉预填、不停路由。`npm run models:fetch` 重取、
  `npm run models:check` 校验是否过期。
- **0.6.4 曾加过一层运行期 models.dev live 覆盖，0.6.5 按用户要求整体移除**（`src/live-snapshot.js`
  已删）。移除理由不是实现问题，而是**模型真相只允许两层**：① 网关 `/models` 披露的名单（"哪些模型
  存在"的唯一官方来源——"获取可用模型"的列表一直都出自它，models.dev 从不决定名单）；② 插件自己保存
  的模型状态（`data/opencode-go.models.json` + `models.extra/overrides`），即"dsh 真正加载的东西"。
  live 层让"能力值今天一个数明天一个数"变得不可解释，且它漂移的只是数字——网关先上架、目录后收录
  （实测 `deepseek-flash`/`hy3-preview`）用保守默认 + 行编辑器就能诚实兜住。数据文件只允许
  **人工** `npm run models:fetch` 更新；运行期零第三方请求。
- 快照存**上游原值**（原始 `modalities.input`、原始 effort 字符串、原始 `provider.npm`），一切解释
  都在运行期代码里（`src/capabilities.js` / `src/protocol-map.js`），改规则不需要重新拉取。

### 2.7 `LlmAdapter` 契约要点

- 只有 `stream(options): AsyncIterable<StreamChunk>` 是必须实现的；其余（`providerInfo` / `listModels` / `resolveModel` / `prepareCall` / `providerRetryPolicy` / `imageRequestPricing`）有默认实现。
- **每个 HTTP 请求必须带 `attributionHeaders()`**（从 `@deepseek-ai/dsh-llm` 导出），这是文档硬约束。第三方网关**不应**收到 harness 的匿名 user id 等遥测头（参照 `dsh-llm-newapi` 的设计立场）——但 OpenCode Go 需要的会话头是路由级配置，二者不冲突。
- 注册：`ctx.llm.registerAdapter([routes], adapter)`，返回句柄支持原子 `replace(routes)`。
- 设置区：`ctx.settings.installSection(ctx, ns, Config, initial, { validate, setSource, onChange })`。
- 模型探测：`ctx.llm.registerModelDiscovery(ns, discover)`（Models 页"获取模型"调用）。

### 2.8 自定义命名空间没有官方 UI

官方 Models 页的 `ModelListEditor`（含"获取模型"按钮）只被 `deepseek` / `pi-ai` 两个命名空间的 `layoutOf()` 硬编码渲染；
其他命名空间走 `unknown` 布局（没有 key 输入框）。**所以四期必须自带设置页**——这是工作量最大的一块。

### 2.9 pi-ai 不是 dsh 的声明依赖

`@earendil-works/pi-ai` 不在 dsh 的 `dependencies` 里，只是 dsh 自己 `node_modules` 下的嵌套包。
不要 `require.resolve('@earendil-works/pi-ai')` 指望成功，也不要自己再装一份（版本漂移会导致模型目录/compat 对不上）。
可选做法：通过 dsh 的加载面拿到 pi-ai，或把它作为**同版本 peer 依赖**并在启动时校验版本，不匹配就 fail loud。

### 2.10 每个协议对应不同的 endpoint/参数（二期实测，重要）

候选协议不只要换 `api`，还可能**换 URL、换字段**：

1. **`anthropic-messages` 必须去掉 baseURL 末尾的 `/v1`。** pi-ai 走官方 Anthropic SDK，
   `baseURL: model.baseUrl`，而 SDK 自己补 `/v1/messages`。因此"已含 `/v1` 的 base"实际发出的是
   `https://opencode.ai/zen/go/v1/v1/messages` —— 网关返回它自己的 HTML 404 页面。
   **一期（以及二期的第一轮探针）把这条 404 误读成"该端点不服务 anthropic-messages"**；
   实际 `POST {base}/messages`（去掉重复 `/v1`）对 `qwen3.8-flash`、`minimax-m2.5`、
   `minimax-m3`、`minimax-m2.7` 全部 200（`minimax-m2.7` 在 `/chat/completions` 上是 500，
   只有 anthropic 能用）。实现：`src/request-adapt.js` 的 `baseUrlForProtocol()`，只对
   `anthropic-messages` 去掉一层结尾 `/v1`，别的 base 原样透传。
2. **`openai-responses` 的 `max_output_tokens` 下限 16 是协议契约，不是网关行为。**
   已装 pi-ai 自己会 `Math.max(value, 16)`，本插件在适配层再夹一次（pi-ai 升级也保住这个保证）。
   实测 2026-09-11：该**中继本身**对 1/8/15 都回 200 —— 它不替我们执行协议契约（中继转发的上游
   可能会），所以才必须自己夹。
3. **`anthropic-messages` 总要发 `max_tokens`**：调用方省略时用模型自己的 `maxTokens`。
4. 调用方给的 cap 高于模型自己的 `maxTokens` 时按模型上限夹取，不原样透传。

探针工具（`scripts/probe-protocols.mjs`）与适配器共用这套适配，所以"证据矩阵"和运行期行为一致。

### 2.11 能力预填（快照 → 宿主/pi-ai）

| models.dev 事实 | 落成 | 规则 |
|---|---|---|
| `limit.context` | `contextWindow` | 原值；缺失或模型不在快照里才用配置默认值 |
| `limit.output` | `maxTokens` / `defaultMaxTokens` | 同上；宿主在调用方未指定 cap 时把它物化进请求 |
| `modalities.input` | `inputModalities`（宿主只认 `text`\|`image`） | **`video`/`pdf`/`audio` 必须过滤掉**（宿主消息内容只有文本/图片块，带不认识的模态会在请求路径上炸）；过滤后为空则退回 `text` |
| `reasoning` + `reasoning_options[type=effort].values` | pi-ai `reasoning: true` + `thinkingLevelMap` | 声明过的值按名字映射到宿主档位；**未声明的档位一律钉成 `null`**（显式不支持），与官方适配器一致 |
| `reasoning_options[type=toggle]`、`[type=budget_tokens]` | 只记录，**不**变成可选档位 | 两者都没有给出可发送的 wire 值，编一个档位就是臆造；pi-ai 的 budget 需要 `thinkingBudgets` + 档位，宿主 seam 本期不暴露 |
| `interleaved.field` | 回放侧思维字段 + pi-ai `compat` | 只接受 pi-ai 真正认识的 `reasoning`/`reasoning_content`/`reasoning_text`；pi-ai 的流读取器只对 `provider === 'opencode-go'` 特判字段名，本路由是 `opencode-go-native`，所以适配器自己把"已知思维字段名"纠正为catalog 声明的那一个（不臆造、不动 `reasoning_details` 结构化签名） |
| `provider.npm` | 协议规则 | 见 §2.2 |
| `cost.*` | pi-ai `ModelCost` | 每百万 token 费率，含 context tier；缺项记 0 |

**档位映射规则（写进 README，并且有单测）**：宿主档位固定为
`off|minimal|low|medium|high|xhigh|max`；models.dev 给的是自由串。

* 名字命中宿主档位 → 1:1 映射，wire 上保留 models.dev 的原始拼写；
* **`none` → `off`**：`none` 是 models.dev 表达"不思考"的拼写，语义上就该落在 `off` 键上；
  保留 wire 值意味着"调用方没指定档位"时 pi-ai 会发 `reasoning_effort: "none"`（provider 自己的
  "别想"表达），而不是把声明过的能力静默丢掉。若模型没声明 `none`（如 `glm-5.3-flash`：
  `low|high|max`），`off` 钉成 `null`，不指定档位时什么也不发，保留 provider 默认；
* 命中不了任何宿主档位的值被**丢弃并记录**（不猜）；
* `off` 在 pi-ai 里等于"省略 reasoning 参数"，因此**不作为宿主 UI 上的可选项**（否则是一个改了
  等于没改的控件）。

**快照 / 端点 id 对不上的降级（可测）**：

| 情况 | 行为 |
|---|---|
| 端点有、快照也有 | 完整预填 |
| 端点有、快照没有（实测：`deepseek-flash`、`hy3-preview`） | 保守默认 + bootstrap 协议规则；catalog 记为 unknown |
| 快照有、端点没有（实测：`ox-alpha-free`） | **不启用**；只记为 snapshot-only 诊断 |
| 快照文件缺失/损坏 | 关预填，路由照常服务，响亮告警 |

`interleaved.field === 'reasoning_content'` 时还会开 piai 的
`compat.requiresReasoningContentOnAssistantMessages`（历史里的 assistant 消息补齐该字段，避免
DeepSeek 家族式的历史校验 400）。**不设 `thinkingFormat`**：pi-ai 的 `deepseek`/`zai`/`qwen` 等格式
是请求侧方言，models.dev 没说这个中继用哪套，而 `effort` 值恰好就是 pi-ai 默认的
`reasoning_effort` 语义。

### 2.12 端点健康分类（C 段要求）

"端点列了但本机/本账号用不了"这件事**以插件自己的形态保存**：`src/health.js` 的
`EndpointHealthLog`（进程内、按模型保留最近数条），分类直接照端点自己的错误类型命名：
`region`（`RegionError`）、`data-policy`（`DataPolicyError`）、`country-block`
（`unsupported_country_region_territory`）、`format-unsupported`、`protocol-path-missing`、
`model-unavailable`、`upstream`、`auth`、`bad-request`。

* **不去猜宿主模型信息结构里不存在的字段**：`listModels`/`resolveModel` 只填宿主真正定义的
  provider/id/name/inputModalities/context/defaultMaxTokens/reasoning；
* 有"用户该做什么"的分类（region/data-policy/country-block/model-unavailable）每个
  (模型, 分类) 只 `warn` 一次，附上动作原文；四期设置页可以读
  `adapter.health.snapshot()/.unusable()/.summaryLines()`；
* README 记录：Region/DataPolicy 要去 opencode.ai workspace 显式 opt-in；
  `gpt-5.6-luna` 在 2026-09-11 04:32Z 实测是 `unsupported_country_region_territory`，
  17 分钟后同一账号实测 200 —— **地区闸门是动态的，单次观测只是一个时刻的事实**。

### 2.13 图片输入：声明了就必须真发，不能静默丢弃（复审后补，重要）

二期第一版把 `glm-5.3-flash` 的 `inputModalities` 预填成 `["text","image"]`，但
`toPiContext` 的 user 消息只走 `flattenText()` —— 图片块被**静默丢掉**。宿主只在路由**声明不支持**
图片时才拒绝/投影，所以"声明支持却丢图"的后果是：用户贴图，模型只收到文字，还会给出看起来正常
的回答。这是数据丢失，不能留到三期。

**实现照抄官方 `dsh-llm-pi-ai`，不自创方案**：`contentHasImage`、
`offloadRequestImagesWithPolicy`、`offloadedImageText`、`requestImageHandleText`、
`resolveImageAttachmentAccess`（`src/pi-ai.js` 的 `userContent` / `prepareRequestImages` /
`toPiContextWithImages`），附件服务经 `ctx.get('attachments')` **惰性**取得（它可能晚于本插件激活），
`resolveImageAccess` 用 fs provider 把宿主路径桥到工具执行世界（`src/index.js`）。

**不可表示时必须抛错，不允许降级为空内容**（三处，判定抽到
`src/capabilities.js` 的 `imageRequestSupport()`，有单测）：

1. 模型声明的模态不含 `image` → `UNSUPPORTED_CONTENT`（纵深防御：宿主通常已先投影为占位文本）；
2. 没有附件服务 → `UNSUPPORTED_CONTENT`；
3. 历史里非 user 消息带图片（pi-ai 无对应槽位）→ `UNSUPPORTED_CONTENT`（`assertSupportedImageRoles`）。

图片按 `requestImagePixelBudget`/`requestImageMaxBytes` 逐张取一个请求版本，累计超过
`maxRequestImageBytes` 时最旧的若干张被替换成宿主自己的确定性占位文本。**file 块不是适配器的事**：
宿主在请求组装阶段就 `projectFilesToText()` 投影成 handle 文本（实测 dsh-llm `lib/index.js:2250`）。

实测（隔离实例，真实 64×64 红色 PNG 经 `attachments.saveImages` 落盘）：
`glm-5.3-flash` → `/chat/completions 200`、请求体 2 个 image 标记 + base64、模型回答 "Red"；
`qwen3.8-flash` → `/messages 200`、1 个 image 标记、回答 "Red"（anthropic 路径同样能带图）；
`hy3`（只声明 text）→ `/chat/completions 200`、0 个 image 标记、请求体里是
`[image omitted because this model accepts text only; …]` 占位文本。8×8 的图会被某个上游以
`height:8 or width:8 must be larger than 10` 拒绝（请求仍然每次都带着图），所以探针图必须够大。

### 2.14 诊断日志的落点与 `adapter.logged`（复审后补）

`ctx.logger.warn` 是面向用户的通道，但**本宿主版本里插件 `ctx.logger.*` 的输出不会到 stdout，
也没有日志文件**：`$DSH_HOME/web.log` 只在 `dsh.sh` 启动时存在（`DSH_LOG` 默认指向它），而
cordis 的默认 exporter 只是内存 ring buffer；从另一个插件注册 `ctx.logger.exporter()` 只能收到
cordis 自己的错误上报，收不到兄弟插件的 `ctx.logger.*` 调用（以上均实测）。

因此插件自己保留一份有界日志环 `adapter.logged`（`{at, level, message}`），入口的 `log()` 同时写
宿主 logger 与这个环。验收与四期设置页都读它：

```
adapter.logged.filter((line) => line.level === 'warn')
→ model "deepseek-v4-pro" is not usable on protocol "openai-responses" (region, HTTP 403): Enable the model explicitly…
```

这个环上线第一轮就抓到一个真 bug：`settings.installSection` 的 hooks 必须提供 `onChange`
（`dsh-settings/lib/index.js` 无条件调用它），而一期只传了 `validate`/`setSource`，
于是 `hooks.onChange is not a function` 被 cordis 以 `error|opencode-go-native` 记录、**设置区注册
整体失败**（流式请求不受影响，所以此前没暴露）。已补 `onChange`（记录一行 info；`options()` 按
source 值身份记忆化，本来就会重解析）。同时把启动同步包进 `ctx.inject(['credentials'], …)`：
否则 `dsh web` 的异步激活顺序会让启动发现先于凭据面就绪，日志里出现一条刺眼的
`MISSING_CREDENTIAL`（实测，已消除）。

`scripts/build.mjs` 也顺带加了一条**构建期命名导出校验**（逐文件 `node --check` 抓不到跨文件
命名导出缺失——二期中途就因此让隔离实例起不来），以及一条生成器导出（`export async function*`）
的扫描。

### 2.15 模型集合的用户控制：叠加，不替换（四期 A 段）

端点仍然是**"有哪些模型"的唯一事实来源**（§2.5），这一条没有变。四期 A 段在它之上加的是
一层**叠加**配置，而不是给它一个替代品：

```text
  生效集合 = { 端点声明的 id } ∪ { models.extra 里声明的 id }
             \ { models.disabled 里列出的 id }
```

因此**端点明天多出一个模型，无需任何配置改动它就是可用的**；今天写下的 `disabled`/`overrides`
只对它点名的那个 id 生效。唯一会让集合"冻结"的是 `models.replaceDiscovered: true`，它的名字就是
警告——只有明确想要一份手工列表的操作者才该打开它。

配置形状（`src/models.js` 是唯一的实现，`config.js` 的 schema 与运行期校验共用它的原语）：

```yaml
models:
  disabled: [retired-model, region-blocked-model]   # 端点列了但不启用
  extra:                                            # 端点没列（或列了但缺能力）的模型
    - id: my-custom-model
      name: My Custom Model                         # 只有 extra 能改名字（见下）
      api: openai-responses                         # 受支持协议之一
      contextWindow: 131072
      maxTokens: 16384
      input: [text, image]                          # 只接受宿主能承载的模态
      reasoning: true
      reasoningEfforts: [low, high]                 # 宿主档位，且不得含 off
  overrides:                                        # 对单个已存在模型做局部覆盖
    glm-5.3-flash:
      contextWindow: 4096                           # 只改点名的属性
  replaceDiscovered: false                          # 默认 false；true = 只服务 extra
```

**属性优先级（低 → 高）**：

```text
  保守连接默认值（defaultContextWindow / defaultMaxTokens）
    ← models.dev 快照记录（该 id 被目录收录时）
      ← models.extra[id] 的属性声明
        ← models.overrides[id]
          ← protocolOverrides[id]（二期别名，见下）
```

`extra` 与 `overrides` 用**同一套属性词汇**（`api` / `contextWindow` / `maxTokens` / `input` /
`reasoning` / `reasoningEfforts`），唯一差别是 `extra` 多一个 `id` 与一个 `name`：**改名只允许在
`extra` 里**——端点自己命名的模型不该被一个"修正"改掉展示名，那是另一种事实。

**`input` 不做静默过滤。** §2.11 的宿主模态过滤仍然在（纵深防御，且 `droppedModalities` 会记录），
但**操作者自己写下的** `video`/`pdf`/`audio` 会在校验期被**点名拒绝**，而不是被悄悄丢掉：配置里
留下的值必须是请求路径真能表达的值。

**reasoning 覆盖的判定（有单测）**：

| 配置 | 结果 |
|---|---|
| `reasoningEfforts: [low, high]` | `reasoning: true` + `thinkingLevelMap` 只把这两个档位映射成自身，其余**钉成 `null`**（与快照路径同一约定）；快照已有的 wire 拼写（如 `none`→`off`）在同名档位上保留 |
| `reasoningEfforts: []` 或 `reasoning: false` | `reasoning: false`，**没有** `thinkingLevelMap` |
| 只写 `reasoning: true` | 不新增任何档位：**复用**快照声明过的档位（或它自己的 `false`）。"断言模型会思考"不能把目录钉成 `null` 的档位提升为可用 |
| 含 `off` | 拒绝并说明理由（pi-ai 用"省略 reasoning 参数"表达不思考，`off` 不是可发送的档位） |

**未知键一律拒绝并列出可用键**（例如 `models.extra[0] has unknown key "contextwindow"`），
因为这一期的目的正是消灭"写错了但被静默忽略"。

### 2.15.1 `protocolOverrides` 降级为别名，且**次于**新地址

二期把 `protocolOverrides` 定为"配置永远决定链首"的第一优先级。四期 A 段把同一个事实搬到了更
具体的地址上（`models.overrides[id].api`），于是产生**两个地址写同一件事**的可能性。决定：

* `protocolOverrides` **保留可用**（不破坏任何已有配置），但语义改成 `models.overrides[id].api`
  的**别名**；
* 两者同时点名一个模型时，**`models.overrides[id].api` 胜出**，被遮蔽的别名进入诊断
  （`diagnostics.configuration.models.protocolOverridesShadowed`），**不静默丢弃**；
* 两者都不出现时该模型没有任何 pin，链首由 npm 规则决定（§2.2）；
* `resolveOptions` 把两条来源合并成同一个 `protocolOverrides` 事实交给适配器，所以链首语义
  （含 `honorProtocolOverrides` 的免疫）没有变化。

**`models.extra[].api` 也是一个配置级 pin**，与上面两条同级：声明一个端点还没有的模型、然后让
规则去猜它的协议，会让 `api` 变成装饰性字段。它在 `src/adapter.js#protocolFor` 里与
`protocolOverrides` 合并（显式的 `overrides`/别名优先），并同样被 `honorProtocolOverrides`
保护，不被学到的拒绝重排。隔离实例证据：`extra` 声明的模型真的打到 `/v1/responses`
（`data/acceptance-phase4a-2026-09-11.json` 的 `pinnedStream.calls`）。

### 2.16 运行期生效的两处缓存键（A 段修掉的真实缺陷）

"改设置 → 下一次请求生效"这条契约需要两个缓存键都包含新事实，四期 A 段的隔离实例各抓到一处
缺失：

1. **适配器的 pi-ai 集合（`#snapshotNow`）**：此前只比较已解析连接事实的**对象身份**。集合里装的
   是模型列表，而 `models` 的增删可能不改变对象身份（设置层交回一个内容相同的对象时），于是
   "加一个 extra 模型 / 排除一个模型"这类改动可能不重建集合。现在身份由 **(已解析事实, 生效 id
   列表)** 共同决定；并且在构建集合**之前**先 `await catalog.refresh()`，让集合与生效 id 列表
   不可能描述两个不同的世界（实测：`baseURL` 写回后立刻发流，集合还是上一个端点的列表，请求
   以 `MODEL_NOT_FOUND` 失败）。`refresh()` 本身是 single-flight + TTL 门控的，所以只有在目录
   真的过期时才有一次调用；失败时它保留上一次成功结果，因此"端点不可达"仍然打不倒路由。
2. **目录（`ModelCatalog.refresh`）的新鲜度**：此前只看 TTL（"这个答案放旧了吗"），不看"这个答案
   说的是不是**现在配置的**那个端点"。设置把 `baseURL` 从真实端点改到本地桩之后，`listModels()`
   在剩余 TTL 内继续回答上一个端点的目录（实测）。现在 `baseURL` + `apiKeyEnv` 组成
   `targetKey`，是新鲜度判定的一部分；它在**尝试**时记录而不是成功时记录，所以"新端点失败"不会
   让旧目录看起来对新端点仍然新鲜。

### 2.17 目录的失败容忍有一个例外：凭据

`ModelCatalog` 对**端点**的失败是容忍的：一次失败的刷新绝不清空列表，上一次成功结果继续服务
（§2.5 的立场）。但**凭据**失败不是端点失败：重试修不好它，而且它让该路由上的**每一个**请求
都失败；把它藏在"列表还在"后面，正是三期付过代价的那类"配置合法、已存储、运行期被静默忽略"的
缺陷（实测：写入一个未设置的 `apiKeyEnv` 之后，`listModels()` 仍返回旧目录，诊断里只有
`stale`）。因此 `MISSING_CREDENTIAL` 会从 `refresh()` **抛出**，其余失败继续走容忍路径。

### 2.17.1 凭据只有一个来源，外加一次性的明文迁移（0.6.0 改定）

**动机（用户侧的事实）**：0.5.0 曾把"能填能存"落在插件自己的 `apiKey` 字段上，代价是 token 以
**明文**写进 `~/.dsh/settings.yaml`（`data/acceptance-apikey-2026-09-11.json` 就是那次实测）。
用户明确要求改掉：**默认保存到凭据存储，不要明文落进设置文件**，做法与官方
`qwen-token-plan-cn` 一致——设置里只留 `apiKeyEnv` 引用名，值放在
`$DSH_HOME/.credentials.yaml`（0600）。

**决定（单一来源）**：

```text
apiKeyEnv 引用的凭据（环境 > .credentials.yaml > .env）
  → 旧版内联 apiKey（仅当引用解析为空，且记 warn）
    → MISSING_CREDENTIAL
```

顺序与 0.5.0 **相反**：旧版内联值不再优先。理由是"明文副本压过凭据存储"会让轮换后的旧 token
继续生效，而这次改动的全部意义就是让明文消失。判断仍只有一处
（`src/credential.js#resolveConnectionApiKey`，host-free），`tests/credential.test.mjs` 断言
"引用先被查、内联只在未命中时被读、且 `onLegacy` 被调用"，并有反证（把顺序换回去，同一组断言必须失败）。

**模式与分面**：`apiKeyEnv` 现在带 `role('credential-ref')`（官方 provider profile 的写法）；
旧版 `apiKey` **保留声明**但只作为迁移输入，仍是 `role('secret')`——`redactSecrets` 只剔除
`secret`，这是"尚未迁移的明文绝不回传到浏览器"的保证。设置页不再渲染这个字段。

**迁移（`src/migration.js`，host-free + 注入 seam，`tests/migration.test.mjs` 覆盖每个分支）**：
插件装载时读一次**用户层原文**（`settings.describe()` 的 `user`），若其中有 `apiKey`：

1. 引用已解析（`describe().configured`）→ 不覆盖，只 `unset` 设置字段；
2. 未解析 → `credentials.set(ref, value)`，成功后 `unset`；
3. `set` 被拒（例如只读环境变量遮蔽）但引用**确实能解析** → 视为已配置，照常 `unset`；
4. `set` 被拒且引用解析不到 → **保留明文**，只记 warn。删掉操作者唯一的 token 副本比这条警告更糟。
5. 没有 `credentials` 服务 → 同样保留并记 warn。

设置页在明文仍存在时显示告警条（`LEGACY_API_KEY_WARNING`），诊断面报
`connection.legacyInlineKey`。迁移在 `onChange` 与装载各触发一次，用
`migrationSettled` 先置位再 await，自身写入不会重入。

**运行期生效**：`apiKey` 与 `baseURL` 一样进 `resolveOptions` 的解析结果（迁移前仍可用）；
目录缓存的目标键仍是 `${baseURL}\0${凭据来源标识}`（`ref:<name>` 或 `inline:<token>`），所以
"换 token"立刻失效旧目录。启动同步的 gate 保持"有内联值就直接同步，否则等 `credentials` 服务"。

**0.5.0 的错误文案也随之改掉**：`missingCredentialMessage` 现在只说"引用解析为空 → 去凭据存储
写 / 导出环境变量"，并明说**本插件不再从设置文件读 key**，不再给出"把 token 填进设置"这条已删除的
路径。

### 2.18 诊断面与发现入口（四期 A 段的宿主 seam）

**诊断面**只有一个来源，没有第二份日志（承接 §2.14）：`adapter.logged`（有界日志环）与
`adapter.health`（端点健康分类）由 `src/diagnostics.js` 的纯函数 `buildDiagnosticsView()`
组装成一个**可序列化**载荷，`adapter.diagnostics()` 返回它。载荷的顶层键与含义：

| 键 | 内容 |
|---|---|
| `kind` | `dsh-opencodego/diagnostics`（SPA fallback 对未知路径回 HTML，消费方要能拒绝它） |
| `at` | 组装时刻 |
| `connection` | 适配器**下一次请求**会用的 `baseURL` / `apiKeyEnv` / `legacyInlineKey`（布尔：设置文件里是否还留着待迁移的明文；这是"设置是否真的到了运行期"的可观测点，单位置） |
| `configuration` | 生效配置：`sessionHeader*`、协议回退相关、阈值，以及 `models`（disabled / extra / overrides / `replaceDiscovered` / 别名 applied+shadowed） |
| `catalogue` | 目录诊断计数（status/lastError/failures）、`effectiveIds`（有上限）、每条 id 的 `source`（`endpoint` / `extra` / `endpoint+extra`）、`snapshotOnly` / `unknownModels`，以及当前 PI 集合覆盖的 id 数 |
| `health` | 每个模型的最近分类 + 动作 + 有界历史；`unusable` 摘要；`summaryLines` |
| `log` | 日志环行 + 其中 `warn` 的行 |

所有列表都有上限参数（`modelIdLimit` / `logLimit` / `healthLimit`），默认值见
`DEFAULT_*_LIMIT`。**载荷里永远没有凭据值**（只有 `apiKeyEnv` 这个引用名，加上
`legacyInlineKey` 这个布尔）——集成探针里对整份载荷做过 `JSON.stringify` 的哨兵扫描。

**HTTP 面**（给 4b 的页面，读多写零）：一个 `prefix` 路由 `/opencode-go-native`，由
`ctx.inject(['webServer'], …)` 惰性注册（没有 `webServer` 的组合里不注册，插件照常工作），
带与 `/api` 网关同款的**浏览器信任栅栏**（`src/http.js`，DNS-rebinding / 跨站防御，**不是**认证，
这一点在代码注释里说清楚了）：

| 路由 | 语义 |
|---|---|
| `GET /opencode-go-native/diagnostics` | 上面那份载荷 |
| `GET /opencode-go-native/models` | **生效**目录（配置叠加之后、协议决策之前）；`?refresh=1` 强制重新发现 |
| `POST /opencode-go-native/models` | 一次 discovery **草稿**（`{ baseURL?, apiKey? }`），与 `registerModelDiscovery` 同一个 seam；草稿 key 只用于这一次请求，回复里**不回显** key；失败以 `{ ok: false, error: { code, message } }` 给出可读错误 |

三条路由的响应体是 `{ ok, … }`：`GET` 成功为 `{ ok: true, diagnostics }` /
`{ ok: true, source, models }`；`POST` 的失败是 **HTTP 200** 加
`{ ok: false, error: { code, message } }`（草稿是探测结果，不是路由失败）。

**发现入口**：`discover()` 拆成 `src/discovery.js` 的纯函数 `fetchModelDraft()`（宿主无关，
`tests/discovery.test.mjs` 用桩 fetch 覆盖每一个成功与失败分支）与薄的宿主半 `discover()`（注入真
`fetch` 与 `attributionHeaders()`，把失败包成带稳定 `code` 的 `LlmError`）。`llm.registerModelDiscovery`
继续注册它，所以官方 "获取模型" 走的是同一条路径；失败消息里总是有端点与（HTTP 失败时）状态码。

### 2.19 Web 客户端半：`dsh.client` 声明、自绘 `models` 表单、两条数据面（四期 B 段）

四期 B 段是**浏览器半**。它不能 `import` 宿主模块，所以它只有两条数据面，且
**分工是硬性的**：

| 面 | 通道 | 为什么 |
|---|---|---|
| 设置读写 | `ctx.remote.settings`（`describe` / `mutate` / `update` / `replace`） | 官方管线：校验 → 持久化 → 广播；拒绝以 `settings/rejected` / `settings/conflict` 到达，带宿主自己的文案与 `revision` |
| 凭据读写 | `ctx.remote.credentials`（`describe([ref])` / `set(ref,value)` / `unset(ref)`） | 0.6.0 起 API key 走这条路（§2.17.1）：设置文件只记引用名，值进凭据提供方。这就是官方 Models 页写的那个 namespace |
| 目录与诊断 | 本插件自己的只读 HTTP 面（§2.18） | 浏览器半拿不到 `adapter.diagnostics()`；`POST /models` 的草稿还没有 Remote |

`remote.credentials` 与 `remote.settings` 一样是**带点的独立 cordis 服务名**，必须在 `inject`
里逐字声明（`['remote', 'remote.credentials', 'remote.settings', 'slots']`），否则
`cannot get property "remote.credentials" without inject`。`describeCredential` 把错误臂收敛成
`undefined`（凭据读失败不该让整页白屏），`storeCredential` / `removeCredential` 把拒绝文本返回给
字段旁的提示。

**声明与挂载**：`package.json` 的 `dsh.client`（`platform: 'web'`）+ `exports['./client']`
让宿主 `dsh-client-modules` 从**同一行**（`cordis.patch.yml` 里的
`- insert: {id: opencode-go-native, name: dsh-opencodego}`）发现客户端 bundle；
宿主把 bundle 合成到 `window.__DSH_BOOT__` 的 entry 图里，浏览器按
`/plugins/??<id>/client.js&rev=<rev>` 取。**只挂一行**：再写一行"客户端半"就是第二个
"什么被组合了"的事实来源。

**构建**：本仓库不引入打包器依赖（实测：`esbuild`/`tsdown` 都不在本仓库的依赖闭包
里，装它要联网）。`scripts/build-client.mjs` 是一个 ~200 行的**专用**打包器，只接受
客户端半实际使用的源码子集：静态相对导入（改写成本地模块表、**延迟到各自 factory 执行**）、
其余静态导入一律留给平台 seed 表（`react` 等，见该脚本头部的 `SHELL_SEED_WORDS`）。
超出子集的写法（`export default`、动态 `import()`、`export *`）直接**构建失败**，
而不是产出一个只在浏览器里坏掉的 bundle。输出形态就是 loader 契约：

```js
window.__ModuleLoader__.load({ id: 'dsh-opencodego', factory: (require) => { … } })
```

**`models` 必须自绘，理由在诊断里就能看见**：`Config.models` 是 `z.any()`，而
schemas 的序列化信封是 `{ uid, refs }`，对象节点用 **`dict`**（handle → handle）
而不是 JSON Schema 的 `properties` 指向子节点。隔离实例实测该节点是

```json
{"type":"any","meta":{"default":{"disabled":[],"extra":[],"overrides":{}}}}
```

——一个**没有子 handle 的叶子**。所以表单自己渲染 `models.{disabled,extra,overrides,replaceDiscovered}`，
并且**从 `describe()` 的 `user` 层读**（不是 `value` 层：`z.any()` 直通用户层形状，
`extra` 在两层都是数组；快照/能力归一化是运行期 `normalizeModelOverlay` 的事，不在设置文档里）。

**写入用 `mutate` + 路径 op + `expectedRevision`**，理由有三条，都是实测：

1. `mutate` 把 op 落在**当前存储的 section** 上，所以两个标签页改不同字段不会互相覆盖；
2. `expectedRevision` 让过期写入被拒（`settings namespace "…" changed since it was read`），
   页面把它显示成"另一个标签页先保存了"并给重新载入；
3. `update` 是**深合并**：`overrides: {id: {}}` 这种"清空一条"的意图合并不出来（空对象
   不覆盖已有键），`set`/`unset` 路径 op 才能表达删除。

**字段级错误**：宿主的一切拒绝都在文本里点名字段路径
（`models.extra["broken-extra"].contextWindow must be a positive integer`、
`sessionHeader "x session" is not a valid HTTP header name`）。Remote 失败只有
`code` + `message`，没有结构化路径，所以 `logic.js` 的 `errorPathsOf()` 解析这段文本，
把消息贴到**对应控件旁**（`models.extra[<id>]` 按 id 或下标都能落到同一行）。
客户端另有一份镜像校验（RFC 7230 token、正整数、`extra`/`disabled` 互斥、`off` 不是档位），
只为"保存前就看见"，**不是**第二套权威。

**客户端半只外置 `react`**：它是平台 seed 表提供的单例（`staticModules`），所以
`dsh.client.external` 是空数组——`external` 是"行 X 需要行 Y 的 factory 先到"的图边，
seed 词不需要边。

### 2.20 模型目录：一套操作逻辑，跟官方对齐（0.6.0）

**问题（用户原话）**：设置页同时有"模型集合"和"获取模型（发现草稿）"两块，"这到底是干什么的"，
而且"排除模型"要靠一长串复选框。官方 Models 页只有一套动作：**获取可用模型 → 在弹窗里选 →
添加所选 → 在列表里点三角展开自定义**。

**决定**：把三块合成一块"模型目录"，底层仍用同一份 `models.{disabled,extra,overrides,
replaceDiscovered}`（存储形状没变，运行期语义没变），页面只呈现**派生的目录行**：

```text
directoryRows(form, catalogue) =
  端点目录里未被 disabled 的 id（可带 overrides[id] 修正）
  ++ extra 里端点没有的 id（可带 name）
  ++ 尚未填 id 的空行（保留操作者正在输入的内容）
```

于是三种配置形状各有一个明确动作，且都不需要操作者知道它们的名字：

| 动作 | 写入 |
|---|---|
| `×` 移除端点行 | `models.disabled += id`，并清掉该 id 的 `extra`/`overrides`（宿主拒绝"disabled 还带声明"） |
| `×` 移除手写行 | 从 `models.extra` 删除（以及该 id 的 override） |
| `▸` 展开后改属性 | 端点行 → `models.overrides[id]`；手写行 → 该 `extra` 条目。空 override（什么都没写）直接丢弃，不落盘 |
| `添加模型` | 加一条空 `extra`（还没填 id 时不写入） |
| `恢复默认模型` | `disabled=[] extra=[] overrides={} replaceDiscovered=false` |
| `获取可用模型` → 添加所选 | 选中的**端点** id：从 `disabled` 移除（不需要写 `extra`）；选中的**草稿端点独有** id：写成一条 `extra`。**从不写容量**——官方默认是运行期继承的 |

**默认值来自官方**：`GET/POST /opencode-go-native/models` 的每条现在是
`{ id, name, protocol, protocolSource, snapshotKnown, defaults, effective }`，由 host-free 的
`capabilities.js#catalogueModelView()` 生成（`tests/capabilities.test.mjs` 钉住形状）：

* `defaults` = **没有任何配置叠加**的官方事实（models.dev 快照记录，或快照不认识时的保守默认）；
* `effective` = 叠加 `extra`/`overrides` 之后的当前事实。

页面把 `defaults` 放在输入框的 placeholder（`官方默认 1000000`），把 `effective` 留作对照；
"留空 = 继承"因此是**能看见的**，而不是一句说明。`protocol` 用适配器同一个
`resolveProtocol()` 决议，所以选择器不可能显示一个与请求路径不同的协议。

**为什么不是"端点列表 = 默认目录"之外的第二种模式**：端点仍是"哪些模型存在"的权威
（§2.5），目录是它之上的叠加层；`replaceDiscovered` 仍是唯一的冻结开关，仍默认关、仍带危险文案。
"恢复默认模型"这个名字与官方一致，含义是"回到适配器/端点自己的那一份"。

## 3. 参考实现（模板）

市场里已有同类插件，**先读它再动手**：

- `wenzetan/dsh-llm-newapi`（7★，`github:wenzetan/dsh-llm-newapi`）——注册自有路由 + 适配器 + `GET /models` 探测 + models.dev 预填 + 自带设置页 + 宿主兼容测试。它的 `DESIGN.md`、`src/adapter.ts`、`src/client/NewApiSection.tsx`、`scripts/fetch-models-dev.mjs` 都值得照抄结构。
  可用 `https://raw.githubusercontent.com/wenzetan/dsh-llm-newapi/main/<path>` 直接拉（github.com 在本机 shell 可达；`web_fetch` 工具被 DNS 策略挡，**用 curl**）。
- 能力预填这类现成插件（可参考、不要依赖）：`dsh-model-info-fill`、`dsh-model-fix`、`dsh-models-dev-reasoning`、`dsh-model-extension`。
- 会话头实现参考（现有、已在本机装）：`~/.dsh/profiles/web/node_modules/dsh-opencode-session/lib/index.js`。

宿主侧要读的本地源码：

- `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts`（适配器/契约）
- `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`（官方 pi-ai 适配器，最好的范本）
- `~/.nvm/versions/node/v25.8.1/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/*.js`（三个协议实现）

## 4. 分期计划

| 期 | 内容 | 验收 |
|---|---|---|
| 一 | 仓库骨架 + 适配器最小闭环：注册路由、端点发现、npm→协议(含 override)、per-model api/baseUrl、流走 pi-ai | 隔离实例里能列出模型并真实发起一次流式请求成功 |
| 二 | models.dev 快照 + 能力预填（reasoning_options→thinkingLevelMap、modalities→input、limit→context/maxTokens）+ 候选协议链/首个 chunk 前回退 + 端点健康分类 + 探针工具 | 列表里每个模型的上下文/档位/vision 与端点+目录一致；可构造出"主协议不可用→回退成功"；403 不回退 |
| 三 | session 头（适配器自带 fetch，头名可配） | 隔离实例里请求带 `x-opencode-session`；不带则 400 可复现 |
| 四 A | **宿主设置面**：模型集合的用户控制（追加/排除/局部覆盖）、校验到字段与模型 id、运行期生效、诊断面（`adapter.logged` + `adapter.health` → 可序列化载荷）、发现入口 | 隔离实例里通过**设置写入路径**改 baseURL/apiKeyEnv/extra/disabled/overrides → 下一次 `listModels`/`ctx.llm.stream()` 反映新事实；非法配置被拒且报错命名到字段；`npm test` 全绿 |
| 四 B | **Web 客户端页**（浏览器半）：渲染本插件的 schema、写设置、读 §2.18 的 HTTP 面、自带"获取模型"按钮 | Web 设置页可保存并即时生效；见 §2.19 与 PROGRESS「四期 B 段」的 30 条隔离实例断言 |
| 五 | 测试 + 文档 + 迁移决策（是否把现有 `opencode-go` 路由配置迁过来） | 测试全绿；迁移步骤写在 README，**由用户决定何时执行** |

## 5. 验收纪律

- 每个阶段的产出必须能在**隔离实例**里跑出可复现证据（命令 + 输出），不接受"应该可以"。
- 任何对 `~/.dsh/**` 的写操作都视为违规（本仓库之外的全部路径）。
- 阶段完成时在 `PROGRESS.md` 记录：做了什么、证据命令、遗留问题、下一期的前置条件。

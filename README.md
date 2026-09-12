# dsh-opencodego

> **更新插件 / 刷新 models.dev 基线 / 发版,看 [`UPDATING.md`](./UPDATING.md)。**


A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) LLM provider plugin
that serves **OpenCode Go** — and any OpenCode-style OpenAI-compatible gateway — through a single
provider route, **`opencode-go-native`**, with the **correct wire protocol chosen per model**, an
ordered **candidate-protocol fallback chain**, and **capabilities prefilled from a versioned
models.dev snapshot**.

| | |
|---|---|
| Route key | `opencode-go-native` (deliberately **not** `opencode-go`, which the official `llm-pi-ai` adapter owns) |
| Protocols | `openai-completions` · `openai-responses` · `anthropic-messages` |
| Model set | discovered from `GET {baseURL}/models` at startup and on demand (**the endpoint is the source of truth**) |
| Capabilities | `data/opencode-go.models.json` — a trimmed, versioned models.dev snapshot |
| Protocol decision | `protocolOverrides` → models.dev `provider.npm` rule → bootstrap table → `openai-completions` |
| Resilience | per-model candidate chain, retried **only before the first content chunk**, with learned demotion of a refused protocol |
| Diagnostics | plugin-owned endpoint health (region / data-policy / country gates), never invented host fields |
| Phase | **2 — capability prefill, protocol chains and fallback** (see [PROGRESS.md](./PROGRESS.md) and [DESIGN.md](./DESIGN.md)) |

## Why a second OpenCode Go route?

The official `llm-pi-ai` adapter flattens a model's endpoint into a **route-level** `baseURL`, so one
route can carry exactly one `api`. OpenCode Go's catalog mixes OpenAI Chat Completions models, a
handful of Responses-only models (`grok-4.6`), and four Anthropic-Messages models, which is why the
current workaround is several routes with duplicated endpoint configuration.

pi-ai itself has no such limit: it reads **each model's own** `api` and `baseUrl`, and
`createProvider` dispatches on `model.api` when it is given an api **map**. This plugin uses exactly
that, so one route serves every protocol at once. (Both facts were measured; see `DESIGN.md` §2.1.)

Phase 2 adds what a static table cannot express: this gateway's protocol acceptance is **dynamic**
(measured: `grok-4.6` failing on both protocols and answering `200` on `/responses` seconds later),
so the table now decides only the *primary* protocol and the adapter recovers at request time.

## Install

The plugin is a **host-half bundle**: DSH's plugin manager reads `dsh.bundle.patch` from
`package.json`, adds the package to the profile, and inserts `cordis.patch.yml` into the composed
loader tree.

```bash
# 1) straight from GitHub — the recommended way
dsh plugin --profile web add github:whoiszzj/dsh-opencodego

# 2) from a checkout
cd /path/to/dsh-opencodego
npm run build                        # emits lib/ from src/ (see "Build" below)
dsh plugin --profile web add /absolute/path/to/dsh-opencodego

# 3) from a packed tarball, which is what a release looks like
npm pack
dsh plugin --profile web add ./dsh-opencodego-0.7.0.tgz
```

> **安装后必须重启 `dsh web`。** 宿主半边是在进程启动时加载的,新装或更新过的
> `lib/index.js` 不重启不会生效(浏览器那一半有 HMR 会自动热重载)。
>
> `lib/` 不进仓库,所以从 GitHub 安装时会由 `package.json` 的 **`prepare`** 脚本在
> npm 取完源码后构建一次 —— 这也是为什么 `prepare` 不能删。装完可以确认一下:
> `ls ~/.dsh/profiles/web/node_modules/dsh-opencodego/lib/index.js`。

更新/刷新 models.dev 基线/发版,看 **[`UPDATING.md`](./UPDATING.md)**。

`dsh plugin add` performs both halves for you:

1. installs the package into `$DSH_HOME/profiles/<profile>/node_modules/`, and
2. appends `dsh-opencodego` to `dsh.profile.bundles` in that profile's `package.json`.

> **Install by path, not by symlink.** `npm pack` / a real directory install is required. A
> `link:`/symlink install resolves the plugin's bare imports (`@deepseek-ai/dsh-llm`, …) from the
> *checkout* directory, where the host packages do not exist, and the loader fails with
> `ERR_MODULE_NOT_FOUND`. See [依赖解析](#依赖解析-dependency-resolution).
>
> **Reinstalling a changed build needs remove + add.** `dsh plugin add <same version>.tgz` is a
> no-op when pnpm still has the previous tarball in its lockfile, so `lib/` keeps the old code:
> `dsh plugin --profile web remove dsh-opencodego` first (verified during the phase-2 acceptance).

Remove it with `dsh plugin --profile web remove dsh-opencodego`.

## Configure

Every field is optional. The plugin reads its config from the **composition layer** — the plugin
entry in `cordis.patch.yml` — and, when the `settings` service is present, from the
`opencode-go-native` settings section (the phase-4 settings page will write there).

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: opencode-go-native
  config:
    baseURL: https://opencode.ai/zen/go/v1   # default
    apiKeyEnv: OPENCODE_GO_API_KEY           # default: a credential REFERENCE, never the secret
    # apiKey: sk-...                         # LEGACY (pre-0.6.0): read only to migrate, never written
    sessionHeader: x-opencode-session        # default
    sessionHeaderEnabled: true               # default
    sessionHeaderMode: session-id            # session-id | uuid
    snapshotEnabled: true                    # default: use the plugin's bundled model-state file
    protocolFallback: true                   # default: keep openai-completions as the last candidate
    honorProtocolOverrides: true             # default: a pin is never reordered by the learned memo
    requestImagePixelBudget: 4194304         # default: per-request-image pixel budget
    requestImageMaxBytes: 1048576            # default: per-request-image encoded-byte target
    maxRequestImageBytes: 20971520           # default: accumulated image bytes before offloading
    maxProtocolAttempts: 3                   # default: cap on the candidate chain
    transientAttemptsPerProtocol: 2          # default: tries per protocol for a 5xx/network failure
    protocolMemoTtlMs: 900000                # default: how long a learned refusal is honoured (0 = off)
    sync: true                               # default: discover models at startup
    syncTtlMs: 60000
    defaultContextWindow: 200000
    defaultMaxTokens: 131072
    streamIdleTimeoutMs: 300000
    debug: false
    protocolOverrides: {}                    # default empty; legacy alias of models.overrides[id].api
    models:                                  # the additive model-set overlay (see below)
      disabled: []                           # advertised ids not to serve
      extra: []                              # ids to add, each with optional name/api/contextWindow/maxTokens/input/reasoning/reasoningEfforts
      overrides: {}                          # per-model attribute corrections
      replaceDiscovered: false               # default; `true` serves ONLY `extra`
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://opencode.ai/zen/go/v1` | Gateway base **including** `/v1`. Must be an absolute http(s) URL. |
| `apiKey` | *(none)* | **LEGACY, migration-only — do not set it.** A pre-0.6.0 settings document may still carry the token here in plain text; the plugin READS it so the route keeps working, moves it into the credential store on load (`src/migration.js`), and removes the field. It is never written by the plugin and never wins over `apiKeyEnv`. See [API key](#api-key). |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | **The credential source.** A reference NAME (declared `role('credential-ref')`), resolved per request through `ctx.credentials`, which layers the process environment, `$DSH_HOME/.credentials.yaml` (written 0600), and `.env` files. The plugin never stores or logs the value. |
| `sessionHeader` | `x-opencode-session` | Header name the relay accepts (trimmed, lower-cased, RFC 7230 name characters only). See [Session header](#session-header). |
| `sessionHeaderEnabled` | `true` | Send that header. Turning it off reproduces the relay's `400 MissingSessionID`. |
| `sessionHeaderMode` | `session-id` | `session-id` forwards the host's DSH session id (stable across turns **and restarts**); `uuid` sends an opaque **process-stable** UUID per conversation. A change takes effect on the next request. |
| `snapshotEnabled` | `true` | Use the plugin's bundled model-state file (seeded once from the opencode catalog; never fetched at runtime) for capabilities and for the npm rule. Off ⇒ conservative defaults + the bootstrap protocol table. |
| `protocolFallback` | `true` | Append `openai-completions` as the last candidate of every chain. |
| `honorProtocolOverrides` | `true` | An explicit `protocolOverrides` pin is never reordered by the learned-refusal memo. See [Protocol decision and fallback](#protocol-decision-and-fallback). |
| `requestImagePixelBudget` / `requestImageMaxBytes` | `4194304` / `1048576` | Pixel budget and encoded-byte target for one request image (the attachment service derives one request version per image). |
| `maxRequestImageBytes` | `20971520` | Accumulated image bytes before the oldest images are replaced with deterministic placeholders. |
| `maxProtocolAttempts` | `3` | Hard cap on how many candidate protocols one request may try. |
| `transientAttemptsPerProtocol` | `2` | Tries per protocol when the failure is transient (5xx / network). A format refusal always moves on immediately. |
| `protocolMemoTtlMs` | `900000` | How long a learned "this endpoint refuses that protocol for that model" note steers the chain. `0` disables the memo. |
| `sync` | `false` | Run one discovery pass at startup. Off by default since 0.6.8 — every consumer (settings page, host model list, first request) refreshes on demand through the catalog TTL, so the boot-time fetch is a network call nobody waits for. |
| `syncTtlMs` | `60000` | How long a successful discovery stays fresh before the next on-demand call re-fetches. |
| `defaultContextWindow` / `defaultMaxTokens` | `200000` / `131072` | Conservative capability defaults, used only for a model the snapshot does not describe. |
| `streamIdleTimeoutMs` | `300000` | Idle ceiling while one stream read is outstanding. |
| `debug` | `false` | Also emit routine discovery, chain and per-attempt diagnostics at `info`. |
| `protocolOverrides` | `{}` | Legacy alias of `models.overrides[id].api`. Still wins over the snapshot rule; `models.overrides[id].api` wins over it (the shadowed alias is reported in the diagnostics payload). |
| `models` | see above | The additive model-set overlay: `disabled` / `extra` / `overrides` / `replaceDiscovered`. See [The model set](#the-model-set-discovered--extra--disabled). |

### API key

Since 0.6.0 there is **one** supported source. The decision lives in one place
(`src/credential.js`), and it is unit-tested with a counter-proof that swaps the
sources and expects the same assertions to fail (`tests/credential.test.mjs`):

| # | Source | Where the value lives | Consulted when |
|---|---|---|---|
| 1 | `apiKeyEnv` | The credentials plane: process environment, `$DSH_HOME/.credentials.yaml` (0600), `.env` | always, first |
| 2 | `apiKey` | **LEGACY** plain text left in the settings document by a pre-0.6.0 version | only when the reference resolves to nothing, and announced with a `warn` |

The plugin **never writes a token into the settings document**. The Web settings
page's `API 密钥` field writes through the host's own credentials Remote
(`ctx.remote.credentials.set`), which stores the value in the credential
provider; the settings write only records the reference NAME. That is the same
path the official Models page uses.

Put the key where the credentials plane can see it:

```bash
export OPENCODE_GO_API_KEY=...            # shell environment (wins; read-only, so writes are refused while it shadows)
# or, for the provider-managed writable store:
#   open the settings page and type it into "API 密钥", then 保存
```

**Migrating a pre-0.6.0 document.** If the settings section still carries
`apiKey`, the plugin migrates it on load: it stores the value under the
configured reference (unless that reference already resolves, so a deliberately
stored credential is never overwritten by an older copy), then unsets the
settings field. A store that refuses the write leaves the plain text in place —
deleting the operator's only copy of a token would be worse than the warning.
The page shows a warning banner while a legacy value is still present, and
`GET /opencode-go-native/diagnostics` reports `connection.legacyInlineKey`.

When nothing supplies a value, the request fails with `MISSING_CREDENTIAL`
naming the store, not the settings file:

```
opencode-go-native: no API key for this route: the credential reference
"OPENCODE_GO_API_KEY" resolves to nothing. Store it through the credentials service
(the web settings page writes it), export it in the environment, or put it in
$DSH_HOME/.credentials.yaml, or point "apiKeyEnv" at a reference that exists.
This plugin does not read a key out of the settings document any more. See README「配置」.
```

A failure never happens at plugin load, and no value is ever printed or logged
(the startup line says *which* reference is in force, never what it holds).

## The model set: discovered ∪ extra \ disabled

The endpoint stays the source of truth for **which** models exist; configuration is an **additive
layer over it**, never a replacement:

```
  models in effect = { ids the endpoint advertises }
                     ∪ { ids declared in models.extra }
                     \ { ids listed in models.disabled }
```

So a model the endpoint starts advertising tomorrow is available with no configuration change, and a
`disabled`/`overrides` entry keeps meaning only what it names.

```yaml
- id: opencode-go-native
  config:
    models:
      disabled: [retired-model]              # advertised, but not served
      extra:                                 # not advertised (or advertised with facts you must correct)
        - id: my-custom-model
          name: My Custom Model              # only `extra` may set a name
          api: openai-responses              # one of the supported protocols
          contextWindow: 131072
          maxTokens: 16384
          input: [text, image]
          reasoning: true
          reasoningEfforts: [low, high]
      overrides:                             # correct one attribute of one existing model
        glm-5.3-flash:
          contextWindow: 4096
      replaceDiscovered: false               # default; `true` = serve ONLY the extra list
    protocolOverrides:                       # legacy alias of models.overrides[id].api
      some-model: anthropic-messages         # a models.overrides[id].api for the same id WINS
```

Attribute precedence, lowest first:

```
conservative defaults  ←  models.dev snapshot  ←  models.extra[id]  ←  models.overrides[id]
```

`extra` and `overrides` share one attribute vocabulary (`api`, `contextWindow`, `maxTokens`,
`input`, `reasoning`, `reasoningEfforts`); `extra` additionally carries `id` and `name`, and
**renaming is deliberately only possible there** — a model the endpoint names must not be renamed by
a "correction".

**Validation refuses by name, never silently.** A typo is a rejection that lists the supported keys,
and a bad value names the field *and* the model id:

```
opencode-go-native: models.extra[0] has unknown key "contextwindow"; supported keys are id, name, api, contextWindow, maxTokens, input, reasoning, reasoningEfforts
opencode-go-native: models.extra["my-custom-model"].api must be one of openai-completions, openai-responses, anthropic-messages (got: "openai-chat")
opencode-go-native: models.overrides["glm-5.3-flash"].contextWindow must be a positive integer (got: -5)
opencode-go-native: models.overrides["hy3"].reasoningEfforts[1] must not be "off": pi-ai expresses "do not reason" by omitting the reasoning option, so `off` is not a selectable effort. Drop the entry to leave the provider default, or set `reasoning: false` to declare the model does not reason at all.
opencode-go-native: model "x" appears in both models.extra and models.disabled; remove it from one of them (extra adds a model, disabled removes one)
```

`input` accepts only `text`/`image`: a configured `video`/`pdf`/`audio` would declare a capability
the harness message content cannot carry, so it is refused by name instead of being filtered out of
your own configuration.

Reasoning overrides:

| Configuration | Result |
|---|---|
| `reasoningEfforts: [low, high]` | `reasoning: true`; only those levels are selectable (`thinkingLevelMap` pins the rest to `null`, the same convention the catalogue path uses) |
| `reasoningEfforts: []` or `reasoning: false` | `reasoning: false`, no level map |
| `reasoning: true` alone | no level is invented: the catalogue's levels (or its `false`) are kept |

Every change takes effect on the **next request**: the adapter rebuilds its pi-ai collection when
either the resolved configuration or the effective model-id list changed, and it refreshes the
catalogue first so the two can never describe different worlds. Changing `baseURL` or the credential
in force also invalidates the cached catalogue immediately rather than at the next TTL — the target
names the source actually used (`ref:<name>` or `inline:<token>`), so editing an unused reference
cannot invalidate a live catalogue and swapping the inline token must. Pinned by the phase-4a
acceptance run (`data/acceptance-phase4a-2026-09-11.json`, 14/14) and by
`tests/models.test.mjs`.

## Diagnostics for a settings page (host side)

The phase-4b browser page reads a read-only surface; nothing here writes settings or credentials, and
there is no second log source. `buildDiagnosticsView()` (pure, unit-tested) composes the plugin's own
bounded log ring (`adapter.logged`) and endpoint-health log (`adapter.health`) into one
JSON-serializable payload, which `adapter.diagnostics()` returns in-process. Over HTTP, registered
lazily only when the `webServer` service exists (a CLI profile without it is unaffected):

| Route | Meaning |
|---|---|
| `GET /opencode-go-native/diagnostics` | the payload: `connection` (the facts the NEXT request will use), `configuration` (including the `models` overlay and any shadowed `protocolOverrides`), `catalogue` (status, effective ids with `endpoint`/`extra`/`endpoint+extra` provenance, bounded lists), `health`, `log` |
| `GET /opencode-go-native/models` | the effective catalogue; `?refresh=1` re-discovers |
| `POST /opencode-go-native/models` | one discovery **draft** (`{ "baseURL"?, "apiKey"? }`) — the same seam the official "fetch models" action uses; the key is used for that one request and never echoed; failures answer `{ ok: false, error: { code, message } }` |

All three carry the same browser-trust fence the `/api` gateway applies (loopback/trusted `Host`,
no cross-site marker): a **DNS-rebinding / cross-site defense, not authentication**, stated plainly
because the payload describes a provider.

```bash
curl -s "http://127.0.0.1:3080/opencode-go-native/diagnostics" | head -40
```

`baseURL` and the number of configurable knobs live in the table above; the payload never contains a
credential value, only the reference name (`apiKeyEnv`) and the boolean
`connection.apiKeyInline` — *which* source is in force, never what it holds.

## The Web settings page (browser half)

The plugin is a **dual-face package**: the row in `cordis.patch.yml` mounts both halves, and
`package.json` is what tells the host how:

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "external": [] }
},
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js" }
```

The host's client-module system discovers `exports["./client"]` for that row, composes
`lib/client.js` into `window.__DSH_BOOT__`, and the browser fetches it as
`/plugins/??dsh-opencodego/client.js&rev=<rev>`. **One `insert` row, not two** — a second row for the
"client half" would be a second source of truth about what is composed.

What the page offers, in one section of the settings dialog (`OpenCode Go` — the nav label and the
section title; the route key and namespace stay `opencode-go-native`, which is plumbing):

| Area | Controls |
|---|---|
| Connection | **`API 密钥`** — a `password` input that writes the token to the CREDENTIAL store (blank = "keep the stored one"; a `清除已存密钥` link removes it), with the credential state (configured / source / read-only) shown beside it; under **自定义设置**: `baseURL` (API 地址) and optional `displayName`. The credential REFERENCE is not offered on the page at all since 0.6.9 — it defaults to `OPENCODE_GO_API_KEY` and remains a plain settings-document field (`apiKeyEnv`) for anyone who must change it. The namespace/revision meta line is gone too: the page shows content, not plumbing |
| Session header | `sessionHeader` (free text with an RFC 7230 token hint), `sessionHeaderEnabled`, `sessionHeaderMode` (`session-id` / `uuid`) |
| **模型** | the ONE model list: one row per ENABLED model, and every row rides its **capability chips** — protocol, 上下文, 输出, 输入模态, 思考档位 — showing the EFFECTIVE values, i.e. exactly what dsh will load for that model (the plugin's saved model state + your corrections; conservative defaults where nobody corrected; see「Capability prefill」). No third source is consulted at runtime, and there are no catalog-membership labels. A row's `▸` expands the per-model correction editor (`API 协议` pin, `上下文窗口`, `最大输出 token`, `输入模态`, reasoning + efforts), each empty field meaning the `当前生效` number its placeholder names; `已自定义` marks a row carrying such a claim. `×` stops the model AND saves the act immediately; `按 ID 添加` registers an id the listing does not show and activates it on the spot. The page speaks no data-layer words (端点 / 手写 / 已排除 / 冻结列表 / 恢复默认): the excluded list is the invisible storage behind "not checked", and `models.replaceDiscovered` remains host-supported but unoffered |
| Actions | **获取可用模型** calls `POST /opencode-go-native/models` with the draft's `baseURL` and, if one is typed but not yet saved, the staged key (used for that request alone, never stored or echoed). The picker lists the gateway's whole set WITH capability chips, and its checkboxes mirror what is enabled NOW — a selection, not an "add" list. **应用选择** commits the whole new set immediately: only the `models.*` paths move, and half-typed scalars in the same draft are never smuggled into the write. **查看诊断** renders `health.rows` and `log.lines` from the plugin's own payload — no second log source |

### The `API 密钥` control

The field writes through the **credentials** Remote (`ctx.remote.credentials.set`,
the same namespace the official Models page writes), never through the settings
document. Its copy is asserted verbatim by `tests/client-logic.test.mjs`:

> 密钥写入凭据存储（$DSH_HOME/.credentials.yaml，权限 600），设置文件只记录引用名，不落明文。留空=保持已存储的密钥不变。

The control's behaviour:

* the input **always starts blank** — a secret is never painted back into a field,
  and there is nothing to paint: the credential read (`describe`) returns presence,
  source and writability only;
* a **blank** field stages no credential write, so an unrelated save (flipping
  `sync`, editing a model row) keeps the stored token;
* `保存` writes **settings first, credential second** — the document that names the
  reference is committed before the secret is stored under it, so a failure
  between the two leaves a reference that resolves to nothing (visible) rather
  than a secret nothing points at;
* a refused credential write is reported beside the field ("设置已保存，但密钥没写进
  凭据存储：…") while the settings half stands;
* while a pre-0.6.0 plain-text `apiKey` is still present, a warning banner names
  it and the migration (see [API key](#api-key)).

The model directory is derived, not stored: `directoryRows(form, catalogue)`
joins the endpoint catalogue with the draft's overlay, so there is exactly one
place in the UI where a model can be enabled, corrected or removed — the phase-4b
page's three separate `extra`/`overrides`/`disabled` editors are gone.

Two data faces, deliberately different:

* **settings and credentials** ride `ctx.remote.settings` and
  `ctx.remote.credentials`, i.e. the official validate → persist → publish
  pipelines. Settings writes are **path-addressed** (`{op:'set'|'unset', path}`)
  and carry the `revision` the page read, so two tabs editing different fields do not overwrite each
  other and a stale tab is refused with `settings/conflict` instead of losing the other tab's work;
  a rejection arrives as `settings/rejected` and its message is put **beside the control it names**.
* **catalogue and diagnostics** ride this plugin's own read-only route (above), because a browser
  half cannot import a host module.

`models` is `z.any()` on purpose (a schemastery rendering of it would be a second, weaker copy of the
rules `resolveOptions` enforces), and the schema envelope that reaches the page describes it as an
opaque `any` node with no children — so the form renders those three sub-shapes itself. That is not a
guess: the phase-4b acceptance probe records the node
(`{"type":"any","meta":{"default":{…}}}`) in `data/acceptance-phase4b-<date>.json`.

Where the browser half lives:

| Path | Role |
|---|---|
| `src/client/vocab.js` | the vocabulary both halves must agree on; `tests/vocabulary.test.mjs` compares it to the host's |
| `src/client/logic.js` | every page decision as a pure function (payload → draft, draft → config, validators, host message → control path, path ops). No DOM, no react: `node --test` covers it |
| `src/client/section.js` | the React section (no JSX — see below) |
| `src/client/index.js` | the browser plugin entry (`inject` + `apply`) and the two data faces |
| `lib/client.js` | the built bundle (`npm run build`); **not committed** |


## Protocol decision and fallback

### 1. The primary protocol is a rule, not a probe result

```text
protocolOverrides[model]                     (operator decision, first)
  → snapshot provider.npm == "@ai-sdk/anthropic"   → anthropic-messages
  → snapshot provider.npm == "@ai-sdk/openai"      → openai-responses
  → snapshot knows the model, npm absent/inherited → openai-completions
  → snapshot does NOT know the model               → built-in bootstrap table
  → otherwise                                      → openai-completions
```

`@ai-sdk/openai-compatible` (the package the `opencode-go` provider itself declares) means
`openai-completions`, which is why a model with no per-model npm lands there.

Phase 1 pinned three DeepSeek V4 ids to `openai-responses` because both protocols answer for them.
That was an over-correction: it contradicted the rule and made the primary decision depend on one
moment's probe. They are back on `openai-completions`, and `openai-responses` is recorded as a
**measured alternate** (`ALTERNATE_PROTOCOL_HINTS`).

### 2. Every model has an ordered candidate chain

```text
[ primary, ...measured alternates, the rule's own answer, openai-completions ]
```

duplicate-free and capped by `maxProtocolAttempts`. The rule's answer is appended even when an
override forced a different primary, so a wrong `protocolOverrides` entry is recoverable.

### 3. Switching protocol is allowed only before the first content chunk

| Failure | Kind | Behaviour |
|---|---|---|
| `401 … is not supported for format …`, `404 …` (a path this gateway serves no protocol on), `405/415/501` | `format` | Next candidate immediately. No repeat of the same protocol. |
| `5xx`, `ECONN*`, `fetch failed`, `… Upstream request failed` | `transient` | Retry the **same** protocol up to `transientAttemptsPerProtocol` (an upstream blip on the only protocol a model speaks is otherwise unrecoverable), then move on. |
| `403` — `RegionError`, `DataPolicyError`, `unsupported_country_region_territory` | `fatal` | **No retry, no fallback**: reported verbatim. Switching protocol cannot satisfy an account or geography gate, and hiding the instruction behind a second failure would only delay the fix. |
| `Model is unavailable`, `Model X is not supported`, other 400/401 | `fatal` | Reported verbatim. |
| our own stream idle timeout / caller abort | — | Surfaced, never retried into another protocol. |

The invariant that makes this safe: an attempt is abandoned **only before any chunk other than
`usage` has been yielded to the caller**. Those chunks are withheld precisely because they are
discardable metadata of a failed attempt, so a retry cannot duplicate content. Once a content chunk
has been yielded the attempt is committed and its error is surfaced exactly as phase 1 surfaced it.
`src/protocol-chain.js` implements it; `tests/protocol-chain.test.mjs` pins both halves.

When every candidate fails, the **last** real failure is what the caller sees (in-band `finish`
chunks are replayed as-is; a thrown exhaustion error names every attempt and keeps the last failure
as `cause`).

### 4. What "`protocolOverrides` wins" means

Configuration always selects the **chain head**. On its own it does not forbid the learned-refusal
memo from *reordering* the chain: after a `format` refusal that protocol is demoted to the end for
`protocolMemoTtlMs`. `honorProtocolOverrides: true` (the default) makes an explicit pin immune to
that reordering, so an operator's stated intent is never silently second-guessed. Set it to `false`
if you would rather have the memo optimise away a protocol the endpoint has already refused.

Either way the refused protocol stays in the chain, so if every alternative also fails, the
endpoint's real refusal is still what surfaces. Measured both ways in the isolated instance
(`data/acceptance-phase2-2026-09-11-mode-{b,c}.json`): with the switch on, the second call for a
model pinned to `openai-responses` repeats `[/responses:401, /chat/completions:200]`; with it off,
the second call is just `[/chat/completions:200]`.

### 5. A refused protocol is paid for once

A `format` refusal is remembered per (model, protocol) for `protocolMemoTtlMs` and demoted to the
end of the chain — **not removed**, so if every alternative also fails the endpoint's real refusal
is still what surfaces. Transient failures are never remembered: they say nothing about the
protocol. Measured live: the second request after a `401 … not supported for format openai` went
straight to the working protocol (`data/acceptance-phase2-2026-09-11-mode-b.json`).

### Evidence

`data/protocol-matrix.2026-09-11.json` is a full **37 models × 3 protocols** acceptance matrix
(headers, parameter compliance, request-body summaries) produced by `scripts/probe-protocols.mjs`.
**The endpoint's protocol acceptance is dynamic** — a matrix is a snapshot of a moment and the tool
exists to take a fresh one; it is evidence for the hints table and the classifier tests, never a
runtime dependency.

## Capability prefill

`data/opencode-go.models.json` is a trimmed, versioned extract of `https://models.dev/api.json`
(`opencode-go` only, ~20 KB from a 4.5 MB document) carrying the upstream facts **verbatim**.

```bash
npm run models:fetch        # re-fetch and rewrite the snapshot (review the diff, then commit)
npm run models:check        # fail if the committed snapshot is out of date
```

**This file IS the plugin's model state — the runtime never fetches models.dev (or anything else
third-party) for facts.** Since 0.6.5 the design speaks exactly TWO model sources: ① the gateway's
`/models` list decides WHICH models exist (that IS the official disclosure — the picker's list has
always come from it, never from models.dev), and ② this file plus the settings overlay decides the
numbers dsh loads per model (context, output, modalities, thinking, the npm protocol rule). What
was tried and REMOVED in the same release line was a live models.dev overlay (0.6.4): the drift it
papered over (a gateway listing ids before the catalog records them) is visible and harmless as a
conservative default, while the extra source of truth was not worth the confusion. Resync the state
file DELIBERATELY with `npm run models:fetch` (review, commit, reinstall); an id the file does not
know simply runs on the conservative defaults (`defaultContextWindow` / `defaultMaxTokens`) until
its row is corrected in the settings page.

Every interpretation happens at runtime, in versioned code with tests — so a rule change does not
need a re-fetch.

| models.dev fact | Becomes | Rule |
|---|---|---|
| `limit.context` | `contextWindow` | Used as-is; `defaultContextWindow` only when absent or the model is uncatalogued. |
| `limit.output` | `maxTokens` / `defaultMaxTokens` | Same. The host materializes it as the request cap when the caller omits one. |
| `modalities.input` | `inputModalities` (host `text` \| `image`) | **`video`/`pdf`/`audio` are dropped**: the harness message content can only carry text and image blocks, so an unrepresentable modality would fail on the request path. A list that filters down to nothing claims `text`. |
| `reasoning` + `reasoning_options[type=effort].values` | pi-ai `reasoning: true` + `thinkingLevelMap` | Each declared value maps onto a host level by name; every **undeclared** level is pinned to `null` (explicitly unsupported), mirroring the official adapter. |
| `reasoning_options[type=toggle]`, `[type=budget_tokens]` | recorded, **not** turned into a selectable level | Neither names a wire value, so any level would be invented. pi-ai expresses budgets through `thinkingBudgets` + a level, which the harness seams do not expose at this phase. The model is then described without selectable levels and keeps the provider's own default. |
| `interleaved.field` | thinking field for replayed history + pi-ai `compat` | Only `reasoning`, `reasoning_content`, `reasoning_text` (pi-ai's own accepted set) are honoured. See below. |
| `provider.npm` | protocol rule | `@ai-sdk/anthropic` → `anthropic-messages`, `@ai-sdk/openai` → `openai-responses`, absent → `openai-completions`. |
| `cost.*` | pi-ai `ModelCost` | Per-million-token rates, context tiers included; omitted rows stay `0`. |

### Thinking levels: the free-string mapping

models.dev spells effort values freely; the host's levels are fixed at
`off | minimal | low | medium | high | xhigh | max`, and pi-ai reports a model's levels by filtering
that list against `thinkingLevelMap` (`null` = unsupported, absent = supported except for
`xhigh`/`max`).

* a value naming a host level maps 1:1 (`low` → `low`), keeping its published spelling on the wire;
* **`none` maps to `off`**. Rationale: `none` is models.dev's spelling for "do not reason", so it
  belongs at the `off` key. The wire value is preserved, which means an unconfigured request
  (`reasoningEffort` unset) makes pi-ai send `reasoning_effort: "none"` — the provider's own way of
  saying "do not think" — instead of silently dropping a declared capability. When a model does not
  declare `none` (e.g. `glm-5.3-flash`: `low|high|max`), `off` is pinned to `null` and an
  unconfigured request sends nothing, leaving the provider's default in place.
* a value no host level matches is dropped **and recorded** in the snapshot tests/logs, never guessed;
* `off` is pi-ai's "omit the reasoning option", so it is not offered as a *selectable* effort in the
  host surface (the surface would be a control that cannot change the request).

### Interleaved reasoning and history

`interleaved.field` says where a model puts its reasoning. Two consequences:

1. **Replay field name.** pi-ai's streaming reader records the *raw delta field* as the thinking
   block's signature, with a hard-coded exception for the provider literally named `opencode-go`
   (`dist/api/openai-completions.js`). This route is `opencode-go-native`, so a relay streaming
   reasoning under `reasoning` yields the signature `reasoning`; on replay the adapter corrects a
   **known** reasoning field name to the catalogued one (`reasoning_content`). It never invents a
   field for a block that carried no signature, and leaves structured `reasoning_details`
   signatures alone.
2. **`requiresReasoningContentOnAssistantMessages`.** For a model whose interleaved field is
   `reasoning_content`, the adapter sets that pi-ai compat switch, so a replayed assistant turn
   carries the field even when that turn produced no reasoning. `thinkingFormat` is deliberately
   **not** set: the formats pi-ai offers (`deepseek`, `zai`, `qwen`, …) are request-side dialects
   models.dev says nothing about, and `effort` values are exactly pi-ai's default
   `reasoning_effort` handling.

Verified live: a replayed assistant turn carrying a reasoning block for `glm-5.3-flash` went out
with `reasoning_content` and answered `200`
(`data/acceptance-phase2-2026-09-11-mode-a.json`).

### Snapshot / endpoint mismatch

The endpoint is the source of truth for **which** models exist; the snapshot only describes them.

| Situation | Behaviour |
|---|---|
| advertised and catalogued | full prefill (context, cap, modalities, levels, cost, protocol rule) |
| advertised, not catalogued (e.g. `deepseek-flash`, `hy3-preview`) | conservative defaults + bootstrap protocol table; reported by the catalog as unknown models |
| catalogued, not advertised (e.g. `ox-alpha-free`) | **not enabled**; reported as snapshot-only for diagnostics |
| snapshot file missing/corrupt | prefill off, route still serves, loud warning |

## Per-protocol request adaptation

A candidate protocol can need a different URL and different parameters, so the adapter adapts
before dispatching (`src/request-adapt.js`):

* **`anthropic-messages` runs without the `/v1` suffix.** pi-ai speaks that protocol through the
  official Anthropic SDK, which appends `/v1/messages` to `model.baseUrl`. A configured base already
  ending in `/v1` therefore produced `…/zen/go/v1/v1/messages` — the gateway's HTML 404 page, which
  phase 1 (and phase 2's first probe) misread as "this endpoint serves no anthropic path". Measured:
  `POST {base}/messages` with an Anthropic body answers `200` for `qwen3.8-flash`, `minimax-m2.5`,
  `minimax-m3` **and** `minimax-m2.7` (which is broken on `/chat/completions`). Only a trailing
  `/v1` is stripped, and only for this protocol.
* **`openai-responses` has a protocol-level `max_output_tokens` floor of 16** — it is NOT gateway
  behaviour. Measured 2026-09-11: the relay answers `200` for `1`, `8` and `15` on `grok-4.6`, i.e.
  it does not enforce the contract for us (the upstream a relay forwards to may). The installed
  pi-ai clamps with `Math.max(value, 16)`, and this plugin clamps too so the guarantee survives a
  pi-ai upgrade and any request shape we send.
* **`anthropic-messages` always sends `max_tokens`**, so an omitted cap is materialized from the
  model's own `maxTokens`.
* A caller cap above the model's own `maxTokens` is capped, not forwarded.

## Image input

A route that declares `image` in `inputModalities` must actually send the image. Phase 2's first cut
prefilled that modality from the snapshot while the request conversion still kept only text blocks,
so a user's picture was silently dropped: the host only refuses an image request when a route
declares *no* image support, so the model would answer confidently about a picture it never saw.

The request side now implements the **same mechanism as the official `dsh-llm-pi-ai` adapter** —
`contentHasImage`, `offloadRequestImagesWithPolicy`, `offloadedImageText`,
`requestImageHandleText`, `resolveImageAttachmentAccess` — with the durable attachment service
(`ctx.get('attachments')`) resolved lazily and image references bridged into the tool execution world
through the fs provider.

* **When an image cannot be represented the request FAILS** with `UNSUPPORTED_CONTENT` instead of
  being sent without it. The three cases are the official ones: a model whose modalities exclude
  `image` (defence in depth — the host normally projects such a request to placeholder text first),
  no attachment service, and an image inside an in-history non-user message (pi-ai has no slot for
  it).
* One request version per image is prepared through the attachment service under
  `requestImagePixelBudget` / `requestImageMaxBytes`; once the accumulated request bytes exceed
  `maxRequestImageBytes`, the oldest images are replaced with the host's deterministic placeholder.
* File blocks are not the adapter's business: the host projects every file reference to handle text
  during request assembly, before dispatch (`projectFilesToText`).

Measured in the isolated instance with a real 64×64 red PNG stored through `attachments.saveImages`:

```
image-vision             glm-5.3-flash  /chat/completions 200 | 2 image markers + base64 payload | answer "Red"
image-anthropic-primary  qwen3.8-flash  /messages 200         | 1 image marker + base64 payload  | answer "Red"
image-text-only-model    hy3            /chat/completions 200 | 0 image markers, placeholder text
```

The model saw the colour on both a completions and an anthropic route, and a text-only model got the
deterministic placeholder (`[image omitted because this model accepts text only; …]`) rather than
silence. (An 8×8 probe image was refused by one upstream with `height:8 or width:8 must be larger
than 10`; the request still carried the image on every attempt — use a realistically sized image in
tests.)

## Endpoint health and regional gates

`/models` lists 37 models and mixes in ones this account or this machine cannot use. That fact lives
in **plugin-owned diagnostics** (`src/health.js`, `adapter.health`) — the model list keeps only the
fields the host defines (provider / id / name / inputModalities), and no invented host field is
populated.

| Category | Endpoint wording (measured) | What the operator can do |
|---|---|---|
| `region` | `403 RegionError: The latest version of this model is only available hosted in China and requires explicit opt in: …` | Opt the model in explicitly in your **OpenCode (opencode.ai) workspace**. `deepseek-v4-pro` and `deepseek-v4-flash` currently answer this. |
| `data-policy` | `403 DataPolicyError: This model collects data used to improve its quality and requires explicit opt in` | Accept the model's data-use policy in your workspace. |
| `country-block` | `403 RegionError: This model is not available in your country.` · `403 [unsupported_country_region_territory] Country, region, or territory not supported` | Nothing local can fix it. `muse-spark-*-contributor` answers the first wording **today** (the audit observed the same models answering `DataPolicyError` earlier); `gpt-5.6-luna` answered the second at 04:32 UTC on 2026-09-11 and `200` seventeen minutes later — these gates are **dynamic**, so treat any single observation as a moment, not a property. |
| `format-unsupported` / `protocol-path-missing` | `401 … is not supported for format …`, HTML 404 | Handled automatically by the candidate chain. |
| `model-unavailable` | `400 … Upstream request failed: Model is unavailable.` | Pick another model; the gateway currently does not serve it. |
| `upstream` | `500 Internal server error` | Retry later; typically the gateway saying it does not serve that protocol for that model. |

`RegionError` covers two situations with different fixes (a China-hosted model can be opted into; a
country block cannot be fixed locally), so the wording decides the category.

The first time a model hits a category with an action, the adapter logs one `warn` line naming the
action, and the record is retrievable through `adapter.health.snapshot()` / `.unusable()` /
`.summaryLines()` for the phase-4 settings page.

> **Where those log lines go.** In this host version a plugin's `ctx.logger.*` output is collected by
> cordis's default in-memory exporter and never reaches stdout or a log file: `$DSH_HOME/web.log`
> exists only when `dsh.sh` launches the process (`DSH_LOG` defaults to it), and registering
> `ctx.logger.exporter()` from another plugin captures cordis's own error reports but not a sibling
> plugin's `ctx.logger.*` calls (both measured). The plugin therefore keeps its own bounded ring,
> readable as `adapter.logged` — which is how the acceptance verifies the `warn` above, and what the
> phase-4 settings page can render:
>
> ```
> adapter.logged.filter((line) => line.level === 'warn')
> → model "deepseek-v4-pro" is not usable on protocol "openai-responses" (region, HTTP 403): Enable the model explicitly…
> ``` Measured live (isolated instance, mode b):

```json
"unusable": [
  {"modelId":"deepseek-v4-pro","category":"region","status":403,
   "action":"Enable the model explicitly in your OpenCode (opencode.ai) workspace: …"},
  {"modelId":"muse-spark-1.2-contributor","category":"country-block","status":403,
   "action":"Nothing local can fix this: the endpoint reports the model as unsupported in this country/region."}
]
```

## Session header

The relay refuses any request without a recognised session header:

```
HTTP 400 {"type":"error","error":{"type":"MissingSessionID","message":"Error from provider
(Console Go): Request is missing x-opencode-session and cannot be routed efficiently."}}
```

pi-ai cannot emit that name through any `compat.sessionAffinityFormat` value (measured: the format
only ever produces `session_id`, `x-session-affinity`, `x-session-id`, or `x-client-request-id`),
so the plugin adds it at its own request-header layer — the same `headers` option every request
already uses for the mandatory attribution header. No global `fetch` patching, so the header can
never leak to another route (pinned by tests; observed on the wire in
`data/acceptance-phase3-2026-09-11-mode-a.json`).

### The relay's accepted names (measured 2026-09-11)

It is a **whitelist**, not "any header name will do". The full table is committed as
`data/session-headers.2026-09-11.json`:

| Header | Result |
|---|---|
| *(no session header)* | **400 `MissingSessionID`** |
| `x-opencode-session` | 200 |
| `x-deepseek-harness-session-id` | 200 |
| `x-session-id` | 200 |
| `session_id` | 200 |
| `session-id` | 200 |
| `x-conversation-id` | 200 |
| `X-OpenCode-Session` (mixed case) | 200 — header names are case-insensitive |
| `x-opencode-session:` (empty value) | **400 `MissingSessionID`** |
| `x-whatever-session`, `x-foo`, `x-session-affinity`, `x-client-request-id`, `x-request-id`, `x-opencode-session-id`, `x-opencode-request-id`, … (19 more) | **400 `MissingSessionID`** |

**The endpoint's behaviour is dynamic**: that table is one moment's fact, not an upstream contract
(the same caveat the protocol matrix carries). The default stays `x-opencode-session`; the name is
configurable; re-measure before trusting the list. Two extra notes worth knowing:

* an empty value is the same as no value — the plugin therefore omits the header rather than sending
  a value the relay would reject;
* `session_id` / `x-session-id` are also names pi-ai *would* emit if `compat.sessionAffinityFormat`
  were enabled. This plugin never enables it, so there is no second, invisible session value.

### Value policy (`sessionHeaderMode`)

| Mode | Value on the wire | Stable across |
|---|---|---|
| `session-id` (default) | the host's `GenerateOptions.sessionId`, verbatim | turns **and restarts** |
| `uuid` | an opaque `crypto.randomUUID()`, cached per (mode, conversation) | **this process only** |

**`uuid` is deliberately NOT persisted across restarts.** Its benefit is not disclosing the harness
session id; persisting it would not add to that — it would only preserve whatever relay-side
affinity/prompt-cache the value buys, and nothing measured so far shows the relay keys a cache on
this header (its measured job is routing: no header ⇒ 400). The cost is stated plainly: after a
restart the same conversation gets a new `uuid`, so if the relay does key a cache on it, that cache
starts cold once per conversation. `session-id` has no such cost. If persistence is ever wanted, the
smallest surface is `ctx.get('storage')` — not a workspace file.

A request with no host session id still gets a non-empty opaque value (one per process), so a
hand-built one-shot call remains routable.

### Reproducing the gate (live, consumes quota)

```bash
# The no-header regression: expects 400 MissingSessionID, and the control header 200.
npm run probe:session-regression

# The full name table (writes nothing by default; add --json to save it).
npm run probe:session-table
node scripts/probe-session-headers.mjs --live --json data/session-headers.<date>.json
node scripts/probe-session-headers.mjs --live --headers none,x-conversation-id     # re-measure a subset
```

`npm run probe:session-headers` (no `--live`) prints the candidate list and sends **nothing**;
`OCG_LIVE_PROBES=1` is the env-var equivalent of `--live`. The tool talks only to
`https://opencode.ai/zen/go/**`, reads the key from `OPENCODE_GO_API_KEY` or a credentials file
(never prints it), and the regression exits non-zero when the gate is not reproduced. The pure
decision logic (classifier, verdicts) is unit-tested without a network.

> **Phase note.** The phase-1 brief allowed this header to be accepted as configuration without being
> sent. Live acceptance showed that is impossible — no request can succeed without it — so it is
> active by default. Phase 3 was *hardening*: freeze the accepted-name list, keep the 400 reproducer
> as a gated regression, and decide the value policy (above).

## Build

`src/*.js` **is** the host implementation; `lib/` is its published copy. The browser half has its own
source tree (`src/client/`) and its own build step, which emits `lib/client.js` in the web module
loader's registration format.

```bash
npm run build        # host half (src/*.js → lib/*.js) + client half (src/client/** → lib/client.js)
npm run build:host   # only the host copy + export/import checks
npm run build:client # only the bundle; also rewrites package.json#dsh.client.external
npm test             # node --test tests/*.test.mjs  (no host packages, no DOM engine)
npm run typecheck    # node --check on both entry points
npm run models:check
```

The **client** build is a ~200-line bundler in `scripts/build-client.mjs`, not a frontend toolchain
on purpose: neither `esbuild` nor `tsdown` is in this repository's dependency closure, and adding one
would mean a network install before the plugin could be built. The bundler accepts exactly the subset
the client half uses — static relative imports (rewritten into a local module table and **deferred to
each factory's execution**), everything else left to the platform seed words the shell provides
(`react`, …) — and it **fails the build** on `export default`, dynamic `import()`, or `export *`
rather than emitting a bundle that only misbehaves in a browser. Source maps are unnecessary: the
host synthesizes an identity map for a bundle that ships none.

The export check is not decoration: `node --check` validates one file at a time, so a refactor that
dropped four response-side exports from `pi-ai.js` passed the syntax check and only failed when the
isolated instance tried to compose the plugin.

Phase 1 deliberately ships no TypeScript and no bundler dependency. The trade-off:

* ✅ the published artifact is byte-identical to the source you review, with no transform step to
  diverge or to trust;
* ✅ `lib/` is fully reproducible from `src/`;
* ✅ no build-tool supply chain in the plugin;
* ⚠️ `lib/` is **not committed** (it is in the skeleton's `.gitignore`) — run `npm run build` (or
  `npm pack`, whose `prepack` script builds) before installing from a checkout;
* ⚠️ phase 4b added the browser half as a **second small bundler** in this repository rather than a
  frontend toolchain (see above). The package layout (`main: lib/index.js`, `exports["./client"]`)
  did not change; `npm run build` still produces everything.

The decision logic (protocol rules, capability mapping, fallback classifier, memo, health, request
adaptation, the session-header name/value/merge policy, the credential precedence, the legacy-token
migration, and every settings-page rule) lives in host-free modules and is covered by `node --test`:
258 tests, no profile install and no DOM engine needed.

## 依赖解析 (dependency resolution)

`@earendil-works/pi-ai` is **not** a declared dependency of DSH — it is a package nested inside the
`dsh` installation (`dsh/node_modules/@earendil-works/pi-ai`), and the profile reaches it through the
`$DSH_HOME/profiles/node_modules` layer. This plugin therefore imports the very same specifiers the
official `dsh-llm-pi-ai` adapter does:

```js
import('@earendil-works/pi-ai')
import('@earendil-works/pi-ai/api/openai-completions.lazy')
```

Consequences worth knowing:

* the plugin must be installed **as a real directory** inside the profile (what `dsh plugin add`
  does). A symlinked checkout cannot resolve these specifiers.
* the import is **lazy**: a resolution failure surfaces at first use as
  `MISSING_DEPENDENCY … cannot load @earendil-works/pi-ai`, naming the cause, instead of taking the
  whole route down at load.
* `data/opencode-go.models.json` is read at load through `new URL('../data/…', import.meta.url)`, so
  the published tarball must include `data/` (it does; see `files` in `package.json`).

## Verify

Cheap, self-contained checks first:

```bash
npm run build                                     # src/ + src/client/ → lib/, both parsed
npm test                                          # 258 unit tests, no host packages, no DOM
node -e "import('./lib/index.js').then(m => console.log(m.PROVIDER, m.SUPPORTED_PROTOCOLS))"

# The browser half is exercised WITHOUT a browser: the built bundle is evaluated
# with a __ModuleLoader__ stub and a react stand-in that honors dependency arrays,
# then driven through describe/mutate/credentials/discovery/diagnostics.
node --test tests/client-bundle.test.mjs
node --test tests/client-logic.test.mjs tests/vocabulary.test.mjs
```

The credential rules have their own suites, each with a counter-proof where one
applies:

```bash
node --test tests/credential.test.mjs   # reference first; legacy inline only on a miss; swapped order must fail
node --test tests/migration.test.mjs    # every branch, including the two that must NOT delete the token
```

The load-time migration and the enriched catalogue route are also exercised
end-to-end against the built `lib/` with a fake host (fake `settings` /
`credentials` / `webServer`, `fetch` stubbed): the legacy token is stored under
the reference and unset from the document, the route answers `defaults` for a
catalogued model and the conservative fallback for an unknown id, and no
credential value reaches the diagnostics payload.

> The pre-0.6.0 `scripts/acceptance/apikey-run.sh` (isolated home + real browser
> over CDP, proving an inline `apiKey` was written to `settings.yaml`) documents a
> flow this version REMOVED. It is kept as the historical record, and it must not
> be re-run as an acceptance of the current build: the field it drives is now
> migration-only and the page no longer offers it.

Or by hand:

```bash
ISO=/tmp/dsh-ocg-$$
mkdir -p "$ISO/profiles"
cp -a ~/.dsh/profiles/web        "$ISO/profiles/web"         # profile copy
cp -a ~/.dsh/profiles/node_modules "$ISO/profiles/node_modules"
cp -a ~/.dsh/.credentials.yaml   "$ISO/.credentials.yaml"

npm pack --pack-destination /tmp/ocg-pack
DSH_HOME="$ISO" dsh plugin --profile web add /tmp/ocg-pack/dsh-opencodego-*.tgz

DSH_HOME="$ISO" dsh web --host 127.0.0.1 --port 39117 --no-open
# → dsh web: http://127.0.0.1:39117/?token=...
```

`$DSH_HOME/.credentials.yaml` is where the copied key must live for that instance.

Two traps found during the phase-2 acceptance, both worth reproducing deliberately:

* the plugin route and the credential plane activate asynchronously, so an in-process probe must
  wait for **both** before asking for a model (otherwise it reports a false `MISSING_CREDENTIAL`);
* re-installing a rebuilt tarball with the same version is a pnpm no-op — `remove` first.

> **Note (0.6.7):** the dated `data/acceptance-*.json`, `data/protocol-matrix.*.json` and
> `data/session-headers.*.json` evidence files referenced throughout this README are **no longer in
> the working tree** — nothing reads them (they are write-only outputs of the probes/runners below),
> their conclusions are transcribed in the prose, and they were bloating the published tarball.
> Recover any of them from git history (`git log --diff-filter=D --name-only -- data/`), or
> regenerate with the same commands. `data/` now ships exactly one file: `opencode-go.models.json`.

The phase-2 evidence — 19 assertions (prefill + primary protocol on the wire) and 26 assertions
(fallback, learned demotion, 403 no-retry, health diagnostics) from real isolated-instance runs — is
committed under `data/acceptance-phase2-2026-09-11-mode-{a,b}.json` (see the 0.6.7 note), with the
commands in [PROGRESS.md](./PROGRESS.md).

The phase-4a evidence is `data/acceptance-phase4a-2026-09-11.json` (14/14: the model-set overlay,
per-model protocol pins, the two cache-key fixes, the field-named rejections and the diagnostics
surface — all written through the settings service, never a file).

The phase-4b evidence is `data/acceptance-phase4b-2026-09-11.json` (30/30) and its runner is the
one command to reproduce it:

```bash
bash scripts/acceptance/phase4b-run.sh 39423
```

It copies `~/.dsh` into an isolated `DSH_HOME`, installs the packed plugin there, composes a patch
that mounts `scripts/acceptance/phase4b-probe.mjs`, starts `dsh web` on that port, then:

* reads the served page's boot graph and fetches the composed bundle URL to prove the host serves
  **this package's** `./client` registration (and that the bytes are content-addressed: a wrong
  revision is a 404);
* curls the three seam routes the page consumes;
* curls the probe's own route, which runs the settings round-trip assertions (the same
  `describe`/`get`/`mutate` calls the Remote namespace mirrors) — the round trip deliberately lives
  behind a route, because it must run after the plugin has registered its namespace;
* kills only the PID it started.

Nothing in that run prints a credential value: the only credential fact on the wire is the
reference NAME (`apiKeyEnv`), or the boolean "an inline token is configured".

The phase-3 evidence is `data/acceptance-phase3-2026-09-11-mode-{a,b,c}.json` from the same kind of
isolated run: (a) a real `glm-5.3-flash` stream whose wire header is exactly the caller's
`sessionId`, (b) `sessionHeaderEnabled: false` ⇒ no header on the wire and the relay's
`400 MissingSessionID` returned verbatim, (c) `sessionHeaderMode: uuid` ⇒ an opaque UUID on the wire
instead of the host id, with the stream still completing.

### Session-header tool

```bash
npm run probe:session-regression   # live: no header ⇒ 400 MissingSessionID, control header ⇒ 200
npm run probe:session-table        # live: the full accepted-name table (27 rows)
npm run probe:session-headers      # offline: just lists the candidates, sends nothing
node scripts/probe-session-headers.mjs --live --json data/session-headers.<date>.json
node scripts/probe-session-headers.mjs --live --headers none,x-session-id,x-conversation-id
```

Both live forms cost real quota, which is why they are opt-in (`--live` or `OCG_LIVE_PROBES=1`).
The tool only ever contacts `https://opencode.ai/zen/go/**`, redacts the bearer token from every
line it prints or writes, and exits non-zero when the regression is not reproduced. A network error
or a 5xx is retried once (recorded as `attempts` in the JSON) so a blip cannot read as a verdict;
a 400 or a 200 is never retried.

### Protocol matrix tool

```bash
node scripts/probe-protocols.mjs                                  # 37 × 3 matrix, human table + verdicts
node scripts/probe-protocols.mjs --models grok-4.6,kimi-k3        # narrow it
node scripts/probe-protocols.mjs --params --json data/protocol-matrix.<date>.json
node scripts/probe-protocols.mjs --no-session                     # reproduce 400 MissingSessionID
```

It drives pi-ai directly (no DSH process), sends `x-opencode-session`, honours the per-protocol base
URL and token floors, and records, per attempt, the HTTP status, the health category and the
endpoint's own words. `--params` additionally probes reasoning-effort acceptance, a replayed
reasoning turn, and the Responses token floor. pi-ai is resolved from a bare specifier first, then
`$PI_AI_ROOT`, `$DSH_HOME`, `~/.dsh`, or the global `dsh` installation beside the running Node.

## License

MIT

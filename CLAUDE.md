# CLAUDE.md

给接手这个仓库的人(或 agent)看的项目笔记。**保持简短。**

## 这是什么

DSH 插件,把 OpenCode Go 网关接成一个 provider route(`opencode-go-native`)。
浏览器半边是设置页,宿主半边是适配器 + 一条窄 HTTP 路由。

**核心立场:能力不靠声明,靠实测。** 声明和实测长得一样,混在一起就分不清了。

## 目录

```
src/                 宿主半边(会被 build.mjs 原样复制到 lib/)
  index.js           插件入口:注册 adapter / 设置页 / HTTP 路由
  adapter.js         请求路径:pi-ai 调度、协议回退链、会话头
  protocol-map.js    provider.npm -> 协议 规则,候选链
  sync.js            能力同步引擎(协议/可用性/reasoning 探针)
  synced.js          同步结果的落盘层
  official-baseline.js  models.dev 一手声明的解析与加载
  official-toml.js     自包含 TOML 子集解析器
  catalog.js / snapshot.js   模型集合与 provider.npm 快照
  capabilities.js    声明 -> pi-ai 的能力映射
  client/            浏览器半边(src/client/** -> lib/client.js)
data/
  opencode-go.official.json   官方能力基线(构建期从 models.dev 生成)
  opencode-go.models.json     只有 name + npm(协议推荐)
tests/               node --test,不需要装 profile
scripts/             获取数据 / 探针
```

## 必须守住的不变量

这些每一条都是踩出来的,别顺手改掉:

1. **`requestHeaders(attribution(), …)` 只有一个合并点**,attribution 永远不能少。`tests/session.test.mjs` 静态钉着调用点。
2. **`x-opencode-session` 是网关的必需头**,`/messages` 还要 `x-api-key`,只带 `authorization` 会 401。
3. **`sync.js` 的每发请求必须有超时**(`AbortSignal.timeout`),否则一发挂住整个同步永久卡死。
4. **`headersFor` 展开的是对象**,`syncModel` 收的却是 thunk —— 传错就静默变成空头。
5. **`index.js` 里 `export { x } from './y.js'` 不创建本地绑定**。sync 路由用过 `protocolChainForModel` 却没 import,运行时才炸。`tests/sync.test.mjs` 有静态守卫。
6. **客户端 `catalogueView` 是字段白名单**,新字段不加进去会被静默丢掉(`synced` 就这么丢过一次)。
7. **表格渲染里的 `|` 必须转义**,否则 Markdown 把整行切碎。
8. **`lib/` 提交在仓库里,而且不要加 `prepare` 脚本**。pnpm 会拦 git 包的构建脚本
   (`ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`),加 `prepare` 等于让每个装的人都去配 allowBuilds。
   代价是 `lib/` 必须和 `src/` 同步 —— **改完 `src/` 一定要 `npm run build` 并一起提交**,
   提交前跑 `npm run check:lib`(它构建一次再 `git diff --quiet -- lib`,不同步就非零退出)。
9. **`replaceDiscovered` 默认 `true`** —— 全新安装不加载任何模型。它必须和 `src/config.js` 的 schema 默认值保持一致,否则页面和路由对"启用集合"给出不同答案。
10. **`data/opencode-go.models.json` 只放 `name` 和 `npm`**。能力数字一律来自同步,放回来就是制造第二个互相打架的数据源。
11. **官方基线数字只在 `synced.js#composeEntryFaces` 合并**(由 `catalog.snapshotEntryFor` 唯一调用):只合 `contextWindow`/`maxTokens`/`inputModalities` 三个声明类字段,reasoning/protocol/interleavedField 仍归 synced 实测层;`snapshotEnabled: false` 时官方数字随快照面一起关。改这条优先级顺序 = 重新制造 200K 兜底 bug,`tests/official-capability.test.mjs` 钉着。

## 上游有两个,互相独立

| 上游 | 决定什么 | 什么时候动 |
|---|---|---|
| 网关 `/models` | **哪些模型存在** | 运行期自动,不用管 |
| models.dev 仓库 | **每个模型的官方声明** | 手动刷新 |

**运行时永远不抓第三方。** 声明只从打包的文件来,所以不会"今天一个数明天一个数"。

## 更新 models.dev 数据

```bash
npm run official:fetch     # 只重拉"上次用到的那些 TOML"
git diff data/opencode-go.official.json
npm run official:check     # CI:不一致就非零退出
```

- 基线里每个模型都记着 `sources`(它是从哪几个文件读出来的),所以刷新**只拉那几个文件**(实测 37 个模型 → 113 个文件),不是 clone 仓库。
- 上游改了某个 TOML → 直接刷新 review,**不用改代码**。
- 网关上了**新模型** → 会报 `unresolved`。这时:
  1. 看它归属哪个 lab(`models/<lab>/<id>.toml`)
  2. provider 目录名和 lab 名不一样 → 往 `src/official-baseline.js` 的 `LAB_PROVIDER_ALIASES` 加一条(现有:`meituan→longcat`、`tencent→tencent-tokenhub`)
  3. 还是找不到 → 用离线冷启动,它能列目录、按 `base_model` 反查:
     ```bash
     git clone --depth 1 -b dev https://github.com/anomalyco/models.dev /tmp/models.dev
     curl -sS -o /tmp/ids.json https://opencode.ai/zen/go/v1/models
     npm run official:fetch -- --repo /tmp/models.dev --input /tmp/ids.json
     ```
- **解析不到就记 `unresolved`,绝不拿别的厂商的数字顶上。**

可选:`npm run models:fetch`(刷新 `name`/`npm` 快照)。

## 构建 / 装 / 生效

```bash
npm run build     # src/ -> lib/;也重新生成 lib/client.js
npm test          # 不需要装 profile
npm pack
```

**生效分两半:**

| 改了什么 | 怎么生效 |
|---|---|
| `src/client/**` | 覆盖文件即可,`dsh-client-hmr` 每 500ms stat-poll 自动热重载 |
| `lib/index.js`、`src/*.js`、`data/*.json` | **必须重启 `dsh web`** |

**本地 `link:` 安装需要一层 dev symlink**:pnpm 的 `link:` 只建符号链接、**不装 peer 依赖**,
而 Node 按 workspace 真实路径解析裸包名,`@deepseek-ai/dsh-llm` 等会找不到
(启动报 `ERR_MODULE_NOT_FOUND`,整个 profile boot 失败)。修法是插件目录下一份
**dev-only、已 gitignore 的 `node_modules/`**,把宿主包链到全局 dsh 安装(与宿主同实例):

```bash
DSH_NM=<全局 dsh 安装>/node_modules   # 例:$(dirname "$(readlink -f "$(which dsh)")")/../node_modules
mkdir -p node_modules/@deepseek-ai node_modules/@earendil-works
for p in dsh-llm dsh-timeout dsh-credentials schemastery; do
  ln -sfn "$DSH_NM/@deepseek-ai/$p" "node_modules/@deepseek-ai/$p"
done
ln -sfn "$DSH_NM/@earendil-works/pi-ai" "node_modules/@earendil-works/pi-ai"
```

注意**动态 `import()` 也要覆盖**:`dsh-credentials` 与 `pi-ai`(含三个 `.lazy` 子路径)
是运行期按需导入的,静态 `from '…'` 扫描抓不到——漏了就是"启动正常、点某个按钮才
ERR_MODULE_NOT_FOUND"。补链后无需重启(动态导入按调用解析)。
`tests/` 不经过这层(它们只 import 无宿主依赖的模块)。

## 发布

```bash
npm run official:check && npm run models:check
npm test
# 改 package.json 的 version
git add -A && git commit -m "release vX.Y.Z" && git push
```

## 推之前扫一遍

```bash
git ls-files | grep -iE '\.env|\.pem|\.tgz' || echo OK
git ls-files -z | xargs -0 grep -InE 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}' || echo OK
git ls-files -z | xargs -0 grep -In '/home/[a-z]' || echo OK
```

(`tests/client-logic.test.mjs` 里的 `sk-abcdef…` 是测 `looksLikeSecretValue()` 的夹具,不是真凭据。)

## 常用探针

```bash
npm run probe:sync -- kimi-k3 glm-5 omen-alpha   # 真网关跑同步:可用 / 已下架 / 无官方记录
npm run probe:protocols                          # 协议矩阵
npm run probe:session-headers -- --live          # 会话头实测
```

# 更新与发布

这份文档只回答一件事:**上游变了,我该做什么。**

上游有两个,互相独立:

| 上游 | 它决定什么 | 什么时候要动 |
|---|---|---|
| **网关** `https://opencode.ai/zen/go/v1/models` | **哪些模型存在**(名单) | 随时,运行期自动 |
| **models.dev** `github.com/anomalyco/models.dev` | **每个模型的官方能力声明**(上下文/输出/模态/reasoning 契约) | 上游改了 TOML 时,手动刷新 |

运行时**永远不抓第三方**。能力声明只来自打包进插件的文件,所以"今天一个数明天一个数"不可能发生;什么时候更新、更新成什么,由你 review 后提交。

---

## 1. 日常:模型名单变了

**不用做事。** 名单是运行期从网关拉的,插件启动/打开设置页时自动刷新。

---

## 2. 刷新官方能力基线(models.dev 的 TOML)

```bash
npm run official:fetch          # 只重拉"上次用到的那些 TOML"
git diff data/opencode-go.official.json    # 逐条 review
npm run official:check          # CI 用:不一致就非零退出
```

### 它到底拉了什么

**不是 clone 仓库,也不是全量下载。** 基线文件里每个模型都记着自己是**从哪几个文件读出来的**:

```json
"kimi-k3": {
  "sources": {
    "ocg":            "providers/opencode-go/models/kimi-k3.toml",
    "providerModel":  "providers/moonshotai/models/kimi-k3.toml",
    "canonicalModel": "models/moonshotai/kimi-k3.toml",
    "provider":       "providers/moonshotai/provider.toml"
  }
}
```

刷新就**只重拉这些路径**(实测:37 个模型 → 113 个文件,约 3 个/模型)。某个路径 404 了(上游改名/移动)才对该模型单独按规则重新定位。

### 上游改了某个 TOML

直接 `npm run official:fetch`,diff 里会体现。**不需要改代码。**

### 网关上了新模型

这时会出现两种提示:

```
37 ids, 36 records, unresolved (某个新模型)
```

`unresolved` = 按规则找不到它的一手 provider。这时:

1. 看 models.dev 上这个模型归属哪个 lab(`models/<lab>/<id>.toml` 是否存在)
2. 如果那个 lab 的 provider 目录名和 lab 名不一样,往 `src/official-baseline.js` 的 **`LAB_PROVIDER_ALIASES`** 加一条(现有例子:`meituan → longcat`、`tencent → tencent-tokenhub`)
3. 如果是**没有 `base_model`、并且 provider 文件名和模型 id 完全不同**的情况,用离线模式冷启动一次,它能列目录、按"文件 target 的 canonical 模型"来找:

```bash
git clone --depth 1 -b dev https://github.com/anomalyco/models.dev /tmp/models.dev
curl -sS -o /tmp/ids.json https://opencode.ai/zen/go/v1/models
npm run official:fetch -- --repo /tmp/models.dev --input /tmp/ids.json
```

`--repo` 是**冷路径**:忽略旧的 `sources`,按规则重新推导,并把推导结果记进基线。之后在线刷新又会回到"只拉这几个文件"。

### 规则(不用记,代码里就是这套)

1. `base_model = "<lab>/<slug>"` —— 最权威
2. 否则看 `models/<lab>/<id>.toml`(大小写不敏感)
3. 否则看**自指 provider 目录**(目录里自己的文件 `base_model` 前缀 == 目录名)。转售商永远不会这样
4. 都不行 → 记 `unresolved`,**绝不拿别的厂商的数字顶上**

---

## 3. 刷新模型状态快照(可选)

```bash
npm run models:fetch
npm run models:check
```

`data/opencode-go.models.json` 现在只提供两件事:**每条模型的 `provider.npm`(协议推荐)** 和**显示名**。能力数字不再由它提供——能力信息一律来自"信息同步"的实测,只有同步过的模型才显示能力 chip。

---

## 4. 构建、安装、生效

```bash
npm run build        # src/ -> lib/,含浏览器半边
npm test             # 310+ 测试,不需要 profile
npm pack             # 产出 dsh-opencodego-<version>.tgz
```

装进 profile 并生效:

```bash
cd ~/.dsh/profiles/web
npm install /path/to/dsh-opencodego-<version>.tgz
```

**生效方式分两半,这点最容易踩:**

| 改的是哪半边 | 怎么生效 |
|---|---|
| **客户端**(`src/client/**` → `lib/client.js`) | 覆盖文件即可。`dsh-client-hmr` 每 500ms stat-poll 每个 bundle,自动通过 SSE 热重载到浏览器 |
| **宿主**(`lib/index.js`、`src/*.js`、`data/*.json`) | 插件在**进程启动时**加载,**必须重启 `dsh web`** |

> 只改了客户端却看不到变化,先确认浏览器拿到的 `rev` 变了(见 `GET /plugins/events` 的 graph 帧)。只改了宿主却没重启,新路由会 404 或直接 `ReferenceError`。

---

## 5. 发布

```bash
# 1. 版本号(package.json 的 version)
# 2. 确认基线不过期
npm run official:check && npm run models:check
# 3. 全绿
npm test
# 4. 打包
npm run build && npm pack
# 5. 提交
git add -A && git commit -m "release vX.Y.Z"
git push
```

`.gitignore` 已经排除 `lib/`、`*.tgz`、`node_modules/`,所以仓库里只有 `src/` 和 `data/`。

---

## 6. 推之前自检

```bash
# 1. 不该被跟踪的文件
git ls-files | grep -iE 'credential|\.env|secret|\.pem|\.tgz' || echo OK

# 2. 密钥模式
git ls-files -z | xargs -0 grep -InE 'sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}' || echo OK

# 3. 本地绝对路径(泄露用户名/目录结构)
git ls-files -z | xargs -0 grep -In '/home/[a-z]' || echo OK
```

**关于 `tests/` 里的假 key**:`tests/client-logic.test.mjs` 里有 `sk-abcdefgh...`,那是用来测 `looksLikeSecretValue()` 的**测试夹具**,不是真凭据。真凭据只存在于 `~/.dsh/.credentials.yaml`,从不进入本仓库,也从不被打印或写进日志(只有 sha256 前 12 位指纹会出现在运行输出里)。

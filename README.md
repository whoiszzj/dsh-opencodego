# dsh-opencodego

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的 **OpenCode Go** 提供方插件。

它把 OpenCode Go(以及任何 OpenCode 风格的 OpenAI 兼容网关)接进 DSH,并且**按每个模型实际支持的协议**发请求
(`openai-completions` / `openai-responses` / `anthropic-messages`),不用你手配。

模型能力**不靠猜**:插件会真的去问网关,把"这个模型还能不能用、走哪个协议、思考档位到底哪些管用"测出来。

---

## 安装

```bash
dsh plugin --profile web add github:whoiszzj/dsh-opencodego
```

装完**重启 `dsh web`**(宿主那半边是进程启动时加载的,不重启不生效)。

其它安装方式:

```bash
# 本地源码
cd /path/to/dsh-opencodego && npm run build
dsh plugin --profile web add /absolute/path/to/dsh-opencodego

# 发布包
npm pack
dsh plugin --profile web add ./dsh-opencodego-0.7.0.tgz
```

卸载:`dsh plugin --profile web remove dsh-opencodego`

---

## 用起来

装好后打开 **设置 → OpenCode Go**,页面就两件事:

### 1.「获取可用模型」= 挑要启用哪些

点一下,把网关当前提供的模型列出来。**只有 id 和名字**,不显示任何能力信息 —— 这一列只回答"有哪些"。

勾选 = 启用,取消 = 停用,点「应用选择」立刻生效,不用再点保存。

**默认一个模型都不加载**,你选谁才加载谁。想加列表里没有的 id,用「按 ID 添加模型」。

### 2.「信息同步」= 把能力问出来

针对**你已经启用的模型**,一条一条去问网关,带进度显示。每个模型会得到:

| | 怎么来的 |
|---|---|
| **还能不能用** | 真的发一次请求。已下架 / 区域门控 / 协议不通都会说清原因,**并建议换用哪个** |
| **协议** | 优先用 models.dev 推荐的(没有就用 OpenAI 格式),然后**实测确认它真的应答** |
| **上下文 / 最大输出 / 图片** | 取 models.dev 上官方一手声明,**不发请求** |
| **思考档位** | 先按官方契约逐档实测;**全通过就填官方那几档**;官方没记录才退化成逐档试,能用的才填 |

**只有同步过的模型才显示能力信息。** 同步前那一行会写"能力信息还没取过"——
因为声明出来的数字和实测出来的数字长得一样,混在一起就分不清了。

同步中随时可以「停止」,已经同步完的会保留。

---

## 配置

设置页里的字段:

| 字段 | 说明 |
|---|---|
| `baseURL` | 网关地址,默认 `https://opencode.ai/zen/go/v1`,**要带 `/v1`** |
| API Key | 存在 DSH 的凭据存储里,不落明文 |
| 会话头 | 网关要求的路由头,默认开,一般不用动 |

每个模型还可以单独改协议 / 上下文 / 输出 / 输入模态 / 思考档位(展开那一行的 `▸`),改完即生效。

---

## 遇到问题

**改了设置没反应** → 重启 `dsh web`。客户端那一半会自动热重载,宿主那一半不会。

**某个模型显示"已下架"** → 网关列表里还挂着,但上游已经不服务了。按提示换一个。

**某个模型显示"不可用(门控)"** → 账号或地区限制,不是模型问题,换天/换 workspace 可能就好了。

**同步很慢** → 每个模型要发几发请求,思考档位那几发需要模型真的思考一会儿。单发请求有 90 秒上限,不会真的卡死。

**全部模型都不可用** → 先检查 API Key 和 `baseURL`;设置页的「诊断」区会显示运行期实际生效的配置和最近的请求日志。

---

## 开发

改这个插件、刷新 models.dev 数据、发版,看 [`CLAUDE.md`](./CLAUDE.md)。

## License

MIT

/**
 * Configuration vocabulary SHARED by the two halves of this plugin.
 *
 * The browser half cannot import the host half: it is served as a standalone
 * bundle to the page and has no access to `node_modules` (see
 * `scripts/build-client.mjs`). The vocabulary below is therefore written once
 * and **inlined into both bundles by each build**, and `tests/vocabulary.test.mjs`
 * asserts the inlined client copy is deep-equal to the host's
 * (`src/models.js` / `src/vocab.js`) — a drift guard rather than two sources of
 * truth.
 *
 * Keep this module free of host imports: the bundler resolves its relative
 * imports and nothing else.
 *
 * @module dsh-opencodego/client/vocab
 */

/** The settings namespace this plugin owns (mirrors `src/config.js#NS`). */
export const SETTINGS_NS = 'opencode-go-native'

/** The `models` block's own keys (mirrors `src/models.js#MODEL_SET_KEYS`). */
export const MODEL_SET_KEYS = ['disabled', 'extra', 'overrides', 'replaceDiscovered']

/** Keys accepted in one `models.extra[]` entry (mirrors `MODEL_EXTRA_KEYS`). */
export const MODEL_EXTRA_KEYS = [
  'id', 'name', 'api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts',
]

/** Keys accepted in one `models.overrides[id]` entry (mirrors `MODEL_OVERRIDE_KEYS`). */
export const MODEL_OVERRIDE_KEYS = ['api', 'contextWindow', 'maxTokens', 'input', 'reasoning', 'reasoningEfforts']

/** Input modalities a configuration may name (mirrors `CONFIGURABLE_INPUT_MODALITIES`). */
export const CONFIGURABLE_INPUT_MODALITIES = ['text', 'image']

/** Thinking levels a configuration may name (mirrors `CONFIGURABLE_THINKING_LEVELS`, i.e. host levels minus `off`). */
export const CONFIGURABLE_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Wire protocols this build can dispatch (mirrors `SUPPORTED_PROTOCOLS`). */
export const SUPPORTED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** Session-header value policies (mirrors `SESSION_HEADER_MODES`). */
export const SESSION_HEADER_MODES = ['session-id', 'uuid']

/** The session header the relay requires unless configured otherwise (mirrors `DEFAULT_SESSION_HEADER`). */
export const DEFAULT_SESSION_HEADER = 'x-opencode-session'

/** Default credential REFERENCE (a variable name, never a value). */
export const DEFAULT_API_KEY_ENV = 'OPENCODE_GO_API_KEY'

/** Default gateway base including the `/v1` prefix. */
export const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

/** Scalar fields the page renders as plain controls (path → form key). */
export const SCALAR_FIELDS = [
  'baseURL',
  'apiKeyEnv',
  'displayName',
  'sessionHeader',
  'sessionHeaderEnabled',
  'sessionHeaderMode',
  'sync',
]

/** The hint under the session-header input. */
export const SESSION_HEADER_HINT =
  'RFC 7230 token：字母、数字与 !#$%&\'*+-.^_`|~；空格与冒号不合法。'


/**
 * The hint under the API-key input.
 *
 * This is the promise the field makes, and the reason the old plain-text input
 * was removed: the value goes through `ctx.credentials` into
 * `$DSH_HOME/.credentials.yaml` (or the launch environment), and the settings
 * document only ever records the reference NAME.
 */
export const API_KEY_HINT =
  '密钥写入凭据存储（$DSH_HOME/.credentials.yaml，权限 600），设置文件只记录引用名，不落明文。'
  + '留空=保持已存储的密钥不变。'

/**
 * The warning shown while a pre-0.6.0 plain-text `apiKey` is still present in
 * the settings document.
 *
 * It is a warning rather than a hint because the state itself is the problem:
 * the plugin migrates the value on load, and if this is visible the migration
 * could not complete.
 */
export const LEGACY_API_KEY_WARNING =
  '设置文件里还有旧版的明文 apiKey。插件会在启动时把它迁进凭据存储并删除这一项；'
  + '如果这条一直存在，说明迁移没成功（宿主日志里有原因），此时插件仍会临时使用它，请手动处理。'

/** Copy for the "获取可用模型" picker. */
export const FETCH_TITLE = '选择要启用的模型'
// The picker answers a MEMBERSHIP question and nothing else: which ids the
// gateway currently lists. It deliberately makes no capability claim, so this
// copy must not promise one.
export const FETCH_DESCRIPTION =
  '网关当前提供的全部模型（名单以网关披露为准），这里只回答“有哪些”，不显示能力值。'
  + '勾选=启用、取消=停用；点“应用选择”后立即生效，不需要再点保存。'
export const FETCH_SEARCH = '搜索模型'
export const FETCH_EMPTY = '网关没有列出任何模型；可以按 ID 添加，或检查上面的 API 地址/密钥。'
export const FETCH_NO_MATCHES = '没有匹配的模型。'
export const FETCH_SELECT_ALL = '全选'
export const FETCH_DESELECT_ALL = '取消全选'
export const FETCH_APPLY = '应用选择'

/** Copy for the capability sync ("信息同步"). */
export const SYNC_BUTTON = '信息同步'
export const SYNC_STOP = '停止'
export const SYNC_BUSY = '正在同步…'
export const SYNC_NOT_SYNCED = '能力信息还没取过；点“信息同步”才会问网关。'
export const SYNC_HINT =
  '把当前启用的模型逐个问一遍网关：还能不能用、用哪个协议、思考档位到底哪些管用。'
  + '能用的按官方契约补齐；官方没记录的才退化成逐档实测。上下文/输出/图片直接取官方值，不发请求。'

/** Copy for the by-id model adder (a model the gateway list does not show). */
export const ADD_MODEL_LABEL = '按 ID 添加模型'
export const ADD_MODEL_HINT = '输入网关的模型 ID（列表里没有的也能加；内置模型状态认识它的话，能力值会自动带上）。'
export const ADD_MODEL_BUTTON = '添加'

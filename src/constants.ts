/**
 * Wire constants for "Sign in with ChatGPT" and the ChatGPT (Codex) backend.
 *
 * Every value here mirrors what the open-source Codex CLI sends
 * (github.com/openai/codex, `codex-rs/login` and `codex-rs/codex-api`).
 */

export const PACKAGE_NAME = "oai-image";
export const PACKAGE_VERSION = "0.1.0";

/** OAuth issuer used by Sign in with ChatGPT. */
export const DEFAULT_ISSUER = "https://auth.openai.com";

/** Public OAuth client id of the Codex CLI. Sign in with ChatGPT has no per-app registration. */
export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export const OAUTH_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";

/** Loopback ports registered for the Codex OAuth client. Any other port is rejected by the issuer. */
export const LOGIN_PORT = 1455;
export const LOGIN_FALLBACK_PORT = 1457;
export const LOGIN_CALLBACK_PATH = "/auth/callback";

/** Base URL of the Codex API on the ChatGPT backend; `images/generations` and `images/edits` hang off it. */
export const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";

/** Sent as the `originator` header and OAuth parameter so OpenAI can tell this client apart from Codex. */
export const DEFAULT_ORIGINATOR = "oai-image";

/**
 * Codex sends its own release version in a `version` header and the backend
 * gates some features on it. This is the Codex release the wire format was
 * taken from.
 */
export const CODEX_COMPAT_VERSION = "0.167.0";

/** Refresh an access token this long before its `exp` claim, like Codex does. */
export const REFRESH_WINDOW_MS = 5 * 60 * 1000;

/** Without a readable `exp`, refresh tokens older than this, like Codex does. */
export const REFRESH_INTERVAL_MS = 8 * 24 * 60 * 60 * 1000;

export const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** Image generation regularly takes a minute or more at high quality. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Image model ids OpenAI documents for the Images API.
 *
 * `model` is sent verbatim, so ids missing from this list still work if the
 * backend knows them.
 */
export const KNOWN_IMAGE_MODELS = [
	"gpt-image-2.6-sunburst",
	"gpt-image-2.6-flare",
	"gpt-image-2.5-sunburst",
	"gpt-image-2.5-flare",
	"gpt-image-2",
	"gpt-image-1.5",
] as const;

/**
 * Shorthand accepted wherever a model id is. OpenAI publishes no bare
 * `gpt-image-2.6` id; Sunburst is the detail-oriented member of the family
 * and Flare the fast one.
 */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
	"gpt-image-2.6": "gpt-image-2.6-sunburst",
	"gpt-image-2.5": "gpt-image-2.5-sunburst",
	latest: "gpt-image-2.6-sunburst",
	sunburst: "gpt-image-2.6-sunburst",
	flare: "gpt-image-2.6-flare",
};

export const DEFAULT_IMAGE_MODEL = "gpt-image-2.6-sunburst";

/** The model id the Codex CLI itself sends on this route. */
export const CODEX_IMAGE_MODEL = "gpt-image-2";

/** The Images API accepts up to 16 input images on an edit. */
export const MAX_INPUT_IMAGES = 16;

export const ENV = {
	home: "OAI_IMAGE_HOME",
	model: "OAI_IMAGE_MODEL",
	baseUrl: "OAI_IMAGE_BASE_URL",
	issuer: "OAI_IMAGE_ISSUER",
	originator: "OAI_IMAGE_ORIGINATOR",
	outputDir: "OAI_IMAGE_OUTPUT_DIR",
	useCodexAuth: "OAI_IMAGE_USE_CODEX_AUTH",
	accessToken: "OAI_IMAGE_ACCESS_TOKEN",
	accountId: "OAI_IMAGE_ACCOUNT_ID",
	inlineMaxBytes: "OAI_IMAGE_MCP_INLINE_MAX_BYTES",
} as const;

/** Resolve a model alias to the id sent on the wire. Unknown ids pass through unchanged. */
export function resolveModel(model?: string): string {
	const requested = model?.trim() || process.env[ENV.model]?.trim() || DEFAULT_IMAGE_MODEL;
	return MODEL_ALIASES[requested.toLowerCase()] ?? requested;
}

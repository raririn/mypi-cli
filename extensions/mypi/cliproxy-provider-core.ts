import {
  type Api,
  type ApiKeyCredential,
  type AuthContext,
  type AuthInteraction,
  type Credential,
  type Model,
  type OpenAICodexResponsesOptions,
  type Provider,
  type ProviderStreams,
  type RefreshModelsContext,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";

export const CLIPROXY_PROVIDER_ID = "cliproxyapi";
export const CLIPROXY_PROVIDER_NAME = "CLIProxyAPI";
export const CLIPROXY_BASE_URL_ENV = "CLIPROXYAPI_BASE_URL";
export const CLIPROXY_API_KEY_ENV = "CLIPROXYAPI_API_KEY";
export const CLIPROXY_DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const CLIPROXY_CATALOG_TIMEOUT_MS = 15_000;
export const CLIPROXY_CATALOG_MAX_BYTES = 16 * 1024 * 1024;

const CATALOG_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const CATALOG_MAX_MODELS = 256;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type CliProxyModel = Model<"openai-codex-responses">;

interface CliProxyCatalogModel {
  readonly slug?: unknown;
  readonly id?: unknown;
  readonly display_name?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
  readonly context_window?: unknown;
  readonly max_context_window?: unknown;
  readonly max_output_tokens?: unknown;
  readonly input_modalities?: unknown;
  readonly supported_reasoning_levels?: unknown;
  readonly service_tiers?: unknown;
}

export interface CliProxyEndpoints {
  readonly rootUrl: string;
  readonly inferenceBaseUrl: string;
  readonly modelsUrl: string;
}

export interface CliProxyProviderDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly isFastEnabled?: () => boolean;
  /** Test seam; production uses the pinned Codex Responses implementation. */
  readonly codexStreams?: ProviderStreams;
}

function isLiteralLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function resolveCliProxyEndpoints(input: string): CliProxyEndpoints {
  let raw = input.trim();
  if (!raw) throw new Error("CLIProxyAPI base URL is empty.");
  if (!/^[a-z][a-z\d+.-]*:\/\//iu.test(raw)) raw = `http://${raw}`;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CLIProxyAPI base URL is invalid.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CLIProxyAPI base URL must use HTTPS, or HTTP on a literal loopback address.");
  }
  if (url.username || url.password) {
    throw new Error("CLIProxyAPI credentials must not be embedded in the base URL.");
  }
  if (url.search || url.hash) {
    throw new Error("CLIProxyAPI base URL must not include a query or fragment.");
  }
  if (url.protocol === "http:" && !isLiteralLoopback(url.hostname)) {
    throw new Error("Plain HTTP is allowed only for 127.0.0.1 or ::1; use HTTPS for remote CLIProxyAPI hosts.");
  }

  let rootPath = url.pathname.replace(/\/+$/u, "");
  if (rootPath.endsWith("/backend-api")) rootPath = rootPath.slice(0, -"/backend-api".length);
  else if (rootPath.endsWith("/v1")) rootPath = rootPath.slice(0, -"/v1".length);
  if (rootPath === "/") rootPath = "";

  const rootUrl = `${url.origin}${rootPath}`;
  return {
    rootUrl,
    inferenceBaseUrl: `${rootUrl}/backend-api/`,
    modelsUrl: `${rootUrl}/v1/models?client_version=mypi`,
  };
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function reasoningEfforts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const efforts: string[] = [];
  for (const item of value) {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as { effort?: unknown }).effort === "string"
        ? (item as { effort: string }).effort
        : "";
    const normalized = raw.trim().toLowerCase();
    if (normalized && !efforts.includes(normalized)) efforts.push(normalized);
  }
  return efforts;
}

function thinkingLevelMap(efforts: readonly string[]): CliProxyModel["thinkingLevelMap"] {
  if (efforts.length === 0) return undefined;
  const supported = new Set(efforts);
  return Object.fromEntries(THINKING_LEVELS.map((level) => [
    level,
    level === "off" ? (supported.has("none") ? "none" : null) : (supported.has(level) ? level : null),
  ])) as CliProxyModel["thinkingLevelMap"];
}

function inputModalities(value: unknown): Array<"text" | "image"> {
  const result: Array<"text" | "image"> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = String(item).trim().toLowerCase();
      if ((normalized === "text" || normalized === "image") && !result.includes(normalized)) result.push(normalized);
    }
  }
  if (!result.includes("text")) result.unshift("text");
  return result;
}

export function mapCliProxyCatalog(payload: unknown, endpoints: CliProxyEndpoints): CliProxyModel[] {
  const rawModels = Array.isArray(payload)
    ? payload
    : payload && typeof payload === "object" && Array.isArray((payload as { models?: unknown }).models)
      ? (payload as { models: unknown[] }).models
      : payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown }).data)
        ? (payload as { data: unknown[] }).data
        : undefined;
  if (!rawModels) throw new Error("CLIProxyAPI returned an unsupported model catalog.");

  const models: CliProxyModel[] = [];
  const seen = new Set<string>();
  for (const entry of rawModels) {
    if (models.length >= CATALOG_MAX_MODELS) break;
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as CliProxyCatalogModel;
    if (String(candidate.visibility ?? "").trim().toLowerCase() === "hide") continue;
    const idValue = typeof candidate.slug === "string" ? candidate.slug : candidate.id;
    const id = typeof idValue === "string" ? idValue.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const efforts = reasoningEfforts(candidate.supported_reasoning_levels);
    const fastCapable = Array.isArray(candidate.service_tiers) && candidate.service_tiers.length > 0;
    const nameValue = typeof candidate.display_name === "string" ? candidate.display_name : candidate.name;
    const name = typeof nameValue === "string" && nameValue.trim() ? nameValue.trim() : id;
    models.push({
      id,
      name,
      api: "openai-codex-responses",
      provider: CLIPROXY_PROVIDER_ID,
      baseUrl: endpoints.inferenceBaseUrl,
      reasoning: efforts.some((effort) => effort !== "none"),
      thinkingLevelMap: thinkingLevelMap(efforts),
      input: inputModalities(candidate.input_modalities),
      cost: { ...ZERO_COST },
      contextWindow: positiveInteger(candidate.context_window, positiveInteger(candidate.max_context_window, DEFAULT_CONTEXT_WINDOW)),
      maxTokens: positiveInteger(candidate.max_output_tokens, DEFAULT_MAX_TOKENS),
      compat: {
        requiresChatGptAccountId: false,
        supportsCodexToolCallIds: true,
        supportsPriorityServiceTier: fastCapable,
      },
    });
  }
  if (models.length === 0) throw new Error("CLIProxyAPI returned no usable models.");
  return models;
}

function boundedSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CLIPROXY_CATALOG_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > CLIPROXY_CATALOG_MAX_BYTES) {
    throw new Error("CLIProxyAPI model catalog exceeds the 16 MiB limit.");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CLIPROXY_CATALOG_MAX_BYTES) throw new Error("CLIProxyAPI model catalog exceeds the 16 MiB limit.");
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (bytes > CLIPROXY_CATALOG_MAX_BYTES) await reader.cancel().catch(() => undefined);
  }
}

export async function fetchCliProxyModels(
  endpoints: CliProxyEndpoints,
  apiKey: string,
  options: { readonly fetch?: typeof fetch; readonly signal?: AbortSignal } = {},
): Promise<CliProxyModel[]> {
  const response = await (options.fetch ?? fetch)(endpoints.modelsUrl, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: boundedSignal(options.signal),
  });
  if (!response.ok) throw new Error(`CLIProxyAPI model discovery failed with HTTP ${response.status}.`);
  const text = await readBoundedText(response);
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("CLIProxyAPI returned an invalid JSON model catalog.");
  }
  return mapCliProxyCatalog(payload, endpoints);
}

function connectionFromCredential(credential: Credential | undefined): { apiKey: string; endpoints: CliProxyEndpoints } | undefined {
  if (credential?.type !== "api_key" || !credential.key?.trim()) return undefined;
  const baseUrl = credential.env?.[CLIPROXY_BASE_URL_ENV] || CLIPROXY_DEFAULT_BASE_URL;
  return { apiKey: credential.key.trim(), endpoints: resolveCliProxyEndpoints(baseUrl) };
}

async function resolveAuthConnection(
  ctx: AuthContext,
  credential: ApiKeyCredential | undefined,
): Promise<{ credential: ApiKeyCredential; apiKey: string; endpoints: CliProxyEndpoints; source: string } | undefined> {
  const storedKey = credential?.key?.trim();
  const apiKey = storedKey || (await ctx.env(CLIPROXY_API_KEY_ENV))?.trim();
  if (!apiKey) return undefined;
  const storedBaseUrl = credential?.env?.[CLIPROXY_BASE_URL_ENV]?.trim();
  const baseUrl = storedBaseUrl || (await ctx.env(CLIPROXY_BASE_URL_ENV))?.trim() || CLIPROXY_DEFAULT_BASE_URL;
  const endpoints = resolveCliProxyEndpoints(baseUrl);
  return {
    apiKey,
    endpoints,
    source: storedKey ? "stored credential" : CLIPROXY_API_KEY_ENV,
    credential: { type: "api_key", key: apiKey, env: { [CLIPROXY_BASE_URL_ENV]: endpoints.rootUrl } },
  };
}

export function applyCliProxyFastPayload(payload: unknown): unknown {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? { ...(payload as Record<string, unknown>), service_tier: "priority" }
    : payload;
}

function withPriorityPayload(
  options: SimpleStreamOptions | undefined,
): SimpleStreamOptions {
  const onPayload = options?.onPayload;
  return {
    ...options,
    onPayload: async (payload, model) => {
      const prioritized = applyCliProxyFastPayload(payload);
      const replacement = await onPayload?.(prioritized, model);
      return replacement === undefined ? prioritized : replacement;
    },
  };
}

function fastCapable(model: Model<"openai-codex-responses">, isFastEnabled: () => boolean): boolean {
  return isFastEnabled() && model.compat?.supportsPriorityServiceTier === true;
}

function cliProxyStreams(isFastEnabled: () => boolean, codex = openAICodexResponsesApi()): ProviderStreams {
  return {
    stream(model, context, options) {
      const codexModel = model as Model<"openai-codex-responses">;
      const codexOptions = options as OpenAICodexResponsesOptions | undefined;
      const priorityOptions: OpenAICodexResponsesOptions = {
        ...codexOptions,
        ...withPriorityPayload(codexOptions),
        serviceTier: "priority",
      };
      return codex.stream(
        model,
        context,
        fastCapable(codexModel, isFastEnabled) ? priorityOptions : options,
      );
    },
    streamSimple(model, context, options) {
      const codexModel = model as Model<"openai-codex-responses">;
      return codex.streamSimple(model, context, fastCapable(codexModel, isFastEnabled) ? withPriorityPayload(options) : options);
    },
  };
}

function storedModelsForEndpoint(
  models: readonly Model<Api>[],
  endpoints: CliProxyEndpoints,
): CliProxyModel[] | undefined {
  if (models.length === 0) return undefined;
  if (models.some((model) => (
    model.provider !== CLIPROXY_PROVIDER_ID
    || model.api !== "openai-codex-responses"
    || model.baseUrl !== endpoints.inferenceBaseUrl
  ))) return undefined;
  return models as CliProxyModel[];
}

export function createCliProxyProvider(dependencies: CliProxyProviderDependencies = {}): Provider<"openai-codex-responses"> {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const environment = dependencies.environment ?? process.env;
  const isFastEnabled = dependencies.isFastEnabled ?? (() => false);
  const streams = cliProxyStreams(isFastEnabled, dependencies.codexStreams);
  let models: CliProxyModel[] = [];

  const login = async (interaction: AuthInteraction): Promise<ApiKeyCredential> => {
    const defaultBaseUrl = environment[CLIPROXY_BASE_URL_ENV]?.trim() || CLIPROXY_DEFAULT_BASE_URL;
    const enteredBaseUrl = await interaction.prompt({
      type: "text",
      message: `CLIProxyAPI base URL [${defaultBaseUrl}]`,
      placeholder: defaultBaseUrl,
    });
    const endpoints = resolveCliProxyEndpoints(enteredBaseUrl.trim() || defaultBaseUrl);
    const apiKey = (await interaction.prompt({ type: "secret", message: "CLIProxyAPI API key" })).trim();
    if (!apiKey) throw new Error("CLIProxyAPI API key cannot be empty.");
    interaction.notify({ type: "progress", message: "Validating CLIProxyAPI credentials and model catalog…" });
    await fetchCliProxyModels(endpoints, apiKey, { fetch: fetchImpl, signal: interaction.signal });
    return { type: "api_key", key: apiKey, env: { [CLIPROXY_BASE_URL_ENV]: endpoints.rootUrl } };
  };

  return {
    id: CLIPROXY_PROVIDER_ID,
    name: CLIPROXY_PROVIDER_NAME,
    baseUrl: resolveCliProxyEndpoints(CLIPROXY_DEFAULT_BASE_URL).inferenceBaseUrl,
    auth: {
      apiKey: {
        name: "CLIProxyAPI API key",
        login,
        async check({ ctx, credential }) {
          const resolved = await resolveAuthConnection(ctx, credential);
          return resolved ? { type: "api_key", source: resolved.source } : undefined;
        },
        async resolve({ ctx, credential }) {
          const resolved = await resolveAuthConnection(ctx, credential);
          if (!resolved) return undefined;
          return {
            auth: { apiKey: resolved.apiKey, baseUrl: resolved.endpoints.inferenceBaseUrl },
            env: resolved.credential.env,
            source: resolved.source,
          };
        },
      },
    },
    getModels: () => models,
    async refreshModels(context: RefreshModelsContext) {
      const connection = connectionFromCredential(context.credential);
      // Models.refresh retries a failed ambient-credential refresh offline with
      // the persisted credential (which is absent for env-only auth). Preserve
      // the already endpoint-checked in-memory catalog in that fallback path.
      if (!connection) return;
      const stored = await context.store.read();
      const cached = storedModelsForEndpoint(stored?.models ?? [], connection.endpoints);
      models = cached ?? [];
      if (!context.allowNetwork || context.signal?.aborted) return;
      if (!context.force && cached && stored?.checkedAt && now() - stored.checkedAt < CATALOG_MAX_AGE_MS) return;

      const refreshed = await fetchCliProxyModels(connection.endpoints, connection.apiKey, {
        fetch: fetchImpl,
        signal: context.signal,
      });
      if (context.signal?.aborted) return;
      models = refreshed;
      await context.store.write({ models: refreshed, checkedAt: now() });
    },
    stream: (model, context, options) => streams.stream(model, context, options),
    streamSimple: (model, context, options) => streams.streamSimple(model, context, options),
  };
}

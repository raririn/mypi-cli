import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const REDPANDA_PROVIDER_ID = "redpanda";
export const REDPANDA_PROVIDER_NAME = "RedPanda AI";
export const REDPANDA_API_BASE_URL = "https://api.whimsicott.com/mypi/v1";
export const REDPANDA_MANIFEST_URL = "https://api.whimsicott.com/control-api/mypi-provider";
export const REDPANDA_OAUTH_CLIENT_ID = "mypi-relay";
export const REDPANDA_OAUTH_ISSUER = "https://auth.whimsicott.com/application/o/mypi-relay/";

const DEVICE_AUTHORIZATION_URL = "https://auth.whimsicott.com/application/o/device/";
const TOKEN_URL = "https://auth.whimsicott.com/application/o/token/";
const OAUTH_SCOPE = "openid email profile offline_access inference";
const CATALOG_MAX_AGE_MS = 4 * 60 * 60 * 1000;
const TOKEN_EXPIRY_SKEW_MS = 30_000;

type ProviderConfig = Parameters<ExtensionAPI["registerProvider"]>[1];
type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

interface ProviderDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface DeviceAuthorizationResponse {
  readonly device_code: string;
  readonly user_code: string;
  readonly verification_uri: string;
  readonly verification_uri_complete?: string;
  readonly expires_in: number;
  readonly interval?: number;
}

interface OAuthTokenResponse {
  readonly access_token: string;
  readonly refresh_token?: string;
  readonly expires_in: number;
  readonly error?: string;
  readonly error_description?: string;
}

interface ProviderManifest {
  readonly version: 1;
  readonly provider: {
    readonly id: typeof REDPANDA_PROVIDER_ID;
  };
  readonly models: readonly unknown[];
}

const noCacheWrite = 0;

function model(
  id: string,
  name: string,
  options: {
    readonly reasoning: boolean;
    readonly image?: boolean;
    readonly input: number;
    readonly output: number;
    readonly cacheRead?: number;
    readonly contextWindow: number;
    readonly maxTokens: number;
  },
): ProviderModelConfig {
  return {
    id,
    name,
    reasoning: options.reasoning,
    input: options.image ? ["text", "image"] : ["text"],
    cost: {
      input: options.input,
      output: options.output,
      cacheRead: options.cacheRead ?? 0,
      cacheWrite: noCacheWrite,
    },
    contextWindow: options.contextWindow,
    maxTokens: options.maxTokens,
    compat: {
      supportsDeveloperRole: false,
      ...(options.reasoning
        ? {
            supportsReasoningEffort: false,
            reasoningFormat: "openrouter" as const,
          }
        : {}),
    },
  };
}

/**
 * Conservative offline snapshot. The site-owned manifest can update metadata,
 * but it may never expand this provider beyond twenty deliberately qualified
 * coding models.
 */
export const REDPANDA_FALLBACK_MODELS: readonly ProviderModelConfig[] = [
  model("openai/gpt-latest", "Latest GPT", { reasoning: true, image: true, input: 5, output: 30, cacheRead: 0.5, contextWindow: 1_050_000, maxTokens: 65_536 }),
  model("openai/gpt-mini-latest", "Latest GPT Mini", { reasoning: true, image: true, input: 0.75, output: 4.5, cacheRead: 0.075, contextWindow: 400_000, maxTokens: 65_536 }),
  model("anthropic/claude-sonnet-latest", "Latest Claude Sonnet", { reasoning: true, image: true, input: 2, output: 10, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("anthropic/claude-opus-latest", "Latest Claude Opus", { reasoning: true, image: true, input: 5, output: 25, cacheRead: 0.5, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("anthropic/claude-haiku-latest", "Latest Claude Haiku", { reasoning: true, image: true, input: 1, output: 5, cacheRead: 0.1, contextWindow: 200_000, maxTokens: 32_768 }),
  model("google/gemini-pro-latest", "Latest Gemini Pro", { reasoning: true, image: true, input: 1.25, output: 10, cacheRead: 0.125, contextWindow: 1_048_576, maxTokens: 65_536 }),
  model("google/gemini-flash-latest", "Latest Gemini Flash", { reasoning: true, image: true, input: 0.3, output: 2.5, cacheRead: 0.03, contextWindow: 1_048_576, maxTokens: 65_536 }),
  model("deepseek/deepseek-latest", "DeepSeek Latest", { reasoning: true, input: 1.1, output: 2.2, cacheRead: 0.11, contextWindow: 1_048_576, maxTokens: 65_536 }),
  model("openai/gpt-5.6-sol", "GPT-5.6 Sol", { reasoning: true, image: true, input: 5, output: 30, cacheRead: 0.5, contextWindow: 1_050_000, maxTokens: 65_536 }),
  model("openai/gpt-5.6-terra", "GPT-5.6 Terra", { reasoning: true, image: true, input: 2.5, output: 15, cacheRead: 0.25, contextWindow: 1_050_000, maxTokens: 65_536 }),
  model("openai/gpt-5.5-pro", "GPT-5.5 Pro", { reasoning: true, image: true, input: 30, output: 180, contextWindow: 1_050_000, maxTokens: 65_536 }),
  model("anthropic/claude-opus-4-8-fast", "Claude Opus 4.8 Fast", { reasoning: true, image: true, input: 10.5, output: 52.5, cacheRead: 1.05, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("google/gemini-3.5-flash", "Gemini 3.5 Flash", { reasoning: true, image: true, input: 1.5, output: 9, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("google/gemini-3.1-pro-preview-customtools", "Gemini 3.1 Pro Custom Tools", { reasoning: true, image: true, input: 2, output: 12, cacheRead: 0.2, contextWindow: 1_048_756, maxTokens: 65_536 }),
  model("moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", { reasoning: false, image: true, input: 0.74, output: 3.5, cacheRead: 0.15, contextWindow: 262_144, maxTokens: 32_768 }),
  model("moonshotai/kimi-k2.7-code-highspeed", "Kimi K2.7 Code High-Speed", { reasoning: true, image: true, input: 1.9, output: 8, cacheRead: 0.32, contextWindow: 262_144, maxTokens: 32_768 }),
  model("qwen/qwen3-coder-plus", "Qwen3 Coder Plus", { reasoning: false, input: 0.6825, output: 3.4125, cacheRead: 0.1365, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("qwen/qwen3-coder-flash", "Qwen3 Coder Flash", { reasoning: false, input: 0.20475, output: 1.02375, cacheRead: 0.04095, contextWindow: 1_000_000, maxTokens: 65_536 }),
  model("mistralai/codestral-2508", "Codestral 2508", { reasoning: false, input: 0.3, output: 0.9, cacheRead: 0.15, contextWindow: 256_000, maxTokens: 32_768 }),
  model("deepseek/deepseek-v3.2-thinking", "DeepSeek V3.2 Thinking", { reasoning: true, input: 0.28, output: 0.42, cacheRead: 0.14, contextWindow: 163_000, maxTokens: 32_768 }),
];

function asPositiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`RedPanda provider manifest has invalid ${label}.`);
  }
  return Number(value);
}

function asCost(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`RedPanda provider manifest has invalid ${label}.`);
  }
  return normalized;
}

export function parseRedPandaManifest(value: unknown): ProviderModelConfig[] {
  if (!value || typeof value !== "object") {
    throw new Error("RedPanda provider manifest is not an object.");
  }
  const manifest = value as Partial<ProviderManifest>;
  if (manifest.version !== 1 || manifest.provider?.id !== REDPANDA_PROVIDER_ID || !Array.isArray(manifest.models)) {
    throw new Error("RedPanda provider manifest has an unsupported schema.");
  }
  if (manifest.models.length === 0 || manifest.models.length > 20) {
    throw new Error("RedPanda provider manifest must contain between 1 and 20 models.");
  }

  const seen = new Set<string>();
  return manifest.models.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`RedPanda provider manifest model ${index + 1} is invalid.`);
    }
    const candidate = entry as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!id || !name || seen.has(id)) {
      throw new Error(`RedPanda provider manifest model ${index + 1} has an invalid or duplicate identity.`);
    }
    seen.add(id);
    const rawInput = Array.isArray(candidate.input) ? candidate.input : [];
    if (!rawInput.includes("text") || rawInput.some((item) => item !== "text" && item !== "image")) {
      throw new Error(`RedPanda provider manifest model ${id} has unsupported input modes.`);
    }
    const rawCost = candidate.cost && typeof candidate.cost === "object"
      ? candidate.cost as Record<string, unknown>
      : {};
    const reasoning = candidate.reasoning === true;
    return {
      id,
      name,
      reasoning,
      input: rawInput as ("text" | "image")[],
      cost: {
        input: asCost(rawCost.input, `${id} input cost`),
        output: asCost(rawCost.output, `${id} output cost`),
        cacheRead: asCost(rawCost.cacheRead ?? 0, `${id} cache-read cost`),
        cacheWrite: asCost(rawCost.cacheWrite ?? 0, `${id} cache-write cost`),
      },
      contextWindow: asPositiveInteger(candidate.contextWindow, `${id} context window`),
      maxTokens: asPositiveInteger(candidate.maxTokens, `${id} maximum output`),
      compat: {
        supportsDeveloperRole: false,
        ...(reasoning ? { supportsReasoningEffort: false, reasoningFormat: "openrouter" as const } : {}),
      },
    };
  });
}

function encodeForm(values: Record<string, string>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

async function readJsonResponse<T>(response: Response, operation: string): Promise<T> {
  const payload = await response.json().catch(() => null) as (T & { error?: string; error_description?: string }) | null;
  if (!response.ok || !payload) {
    const detail = payload?.error_description || payload?.error || `${response.status} ${response.statusText}`.trim();
    throw new Error(`${operation} failed: ${detail}`);
  }
  return payload;
}

function credentialsFromTokens(tokens: OAuthTokenResponse, previousRefresh?: string) {
  if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
    throw new Error("RedPanda OAuth returned an incomplete token response.");
  }
  const refresh = tokens.refresh_token || previousRefresh;
  if (!refresh) throw new Error("RedPanda OAuth did not return a refresh token.");
  return {
    access: tokens.access_token,
    refresh,
    expires: Date.now() + tokens.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS,
  };
}

export function createRedPandaProviderConfig(dependencies: ProviderDependencies = {}): ProviderConfig {
  const fetchImpl = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  return {
    name: REDPANDA_PROVIDER_NAME,
    baseUrl: REDPANDA_API_BASE_URL,
    api: "openai-completions",
    authHeader: true,
    models: [...REDPANDA_FALLBACK_MODELS],
    async refreshModels(context) {
      const stored = await context.store.read();
      const storedModels = stored?.models?.length
        ? stored.models.map((storedModel) => ({ ...storedModel, provider: undefined })) as ProviderModelConfig[]
        : undefined;
      if (!context.allowNetwork || context.signal?.aborted) {
        return storedModels ?? [...REDPANDA_FALLBACK_MODELS];
      }
      if (!context.force && stored?.checkedAt && now() - stored.checkedAt < CATALOG_MAX_AGE_MS) {
        return storedModels ?? [...REDPANDA_FALLBACK_MODELS];
      }

      try {
        const response = await fetchImpl(REDPANDA_MANIFEST_URL, {
          headers: { accept: "application/json" },
          signal: context.signal,
        });
        const refreshed = parseRedPandaManifest(await readJsonResponse<unknown>(response, "RedPanda model refresh"));
        if (context.signal?.aborted) return storedModels ?? [...REDPANDA_FALLBACK_MODELS];
        await context.store.write({
          checkedAt: now(),
          models: refreshed.map((entry) => ({
            ...entry,
            provider: REDPANDA_PROVIDER_ID,
            api: entry.api ?? "openai-completions",
            baseUrl: entry.baseUrl ?? REDPANDA_API_BASE_URL,
          })),
        });
        return refreshed;
      } catch (error) {
        if (context.signal?.aborted) return storedModels ?? [...REDPANDA_FALLBACK_MODELS];
        console.warn(`[mypi] RedPanda model refresh failed; using cached catalog: ${error instanceof Error ? error.message : String(error)}`);
        return storedModels ?? [...REDPANDA_FALLBACK_MODELS];
      }
    },
    oauth: {
      name: REDPANDA_PROVIDER_NAME,
      async login(callbacks) {
        callbacks.onProgress?.("Requesting a RedPanda AI sign-in code…");
        const deviceResponse = await fetchImpl(DEVICE_AUTHORIZATION_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: encodeForm({ client_id: REDPANDA_OAUTH_CLIENT_ID, scope: OAUTH_SCOPE }),
        });
        const device = await readJsonResponse<DeviceAuthorizationResponse>(deviceResponse, "RedPanda device authorization");
        if (!device.device_code || !device.user_code || !device.verification_uri || !Number.isFinite(device.expires_in)) {
          throw new Error("RedPanda device authorization returned an incomplete response.");
        }
        callbacks.onDeviceCode({
          userCode: device.user_code,
          verificationUri: device.verification_uri_complete || device.verification_uri,
          intervalSeconds: device.interval,
          expiresInSeconds: device.expires_in,
        });
        callbacks.onProgress?.("Waiting for RedPanda AI authorization…");

        const deadline = now() + device.expires_in * 1000;
        let intervalMs = Math.max(1, device.interval ?? 5) * 1000;
        while (now() < deadline) {
          await sleep(intervalMs);
          const tokenResponse = await fetchImpl(TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
            body: encodeForm({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: REDPANDA_OAUTH_CLIENT_ID,
              device_code: device.device_code,
            }),
          });
          const tokens = await tokenResponse.json().catch(() => null) as OAuthTokenResponse | null;
          if (tokenResponse.ok && tokens?.access_token) {
            callbacks.onProgress?.("RedPanda AI sign-in complete.");
            return credentialsFromTokens(tokens);
          }
          if (tokens?.error === "authorization_pending") continue;
          if (tokens?.error === "slow_down") {
            intervalMs += 5_000;
            continue;
          }
          const detail = tokens?.error_description || tokens?.error || `${tokenResponse.status} ${tokenResponse.statusText}`.trim();
          throw new Error(`RedPanda sign-in failed: ${detail}`);
        }
        throw new Error("RedPanda sign-in code expired before authorization completed.");
      },
      async refreshToken(credentials) {
        const response = await fetchImpl(TOKEN_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: encodeForm({
            grant_type: "refresh_token",
            client_id: REDPANDA_OAUTH_CLIENT_ID,
            refresh_token: credentials.refresh,
          }),
        });
        const tokens = await readJsonResponse<OAuthTokenResponse>(response, "RedPanda token refresh");
        return credentialsFromTokens(tokens, credentials.refresh);
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  };
}

export const REDPANDA_PROVIDER_CONFIG = createRedPandaProviderConfig();

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, AuthContext, CredentialStore, Model, Provider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { ResolvedPiAiProviderProfile } from '@deepseek-ai/dsh-llm-pi-ai'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { traeInputModalities, traeModelDisplayName, type TraeCatalog, type TraeModelInfo } from './catalog.ts'
import type { TraeShim } from './shim.ts'
import type { TraeRegion } from './region.ts'

/** Provider route this bundle owns for the domestic (CN) gateway. */
export const TRAE_PROVIDER = 'trae'

/**
 * Provider route this bundle owns for the international (trae.ai) gateway.
 * Named `-global` to match the plugin family's convention (`workbuddy-global`);
 * the internal region bucket stays `ai`, which is the gateway/protocol name.
 */
export const TRAE_AI_PROVIDER = 'trae-global'

/** The provider id each region registers as. */
export const TRAE_PROVIDERS: Readonly<Record<TraeRegion, string>> = {
  cn: TRAE_PROVIDER,
  ai: TRAE_AI_PROVIDER,
}

/** Human-readable provider names, shown in the DSH model picker. */
export const TRAE_PROVIDER_DISPLAY_NAMES: Readonly<Record<TraeRegion, string>> = {
  cn: 'Trae',
  ai: 'Trae Global',
}

/** Region a provider route id belongs to. */
export function regionOfTraeProvider(provider: string): TraeRegion | undefined {
  for (const [region, id] of Object.entries(TRAE_PROVIDERS) as [TraeRegion, string][]) {
    if (id === provider) return region
  }
  return undefined
}

export const TRAE_STREAM_IDLE_TIMEOUT_MS = 300_000

const INERT_AUTH: { credentials: CredentialStore; authContext: AuthContext } = {
  credentials: {
    async read() { return undefined },
    async list() { return [] },
    async modify() { throw new Error('dsh-connect-trae has no pi-ai credential lifecycle') },
    async delete() {},
  },
  authContext: {
    async env() { return undefined },
    async fileExists() { return false },
  },
}

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
} as const

/**
 * Conservative context capacity used only when a served model row carries no
 * window of its own. Every fallback row and every live Trae row is expected to
 * state its real window; this is the backstop that keeps one unsized row from
 * failing the entire provider route (`INVALID_MODEL_CONTEXT`).
 */
const FALLBACK_CONTEXT_WINDOW = 200_000

function toPiModel(info: TraeModelInfo, baseUrl: string, providerId: string): Model<Api> {
  return {
    id: info.id,
    name: traeModelDisplayName(info),
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: traeInputModalities(info),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: info.reasoningEfforts !== undefined,
    ...(info.reasoningEfforts === undefined ? {} : {
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: info.reasoningEfforts.low ?? null,
        medium: null,
        high: info.reasoningEfforts.high ?? null,
        xhigh: info.reasoningEfforts.xhigh ?? null,
        max: null,
      },
    }),
    ...(info.contextWindow === undefined ? {} : { contextWindow: info.contextWindow }),
    ...(info.maxTokens === undefined ? {} : { maxTokens: info.maxTokens }),
    compat: { supportsReasoningEffort: info.reasoningEfforts !== undefined },
  } as unknown as Model<Api>
}

export interface TraeAdapterOptions {
  shim: TraeShim
  catalog: TraeCatalog
  /** Provider route id this instance serves; defaults to the CN route. */
  provider?: string
  /** pi-ai provider name and profile display name; defaults to the CN name. */
  displayName?: string
  resolveAttachments?: () => AttachmentStore | undefined
}

export interface TraeAdapter {
  adapter: PiAiAdapter
  invalidate(): void
}

export function createTraeAdapter(options: TraeAdapterOptions): TraeAdapter {
  const providerId = options.provider ?? TRAE_PROVIDER
  const providerName = options.displayName ?? 'Trae'
  const buildModels = (): Model<Api>[] => options.catalog.current()
    .map(info => toPiModel(info, `${options.shim.baseUrl()}/v1`, providerId))

  const base = createProvider({
    id: providerId,
    name: providerName,
    auth: {
      apiKey: {
        name: 'Trae loopback secret',
        async resolve({ credential }) {
          const apiKey = credential?.key
          return apiKey === undefined || apiKey.length === 0
            ? undefined
            : { auth: { apiKey }, source: 'Trae loopback' }
        },
      },
    },
    models: buildModels(),
    api: openAICompletionsApi(),
  })
  const provider: Provider = { ...base, getModels: () => buildModels() }
  const profile: ResolvedPiAiProviderProfile = {
    provider: providerId,
    displayName: providerName,
    streamIdleTimeoutMs: TRAE_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-connect-trae retryPolicy'),
    configuredMaxTokens: new Map(),
    // DSH 0.1.5 made `modelErrors` a required field on this profile: the
    // adapter now consults it per model before a request and fails the call
    // with `INVALID_CONFIG` when the id is present. This plugin builds its
    // provider by hand from a live Trae catalog, so the kernel's own
    // catalog-resolution step (which populates this map) never runs for it;
    // an empty map states the correct fact — every served model is
    // serviceable. `piProvider` also became optional in 0.1.5, which this
    // hand-built profile still satisfies by always supplying it.
    modelErrors: new Map(),
    // Last-resort context capacity for any model row this route serves without
    // its own `contextWindow`. DSH rejects a model whose resolved window is not
    // a positive integer, and that rejection fails the WHOLE provider route, so
    // one unsized row would take an entire region offline (docs/ISSUE8_DIAGNOSIS.md).
    // Both fallback catalogs and live Trae rows now carry a real window, so this
    // value should never be consulted; it exists so that a future unsized row
    // degrades to one conservative model instead of a dead region.
    defaultContextWindow: FALLBACK_CONTEXT_WINDOW,
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }
  // Replacing (not mutating) the map is what `invalidate` uses to force the
  // adapter's next profiles read to rebuild its snapshot.
  let profiles = new Map<string, ResolvedPiAiProviderProfile>([[providerId, profile]])
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => options.shim.token(),
    ...options.resolveAttachments === undefined ? {} : { resolveAttachments: options.resolveAttachments },
  })

  return {
    adapter,
    invalidate() {
      profiles = new Map([[providerId, profile]])
    },
  }
}

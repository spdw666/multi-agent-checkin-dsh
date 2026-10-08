/**
 * Region model shared by every layer: two storage buckets (`cn` | `ai`) keyed
 * by the credential's own claim, plus the per-region gateway constants.
 *
 * Evidence: docs/INTL_SG_EVIDENCE.md (2026-09-15). The desktop installs of
 * both regions expose the same wire shapes; only the gateways, rosters, and
 * the refresh contract differ. `userRegion.region` ('CN' | 'SG', observed in
 * both cases; the desktop logs also spell it lowercase 'sg') is the
 * authoritative claim, the credential host suffix is the fallback, and the
 * edition label is the last resort.
 *
 * @module dsh-connect-trae/region
 */

import type { TraeEdition } from './paths.ts'

/** Storage/routing bucket: the CN service or the international (ai) service. */
export type TraeRegion = 'cn' | 'ai'

/** One region's upstream gateway bases. */
export interface TraeRegionGateways {
  /** Chat + agent API base (the `llm_utils_chat` / raw-chat family). */
  readonly chat: string
  /** SOLO remote model directory base (`/api/remote/v1`). */
  readonly remote: string
  /** Pay/status API base; the credential's own host is preferred when known. */
  readonly pay: string
}

/**
 * Verified gateway bases per region (docs/INTL_SG_EVIDENCE.md §2).
 * The AI gateway is shared by both international installs (Trae desktop and
 * TRAE SOLO); its mchost shards (`api16/api22-normal-alisg.mchost.guru`)
 * answer the same bytes but stay internal — `coresg-normal.trae.ai` is the
 * single stable entry point.
 */
export const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
}

/** Region for an edition label: the international installs belong to `ai`. */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn'
}

/**
 * Region from the credential's `userRegion` claim. The desktop storage spells
 * it as an object (`{"region":"CN","_aiRegion":"CN"}`); the app logs also
 * spell the bare value lowercase (`"sg"`). Both are accepted, case-blind.
 */
export function regionOfUserRegion(value: unknown): TraeRegion | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value
  if (typeof raw !== 'string') return undefined
  const lowered = raw.trim().toLowerCase()
  if (lowered === 'cn') return 'cn'
  if (lowered === 'sg' || lowered === 'ai') return 'ai'
  return undefined
}

/** Region from a credential host (`.trae.ai` → ai, `.trae.cn`/`.trae.com.cn` → cn). */
export function regionOfHost(host: string | undefined): TraeRegion | undefined {
  if (host === undefined) return undefined
  const trimmed = host.trim()
  if (trimmed === '') return undefined
  let hostname: string
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return undefined
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai'
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')) return 'cn'
  return undefined
}

/**
 * Region of a credential: the `userRegion` claim wins, the host suffix is the
 * fallback, and the edition label is the last resort. Every level is derived
 * from data the credential itself carries, so no user configuration is needed.
 */
export function regionOfCredential(credential: {
  edition: TraeEdition
  host?: string
  userRegion?: string
}): TraeRegion {
  return regionOfUserRegion(credential.userRegion)
    ?? regionOfHost(credential.host)
    ?? regionOfEdition(credential.edition)
}

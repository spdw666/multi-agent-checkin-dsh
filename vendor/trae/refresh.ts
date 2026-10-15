import type { TraeCredential, TraeRefreshOutcome } from './auth.ts'
import type { TraeEdition } from './paths.ts'
import { hostname } from 'node:os'

/**
 * Per-edition refresh contract (docs/INTL_SG_EVIDENCE.md §2.2).
 *
 * The refresh endpoint is the ONE contract that forks by edition rather than
 * by region: the desktop apps (CN and international) plus SOLO CN all use the
 * `/cloudide/...` path and the shared ClientID, while TRAE SOLO international
 * was verified (2026-09-15, official app's own call) on the newer
 * `/trae/api/v3/oauth/` path with its own ClientID and a DeviceInfo body.
 * Every request hangs off the credential's own host, never a hardcoded base.
 */
interface TraeRefreshContract {
  readonly path: string
  readonly clientId: string
  /** Whether the official client sends a DeviceInfo object in the body. */
  readonly deviceInfo: boolean
}

const REFRESH_CONTRACT: Readonly<Record<TraeEdition, TraeRefreshContract>> = {
  cn: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  sg: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  solo: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  'solo-sg': { path: '/trae/api/v3/oauth/ExchangeToken', clientId: 'en1oxy7wnw8j9n', deviceInfo: true },
}

/** Stable device identity for the DeviceInfo body, sourced from the app's own storage. */
export interface TraeRefreshDevice {
  deviceId: string
  machineId: string
}

function normalizeHost(host: string): string {
  const value = host.trim()
  if (value === '') throw new Error('Trae refresh host is missing')
  return value.replace(/\/$/, '')
}

/**
 * Exchange a refresh token for a fresh access token, following the calling
 * edition's verified contract. `device` is only used by editions whose
 * official client sends a DeviceInfo body; when it cannot be resolved the
 * field is omitted rather than sent empty.
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  signal?: AbortSignal,
  device?: TraeRefreshDevice,
): Promise<TraeRefreshOutcome> {
  const contract = REFRESH_CONTRACT[credential.edition]
  if (contract === undefined) throw new Error(`Trae ${credential.edition} refresh contract is not verified`)
  if (credential.refreshToken === undefined) throw new Error('Trae refresh token is missing')
  const body: Record<string, unknown> = {
    ClientID: contract.clientId,
    ClientSecret: '-',
    RefreshToken: credential.refreshToken,
    UserID: credential.userId,
  }
  if (contract.deviceInfo && device !== undefined) {
    body['DeviceInfo'] = {
      DeviceID: device.deviceId,
      MachineID: device.machineId,
      PlatformCode: credential.edition === 'solo-sg' ? 'SOLO_PC' : 'TRAE',
      DeviceType: 'PC',
      DeviceName: hostname(),
    }
  }
  const response = await fetch(`${normalizeHost(credential.host)}${contract.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  })
  if (!response.ok) throw new Error(`Trae token refresh failed (http ${response.status})`)
  const payload = await response.json() as { Result?: Record<string, unknown> }
  const result = payload.Result
  const accessToken = typeof result?.['Token'] === 'string' ? result['Token'] : ''
  if (accessToken === '') throw new Error('Trae token refresh returned no token')
  const expiry = result?.['TokenExpireAt']
  const expiresAtMs = typeof expiry === 'number' ? expiry : typeof expiry === 'string' ? Date.parse(expiry) : Number.NaN
  if (!Number.isFinite(expiresAtMs)) throw new Error('Trae token refresh returned an invalid expiry')
  const refreshToken = typeof result?.['RefreshToken'] === 'string' && result['RefreshToken'] !== '' ? result['RefreshToken'] : undefined
  return { accessToken, ...refreshToken === undefined ? {} : { refreshToken }, expiresAtMs }
}

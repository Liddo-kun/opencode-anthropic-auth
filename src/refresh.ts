import { Credential } from '@opencode/plugin'
import { parseTokens } from './auth.ts'
import { CLIENT_ID, TOKEN_URL } from './constants.ts'

// Shared across Location plugin instances. Keep completed rotations as well as inflight
// attempts: core may call refresh with an old snapshot after the first call persisted.
// Failed attempts are dropped so a transient failure doesn't block the token until restart.
// Never persist this map or log its keys.
const rotations = new Map<string, Promise<Credential.OAuth>>()
const refreshWindow = 5 * 60 * 1000

export async function refreshOAuth(
  credential: Credential.OAuth,
): Promise<Credential.OAuth> {
  const previous = rotations.get(credential.refresh)
  if (previous) {
    const current = await previous
    if (current.expires > Date.now() + refreshWindow) return current
    if (current.refresh !== credential.refresh) return refreshOAuth(current)
    // Providers may retain the same refresh token. Only its completed, expired grant
    // can be replaced, and only if another caller has not already replaced the entry.
    if (rotations.get(credential.refresh) !== previous)
      return refreshOAuth(current)
    rotations.delete(credential.refresh)
  }
  const pending = rotate(credential)
  rotations.set(credential.refresh, pending)
  pending.catch(() => {
    if (rotations.get(credential.refresh) === pending)
      rotations.delete(credential.refresh)
  })
  return pending
}

async function rotate(credential: Credential.OAuth): Promise<Credential.OAuth> {
  const response = await fetch(TOKEN_URL, {
    tls: { rejectUnauthorized: true },
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'axios/1.13.6',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: credential.refresh,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Anthropic OAuth refresh failed (HTTP ${response.status}). Sign in again with Claude Pro/Max.`,
    )
  }
  const tokens = parseTokens(await response.json())
  return Credential.OAuth.make({
    ...credential,
    refresh: tokens.refresh_token,
    access: tokens.access_token,
    expires: Math.floor(Date.now() + tokens.expires_in * 1000),
  })
}

import { isInsecure, resolveBaseUrl } from './transform.ts'

export const insecureProvider = new URL(
  './insecure-provider.ts',
  import.meta.url,
).href

export function insecureEndpoint(): URL | undefined {
  if (!isInsecure()) return undefined
  const endpoint = resolveBaseUrl()
  if (!endpoint)
    throw new Error(
      'ANTHROPIC_INSECURE requires a valid HTTP(S) ANTHROPIC_BASE_URL without URL credentials.',
    )
  return endpoint
}

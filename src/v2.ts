import { Credential, Integration } from '@opencode/plugin'
import type { Context, Plugin } from '@opencode/plugin/promise/plugin'
import type { Registration } from '@opencode/plugin/promise/registration'
import { authorize, exchange } from './auth.ts'
import { insecureEndpoint, insecureProvider } from './insecure.ts'
import { refreshOAuth } from './refresh.ts'
import { rewriteUrl, setOAuthHeaders } from './transform.ts'

const integrationID = 'anthropic'
const methodID = Integration.MethodID.make('claude-pro-max')
const scope = { providerID: 'anthropic' }

export default {
  id: 'ex-machina.anthropic-auth',
  async setup(context: Context) {
    const registrations: Registration[] = []
    const events = new AbortController()
    const insecure = Boolean(insecureEndpoint())
    const wrapped = new Set<string>()
    let subscription = false
    let stopped = false

    async function credential() {
      const connection =
        await context.integration.connection.active(integrationID)
      if (
        !connection ||
        connection.type !== 'credential' ||
        connection.method !== 'oauth'
      )
        return undefined
      const value = await context.integration.connection.resolve(connection)
      return value?.type === 'oauth' && value.methodID === methodID
        ? value
        : undefined
    }

    async function load() {
      const next = Boolean(await credential())
      const changed = next !== subscription
      subscription = next
      return changed
    }

    async function dispose() {
      stopped = true
      events.abort()
      await Promise.all(
        registrations.reverse().map((registration) => registration.dispose()),
      )
    }

    try {
      registrations.push(
        await context.integration.transform((editor) => {
          editor.method.update({
            integrationID,
            method: { id: methodID, type: 'oauth', label: 'Claude Pro/Max' },
            async authorize() {
              const attempt = await authorize('max')
              const expiresAt = Date.now() + 10 * 60 * 1000
              let exchangePromise: Promise<Credential.OAuth> | undefined
              return {
                mode: 'code',
                url: attempt.url,
                instructions:
                  'Open this URL in your browser, authorize Claude Pro/Max, then paste the complete callback URL, code#state, or code=...&state=... here. A bare code without state is not accepted.',
                expiresAt,
                callback(input: string) {
                  if (exchangePromise) return exchangePromise
                  if (Date.now() >= expiresAt)
                    return Promise.reject(
                      new Error(
                        'Claude authorization expired. Start login again.',
                      ),
                    )
                  exchangePromise = exchange(
                    input,
                    attempt.verifier,
                    attempt.redirectUri,
                    attempt.state,
                  ).then((result) => {
                    if (result.type !== 'success')
                      throw new Error(
                        'Claude authorization failed or the callback state did not match. Start login again.',
                      )
                    return Credential.OAuth.make({
                      type: 'oauth',
                      methodID,
                      access: result.access,
                      refresh: result.refresh,
                      expires: Math.floor(result.expires),
                    })
                  })
                  return exchangePromise
                },
              }
            },
            refresh: refreshOAuth,
            label: () => 'Claude Pro/Max',
          })
        }),
      )
      await load()

      registrations.push(
        await context.model.transform((editor) => {
          wrapped.clear()
          if (!subscription) return
          for (const model of editor.list('anthropic')) {
            editor.update(model.providerID, model.id, (draft) => {
              // V2 represents prices as tier arrays; an empty array is zero for all
              // input, output and cache usage, as in the built-in subscription plugin.
              draft.cost = []
              const nativePackage =
                draft.package ??
                editor.provider.get(model.providerID)?.provider.package
              if (
                insecure &&
                nativePackage === '@opencode/ai/providers/anthropic'
              ) {
                draft.package = insecureProvider
                wrapped.add(model.id)
              }
            })
          }
        }),
      )

      registrations.push(
        await context.session.hook(
          'http.request',
          async (event) => {
            const auth = await credential()
            if (!auth) return // API keys and environment-key connections stay untouched.
            if (insecure && !wrapped.has(event.model.id)) {
              throw new Error(
                'ANTHROPIC_INSECURE supports only the stock @opencode/ai/providers/anthropic package with Claude Pro/Max. Use that native package or disable ANTHROPIC_INSECURE.',
              )
            }
            const headers = setOAuthHeaders(
              new Headers(event.request.headers),
              auth.access,
            )
            const rewritten = rewriteUrl(event.request)
            const request =
              rewritten.input instanceof Request
                ? rewritten.input
                : event.request
            event.request = new Request(request, { headers })
          },
          scope,
        ),
      )

      // Reload from the original catalog on account switches, restoring both
      // native packages and normal prices for API-key accounts.
      const watching = (async () => {
        for await (const event of context.event.subscribe({
          signal: events.signal,
        })) {
          if (stopped) break
          if (
            event.type !== 'credential.switched' &&
            event.type !== 'credential.updated'
          )
            continue
          if (
            event.type === 'credential.switched' &&
            event.data.integrationID !== integrationID
          )
            continue
          if (await load()) await context.model.reload()
        }
      })().catch(() => {
        if (!stopped)
          console.error(
            'Claude subscription credential watcher stopped; reload the plugin before changing accounts.',
          )
      })
      await context.model.reload()
      return async () => {
        await dispose()
        await watching
      }
    } catch (error) {
      await dispose()
      throw error
    }
  },
} satisfies Plugin

import * as Anthropic from '@opencode/ai/providers/anthropic'
import type { HttpHandler } from '@opencode/ai/route/executor'
import { LLMRequest } from '@opencode/ai/schema/messages'
import { LanguageModel } from '@opencode/ai/schema/options'
import { Effect, Option } from 'effect'
import { FetchHttpClient } from 'effect/unstable/http'
import { insecureEndpoint } from './insecure.ts'

// Subscription-only entrypoint, selected by v2.ts rather than user configuration.
// Core passes OAuth access as apiKey to custom packages; the built-in needs authToken.
export const model: typeof Anthropic.model = (
  modelID,
  { apiKey, authToken, ...settings },
) => {
  const selected = Anthropic.model(modelID, {
    ...settings,
    authToken: apiKey ?? authToken,
  })
  const transport = selected.route.transport
  return LanguageModel.update(selected, {
    route: selected.route.with({
      transport: {
        ...transport,
        // Packaged hosts and external providers have separate LanguageModel classes.
        // Reconstruct only this nominal field before the provider's prepare updates
        // its request; preserve the host's resolved model/route/defaults verbatim.
        prepare: (input) =>
          transport.prepare({
            ...input,
            request: LLMRequest.update(input.request, {
              model: new LanguageModel(
                LanguageModel.input(input.request.model),
              ),
            }),
          }),
        execute: (prepared, request, runtime, options) =>
          transport.execute(
            prepared,
            request,
            {
              ...runtime,
              http: {
                execute: (input, middleware) =>
                  runtime.http.execute(input, (outgoing, handler) => {
                    // Run existing hooks first. Only the final send gets the TLS exception;
                    // OAuth resolution/refresh inside those hooks never inherits it.
                    const send: HttpHandler = (final) =>
                      Effect.gen(function* () {
                        const endpoint = insecureEndpoint()
                        if (
                          !endpoint ||
                          new URL(final.url).origin !== endpoint.origin
                        )
                          return yield* handler(final)
                        const ambient = Option.getOrUndefined(
                          yield* Effect.serviceOption(
                            FetchHttpClient.RequestInit,
                          ),
                        )
                        const init: RequestInit & {
                          tls: { rejectUnauthorized: false }
                        } = {
                          ...ambient,
                          tls: { rejectUnauthorized: false },
                        }
                        return yield* handler(final).pipe(
                          Effect.provideService(
                            FetchHttpClient.RequestInit,
                            init,
                          ),
                        )
                      })
                    return middleware
                      ? middleware(outgoing, send)
                      : send(outgoing)
                  }),
              },
            },
            options,
          ),
      },
    }),
  })
}

# Claude v2 transport implementation — 2026-10-04

## Decision and implementation

Master selected the existing public plugin/provider wrapper. Implemented entirely
in `/home/jon/code/opencode-anthropic-auth-v2`; no shared API or host-core edits.

- `src/v2.ts`: keeps the existing integration, OAuth headers, endpoint rewrite and
  subscription prices. Only an active `claude-pro-max` subscription with explicit
  insecure custom-endpoint settings retargets stock native Anthropic models. The
  effective package includes a provider-level inherited package. IDs, model IDs,
  variants, limits, capabilities, settings, headers and body overlays are retained.
  Connection changes reload from the original catalog, restoring packages/costs.
- `src/insecure.ts`: local provider URI and validated insecure endpoint selection.
- `src/insecure-provider.ts`: delegates model construction to the built-in
  Anthropic provider, translating custom-package OAuth `apiKey` to `authToken`.
   `LanguageModel.update` and `route.with` wrap transport execution. At prepare,
   the host model is reconstructed as the external provider's `LanguageModel`
   before delegation: packaged hosts have a separate nominal class identity.
   The model fields, original prepare/execute, options, runtime and middleware are forwarded. After
  middleware finishes rewriting the request, the final origin is checked and the
  existing executor runs with a scoped Effect `FetchHttpClient.RequestInit`.
  Ambient fetch options are retained; `tls.rejectUnauthorized` is set to false.
  No replacement fetch/client/layer or process-wide setting is introduced.
- `src/auth.ts` and `src/refresh.ts`: fixed token URL, explicit Bun
  `tls.rejectUnauthorized: true`. Refresh runs inside the original HTTP hook,
  before the final-send TLS scope, and does not inherit it.
- `src/transform.ts`: exports the existing base-URL parser for reuse.
- `package.json`, `bun.lock`: host-version peer metadata reconciled with Bun 1.4.2.
- `tsconfig.v2.json`: focuses source checking on the v2 entrypoint and wrapper.

Normal Anthropic and verified custom-endpoint OAuth routes keep their original
native package. API-key/environment connections keep their existing transport.
The wrapper URI is internal routing; do not configure it as another provider or
rename the `anthropic` provider/model IDs.

## Existing public API evidence

Host source paths below are relative to `/home/jon/code/Tandem-v2`:

| Requirement | Source |
| --- | --- |
| Local native provider `model(modelID, settings)` | `packages/core/src/provider.ts:109–135,448–469`; `packages/ai/src/provider-package.ts` |
| Public catalog transform and reload | `packages/plugin/src/promise/model.ts`; `packages/core/src/model.ts:95–163,200–209` |
| Custom-package OAuth maps to `apiKey` | `packages/core/src/model-resolver.ts:308–318`; runtime settings at 219–244 |
| Built-in `authToken` maps to Bearer | `packages/ai/src/providers/anthropic.ts:55–70` |
| Model/route update and transport contracts | `packages/ai/src/schema/options.ts:266–285`; `packages/ai/src/route/client.ts:42–85`; `packages/ai/src/route/transport/index.ts` |
| Host executor retains dumps, errors and status classification | `packages/ai/src/route/executor.ts:238–261` |
| Native HTTP retains cancellation and timeouts | `packages/ai/src/route/transport/http.ts:98–139` |
| Final HTTP hooks shared by primary/title/generate/summary compaction | `packages/core/src/session/model-request.ts:220–350`; `session/title.ts`; `session/generate.ts` |
| Per-execution fetch init spread into Bun fetch | `packages/core/node_modules/effect/src/unstable/http/FetchHttpClient.ts:49–73`; caller context retained in `HttpClient.ts:2065–2074` |

The Web Request hook alone cannot carry TLS settings. Its existing middleware
handler can be wrapped by a public provider route, so no new hook field is needed.

## Dependencies and local source setup

Pinned peers: `@opencode/plugin` 2.0.22, `@opencode/ai` 2.0.22, `effect`
4.0.0-rc.112. These are currently symlinked in the plugin's `node_modules` to:

```text
@opencode/plugin -> /home/jon/code/Tandem-v2/packages/plugin
@opencode/ai     -> /home/jon/code/Tandem-v2/packages/ai
effect          -> /home/jon/code/Tandem-v2/packages/core/node_modules/effect
```

This uses the host's workspace dependencies and exact Effect installation, rather
than a separately installed runtime. Legacy `@opencode-ai/plugin` remains only a
development dependency for retained v1 source; it is not imported by v2.

If reinstalling development dependencies, run in the **auth-v2 worktree only**:

```sh
/home/jon/.local/share/tandem-v2/toolchain/bun-1.4.2/bin/bun install --frozen-lockfile --ignore-scripts --omit peer
```

Then restore the three symlinks above before loading v2. Installation can replace
the root Effect dependency with the retained legacy development dependency's
version; it must resolve to the host path for v2. Bun `link:` dependencies require
a global link registration and were not retained in metadata. No global link
registry, host dependency files or daily plugin were changed. This local setup is
not a claim that the source workspace package is a published distributable.

## Exact registration and login

Merge this entry into the isolated v2 configuration, retaining any other required
plugins and registering this plugin only once:

```json
{
  "plugins": ["file:///home/jon/code/opencode-anthropic-auth-v2"]
}
```

Use the directory: root `server.ts` exports `src/v2.ts`. Current config uses
`plugins`, not legacy `plugin`; direct TypeScript plugin file URIs are filtered.
Master owns isolated server reload and any host build needed for other changes.

From `/home/jon/code/Tandem-v2`:

```sh
/home/jon/.local/share/tandem-v2/toolchain/bun-1.4.2/bin/bun script/tandem-v2.ts cli auth login anthropic --method claude-pro-max --server http://127.0.0.1:4098
```

Jon opens the supplied authorization URL and submits the complete callback URL,
`code#state`, or `code=...&state=...`. A bare code is rejected. The isolated host
persists the credential. Public connect/complete/status API details and refresh
coordination constraints remain in [V2.md](V2.md). Do not copy daily credentials.

For optional insecure custom transport, set these in the **server environment**
before reload, using the actual intended origin:

```sh
ANTHROPIC_BASE_URL=https://your-custom-host:8443
ANTHROPIC_INSECURE=1
```

## Custom-endpoint limitations

- Origin override only: existing API path/query are preserved, not replaced by a
  base-URL path prefix/query. `/v1/messages` receives `beta=true` when absent.
- Insecure mode requires a valid HTTP(S) URL without username/password. `1` and
  `true` are the recognized flags, effective only with a nonempty base URL.
- Only stock native `@opencode/ai/providers/anthropic` is wrapped. Custom,
  AI-SDK and `anthropic-compatible` packages are not substituted. Insecure OAuth
  requests for these fail explicitly instead of silently ignoring the setting.
- Requires Bun 1.4.2 and the host's Effect fetch executor. HTTPS retains encryption
  but skips certificate authentication. HTTP itself has no TLS.
- The final-origin check applies to the initial fetch; redirects internally
  followed by that fetch share its TLS option. Avoid cross-origin redirects if
  the exception must stay at one origin. Other independent requests do not inherit it.
- Environment changes require reload; this is not a runtime policy toggle.
- Anthropic currently has no native `compact.endpoint` or `compact.trigger`
  (`packages/ai/src/protocols/anthropic-messages.ts:1648–1659`). Summary compaction
  uses this transport. Future explicit native compaction would need its own
  executor wrapping; no support for it is claimed here.

## Verification performed

One source typecheck succeeded (exit 0) using pinned Bun and the host's actual
exported contracts:

```sh
/home/jon/.local/share/tandem-v2/toolchain/bun-1.4.2/bin/bun /home/jon/code/Tandem-v2/node_modules/@typescript/native-preview/bin/tsgo.js --noEmit -p tsconfig.v2.json
```

Log: `/tmp/tandem/v2/auth-v2-typecheck.log`. No tests, builds, login, refresh,
provider calls, credential copying, server restarts or commits were performed.

## Live TLS acceptance — 2026-10-04

The packaged server exposed a nominal-class adapter failure before HTTP:
`AnthropicMessages.prepare` updates an `LLMRequest`, but the model was reconstructed
by the packaged host and failed the external source package's `LanguageModel`
instance check. Fixed only `src/insecure-provider.ts`: its prepare wrapper uses
`LLMRequest.update` with `new LanguageModel(LanguageModel.input(input.request.model))`
before delegating to the original prepare. No schema bypass or host change.

After that fix, normal native Claude Read plus generate succeeded through an owned
loopback self-signed HTTPS reverse proxy. Three real `/v1/messages?beta=true`
requests returned 200 from official Anthropic with verified upstream TLS. The
verified-custom-endpoint control failed with `DEPTH_ZERO_SELF_SIGNED_CERT` before
the proxy received HTTP. Sol Read also succeeded while insecure mode was active;
non-Anthropic catalog entries were identical, and ordinary process fetches from a
public HTTP observation plugin continued rejecting the same certificate.

Full evidence, session IDs, limitations and cleanup:
`/home/jon/code/Tandem-v2/notes/v2-claude-tls-live.md`.
API-key isolation and refresh during insecure mode remain unverified. Refresh and
exchange retain their existing explicit `rejectUnauthorized: true`.

The post-fix focused typecheck did not pass: current imported host sources and
existing branded-ID uses in `src/v2.ts` report errors. No diagnostic names the
changed adapter. The earlier successful check above is historical, not the final
tree's current static-check result.

## Original acceptance checklist (see live evidence for completed subsets)

1. Register/reload only v2; confirm Claude Pro/Max plus existing key/env methods.
   Authorize through the isolated launcher above.
2. Run a real native Claude tool-using session on the normal endpoint. Confirm
   original native package, unchanged model IDs, zero subscription costs, Bearer
   presence (never its value), no `x-api-key`, merged betas and CLI user agent.
3. Inspect separate title, configured Claude generate and summary-compaction
   requests for those same properties.
4. Use the intended self-signed custom endpoint. Normal verification should reject
   its untrusted certificate; explicit insecure mode should succeed with the
   expected origin/path/query. Check primary and auxiliary requests. Confirm
   another provider and API-key transport do not inherit the exception.
5. Switch to an API key and back; inspect restored native package/prices and
   subscription wrapper/zero prices. Reload v2 and verify persisted OAuth reuse.
6. Near expiry, overlap real requests against the one isolated credential store;
   record one remote rotation and persisted replacement without logging tokens.
   Confirm token exchange/refresh continue to require valid TLS.

Source readiness does not establish live Claude acceptance. No shared-core API
blocker was found for the selected current-native-route scope.

import { buildBillingHeaderValue } from './cch.ts'
import {
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_OFFICIAL_IDENTITY,
  OPENCODE_IDENTITY_PREFIX,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  TEXT_REPLACEMENTS,
  USER_AGENT,
} from './constants.ts'

const TOOL_NAME_TO_CLAUDE_CODE: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  glob: 'Glob',
  grep: 'Grep',
  question: 'Question',
  read: 'Read',
  skill: 'Skill',
  task: 'Task',
  todowrite: 'TodoWrite',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  write: 'Write',
}

const TOOL_NAME_FROM_CLAUDE_CODE = Object.fromEntries(
  Object.entries(TOOL_NAME_TO_CLAUDE_CODE).map(([opencode, claudeCode]) => [
    claudeCode,
    opencode,
  ]),
)

const TOOL_INPUT_TO_CLAUDE_CODE: Record<string, Record<string, string>> = {
  edit: {
    filePath: 'file_path',
    oldString: 'old_string',
    newString: 'new_string',
    replaceAll: 'replace_all',
  },
  read: {
    filePath: 'file_path',
  },
  write: {
    filePath: 'file_path',
  },
}

const TOOL_INPUT_FROM_CLAUDE_CODE = Object.fromEntries(
  Object.entries(TOOL_INPUT_TO_CLAUDE_CODE).flatMap(([, keys]) =>
    Object.entries(keys).map(([opencode, claudeCode]) => [
      claudeCode,
      opencode,
    ]),
  ),
)

function capitalizeName(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

function uncapitalizeName(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

function toClaudeCodeToolName(name: string): string {
  if (name === 'StructuredOutput') return name
  return TOOL_NAME_TO_CLAUDE_CODE[name] ?? capitalizeName(name)
}

function fromClaudeCodeToolName(name: string): string {
  if (name === 'StructuredOutput') return name
  if (name.startsWith('mcp_')) return fromClaudeCodeToolName(name.slice(4))
  return TOOL_NAME_FROM_CLAUDE_CODE[name] ?? uncapitalizeName(name)
}

function renameKeys(value: unknown, keyMap: Record<string, string>): unknown {
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [keyMap[key] ?? key, item]),
  )
}

function rewriteJsonSchemaKeys(
  schema: unknown,
  keyMap: Record<string, string>,
): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item) => rewriteJsonSchemaKeys(item, keyMap))
  }
  if (!isRecord(schema)) return schema

  return Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (key === 'description') {
        return [key, rewriteDescriptionKeys(value, keyMap)]
      }

      if (key === 'properties' && isRecord(value)) {
        const properties = renameKeys(value, keyMap) as Record<string, unknown>
        return [
          key,
          Object.fromEntries(
            Object.entries(properties).map(([property, propertySchema]) => [
              property,
              rewriteJsonSchemaKeys(propertySchema, keyMap),
            ]),
          ),
        ]
      }

      if (key === 'required' && Array.isArray(value)) {
        return [
          key,
          value.map((item) =>
            typeof item === 'string' ? (keyMap[item] ?? item) : item,
          ),
        ]
      }

      return [key, rewriteJsonSchemaKeys(value, keyMap)]
    }),
  )
}

function rewriteDescriptionKeys(
  description: unknown,
  keyMap: Record<string, string>,
): unknown {
  if (typeof description !== 'string') return description
  return Object.entries(keyMap).reduce(
    (result, [from, to]) => result.split(from).join(to),
    description,
  )
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
): Headers {
  headers.set('authorization', `Bearer ${accessToken}`)
  headers.set('anthropic-beta', mergeBetaHeaders(headers))
  headers.set('user-agent', USER_AGENT)
  headers.delete('x-api-key')
  return headers
}

/**
 * Rewrite OpenCode tool definitions and historical tool_use blocks to the
 * Claude Code-facing shape Anthropic sees from the official CLI.
 */
export function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => {
        const { eager_input_streaming: _eager, ...rest } = tool
        const opencodeName = tool.name
          ? fromClaudeCodeToolName(tool.name)
          : undefined
        const keyMap = opencodeName
          ? TOOL_INPUT_TO_CLAUDE_CODE[opencodeName]
          : undefined
        const rewritten = {
          ...rest,
          ...(tool.name
            ? { name: toClaudeCodeToolName(opencodeName ?? tool.name) }
            : {}),
          ...(keyMap
            ? {
                description: rewriteDescriptionKeys(tool.description, keyMap),
                input_schema: rewriteJsonSchemaKeys(tool.input_schema, keyMap),
              }
            : {}),
        }
        return rewritten
      },
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string
          name?: string
          [k: string]: unknown
        }>
        [k: string]: unknown
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              const opencodeName = fromClaudeCodeToolName(block.name)
              const keyMap = TOOL_INPUT_TO_CLAUDE_CODE[opencodeName]
              return {
                ...block,
                name: toClaudeCodeToolName(opencodeName),
                ...(keyMap ? { input: renameKeys(block.input, keyMap) } : {}),
              }
            }
            return block
          })
        }
        return msg
      },
    )
  }

  return JSON.stringify(parsed)
}

/**
 * Convert Claude Code-facing streamed tool calls back to OpenCode names and
 * input keys before the AI SDK parses them.
 */
export function stripToolPrefix(text: string): string {
  let result = text.replace(
    /"name"\s*:\s*"([^"]+)"/g,
    (_match, name: string) => `"name": "${fromClaudeCodeToolName(name)}"`,
  )

  for (const [from, to] of Object.entries(TOOL_INPUT_FROM_CLAUDE_CODE)) {
    result = result
      .split(`"${from}"`)
      .join(`"${to}"`)
      .split(`\\"${from}\\"`)
      .join(`\\"${to}\\"`)
  }

  return result
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function resolveBaseUrl(): URL | null {
  const raw = process.env.ANTHROPIC_BASE_URL?.trim()
  if (!raw) return null
  try {
    const baseUrl = new URL(raw)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(input: FetchInput): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
  }

  if (
    requestUrl.pathname === '/v1/messages' &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
export function sanitizeSystemText(text: string): string {
  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      // If the paragraph contains the identity, drop it entirely
      return false
    }

    // Remove paragraphs containing any removal anchor
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  // Apply inline text replacements
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasOfficialClaudeCodeIdentity(blocks: SystemBlock[]): boolean {
  return blocks.some((block) =>
    block.text.trimStart().startsWith(CLAUDE_CODE_OFFICIAL_IDENTITY),
  )
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    if (sanitized.startsWith(CLAUDE_CODE_OFFICIAL_IDENTITY)) {
      return [{ type: 'text', text: sanitized }]
    }
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    const sanitized = { ...system, type, text: sanitizeSystemText(text) }
    if (hasOfficialClaudeCodeIdentity([sanitized])) return [sanitized]
    return [identityBlock, sanitized]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item) }
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return {
        ...item,
        type: 'text',
        text: sanitizeSystemText(item.text),
      }
    }

    return { type: 'text', text: String(item) }
  })

  // Idempotency: don't double-prepend if first block already has the identity
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  if (hasOfficialClaudeCodeIdentity(sanitized)) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 */
export function rewriteRequestBody(body: string): string {
  try {
    const parsed = JSON.parse(body)
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some(
        (message: { role?: string }) => message.role === 'user',
      )
        ? buildBillingHeaderValue(
            parsed.messages,
            undefined,
            CLAUDE_CODE_ENTRYPOINT,
          )
        : null

    // Sanitize system prompt and prepend Claude Code identity
    parsed.system = prependClaudeCodeIdentity(parsed.system)

    // Prepend the billing marker as a separate system block. When the prompt
    // already carries the official Claude Code identity, don't also add the
    // older Agent SDK identity block.
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    }

    return prefixToolNames(parsed)
  } catch {
    return body
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(response: Response): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffered = ''

  const stream = new ReadableStream({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          const remaining = buffered + decoder.decode()
          if (remaining)
            controller.enqueue(encoder.encode(stripToolPrefix(remaining)))
          controller.close()
          return
        }

        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split('\n')
        buffered = lines.pop() ?? ''
        if (lines.length > 0) {
          controller.enqueue(
            encoder.encode(`${lines.map(stripToolPrefix).join('\n')}\n`),
          )
        }
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

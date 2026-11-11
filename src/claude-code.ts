import { createHash } from 'node:crypto'
import { CLAUDE_CODE_BETA, CLAUDE_CODE_VERSION } from './constants.ts'

const BILLING = 'x-anthropic-billing-header: '
// Claude Code's runtime signs `cch=00000` natively: xxHash64 over the body
// without `max_tokens` and with blank models.
const CCH_SEED = 0x4d659218e32a3268n
const SESSION_HEADERS = [
  'x-session-affinity',
  'x-session-id',
  'x-parent-session-id',
]

type JsonObject = Record<string, unknown>

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export type ClaudeCodeRequest = {
  readonly sessionID: string
  readonly kind: string
  /** The session has a parent session. */
  readonly subagent: boolean
  /** The session's last primary request ID. */
  readonly previous?: string
}

/**
 * Remove OpenCode's attribution headers. Main requests also get Claude Code's
 * beta first.
 */
export function setClaudeCodeHeaders(headers: Headers, main: boolean): Headers {
  for (const name of [...headers.keys()])
    if (name.startsWith('x-opencode-') || SESSION_HEADERS.includes(name))
      headers.delete(name)
  if (main) {
    const betas = (headers.get('anthropic-beta') ?? '')
      .split(',')
      .map((beta) => beta.trim())
      .filter((beta) => beta && beta !== CLAUDE_CODE_BETA)
    headers.set('anthropic-beta', [CLAUDE_CODE_BETA, ...betas].join(','))
  }
  return headers
}

/**
 * Claude Code's billing line before the per-request fields; the version suffix
 * samples the first prompt the user typed.
 */
export function billingLine(prompt: string): string {
  const chars = [4, 7, 20].map((index) => prompt[index] || '0').join('')
  const suffix = createHash('sha256')
    .update(`59cf53e54c78${chars}${CLAUDE_CODE_VERSION}`)
    .digest('hex')
    .slice(0, 3)
  return `${BILLING}cc_version=${CLAUDE_CODE_VERSION}.${suffix}; cc_entrypoint=cli;`
}

/** A user message's own text, skipping OpenCode's leading reminders. */
const ownText = (message: JsonObject): string | undefined => {
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return undefined
  const block = message.content.find(
    (block) =>
      isObject(block) &&
      block.type === 'text' &&
      typeof block.text === 'string' &&
      !block.text.startsWith('<system-reminder>'),
  )
  return isObject(block) ? String(block.text) : undefined
}

/** Human prompts: user messages with their own text, not tool results. */
const prompts = (messages: unknown[]): string[] =>
  messages.flatMap((message) => {
    if (!isObject(message) || message.role !== 'user') return []
    if (
      Array.isArray(message.content) &&
      message.content.some(
        (block) => isObject(block) && block.type === 'tool_result',
      )
    )
      return []
    const text = ownText(message)
    return text === undefined ? [] : [text]
  })

/**
 * Claude Code's tool_result key order: errors lead with type, Bash results
 * with tool_use_id, and Bash always sends is_error.
 */
function orderToolResults(messages: unknown[]): void {
  const bash = new Set<unknown>()
  for (const message of messages)
    if (isObject(message) && Array.isArray(message.content))
      for (const block of message.content)
        if (
          isObject(block) &&
          block.type === 'tool_use' &&
          block.name === 'Bash'
        )
          bash.add(block.id)
  for (const message of messages) {
    if (!isObject(message) || !Array.isArray(message.content)) continue
    message.content = message.content.map((block: unknown) => {
      if (!isObject(block) || block.type !== 'tool_result') return block
      const { type, tool_use_id, content, is_error, ...rest } = block
      if (is_error === true)
        return { type, content, is_error, tool_use_id, ...rest }
      if (bash.has(tool_use_id))
        return { tool_use_id, type, content, is_error: false, ...rest }
      return block
    })
  }
}

/** Puts the billing block first in `system`, which follows `model`. */
function withBilling(body: JsonObject, text: string): JsonObject {
  const block = { type: 'text', text }
  if (Array.isArray(body.system))
    return { ...body, system: [block, ...body.system] }
  const { model, system, ...rest } = body
  const head =
    typeof system === 'string' ? [{ type: 'text', text: system }] : []
  return { model, system: [block, ...head], ...rest }
}

/**
 * Presents a Messages request body as Claude Code's with a Claude
 * subscription: tool_result key order, the signed billing line and, as in
 * Claude Code, the subagent, previous-request and prompt fields. Main requests
 * carry tools; titles and tool-less requests are like Claude Code's
 * small-model requests.
 */
export function claudeCodeBody(
  body: string,
  input: ClaudeCodeRequest,
): { body: string; main: boolean } {
  const parsed = (() => {
    try {
      return JSON.parse(body) as unknown
    } catch {
      return undefined
    }
  })()
  if (!isObject(parsed) || !Array.isArray(parsed.messages))
    return { body, main: false }
  // Helper sessions, such as a prompt corrector, are child sessions without
  // tools; they are not marked as subagents.
  const agentic = Array.isArray(parsed.tools) && parsed.tools.length > 0
  const main = input.kind !== 'title' && agentic
  const subagent = input.subagent && agentic
  const first = Array.isArray(parsed.system) ? parsed.system[0] : undefined
  if (
    isObject(first) &&
    typeof first.text === 'string' &&
    first.text.startsWith(BILLING)
  )
    return { body, main }
  orderToolResults(parsed.messages)
  const user = parsed.messages.find(
    (message) => isObject(message) && message.role === 'user',
  )
  const asked = prompts(parsed.messages)
  const index = asked.length
  const id = createHash('sha256')
    .update(`${input.sessionID}\n${index}\n${asked.at(-1) ?? ''}`)
    .digest('hex')
  const uuid = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-${'89ab'[Number.parseInt(id[16], 16) % 4]}${id.slice(17, 20)}-${id.slice(20, 32)}`
  const line = [
    billingLine((isObject(user) && ownText(user)) || ''),
    ' cch=00000;',
    subagent ? ' cc_is_subagent=true;' : '',
    main && input.previous ? ` cc_prev_req=${input.previous};` : '',
    main && input.kind === 'primary' && !subagent && index > 0
      ? ` cc_prompt_id=${uuid}; cc_turn_origin=human; cc_prompt_index=${index}; cc_turn_index=${index};`
      : '',
  ].join('')
  const { max_tokens: _, ...normalized } = withBilling(parsed, line)
  if ('model' in normalized) normalized.model = ''
  if (Array.isArray(normalized.tools))
    normalized.tools = normalized.tools.map((tool) =>
      isObject(tool) && 'model' in tool ? { ...tool, model: '' } : tool,
    )
  const cch = (
    Bun.hash.xxHash64(JSON.stringify(normalized), CCH_SEED) & 0xfffffn
  )
    .toString(16)
    .padStart(5, '0')
  return {
    body: JSON.stringify(
      withBilling(parsed, line.replace(' cch=00000;', ` cch=${cch};`)),
    ),
    main,
  }
}

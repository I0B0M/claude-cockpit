// Pure logic: no `$`, no drawing. Everything here is tested on its own.
import type { Outcome, OutcomeKind, Step, StepStatus } from '../types'

// ── colours ─────────────────────────────────────────────────────────────────
export const GREEN = '#30d158'
export const YELLOW = '#ffd60a'
export const ORANGE = '#ff9f0a'
export const RED = '#ff453a'
export const BLUE = '#0a84ff'
export const GREY = '#8e8e93'
export const TRACK = '#8e8e9340'

/** session-hud's thresholds: under 50 green, then yellow, orange from 75, red from 90. */
export const heat = (pct: number): string => (pct < 50 ? GREEN : pct < 75 ? YELLOW : pct < 90 ? ORANGE : RED)

export const human = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

export const countdown = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`
}

export const elapsed = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const clockOf = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`
}

export const weekdayOf = (iso?: string): string => (iso ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short' }) : '')

/** A ring as SVG source: thin on the slim pill (14 px), thick on the resting card (24 px and up). */
export const ring = (pct: number, color: string, size = 14): string => {
  const sw = size >= 24 ? 4.5 : 2
  const r = size / 2 - sw / 2 - 0.5
  const c = 2 * Math.PI * r
  const p = Math.max(0, Math.min(100, pct))
  const off = c * (1 - p / 100)
  const h = size / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
    `<circle cx="${h}" cy="${h}" r="${r.toFixed(2)}" fill="none" stroke="${TRACK}" stroke-width="${sw}"/>` +
    (p > 0 ? `<circle cx="${h}" cy="${h}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 ${h} ${h})"/>` : '') +
    `</svg>`
}

/** The step colour bar: one block per step, green done, yellow now, grey next. */
export const segments = (states: readonly StepStatus[], width: number, height = 5): string => {
  const n = Math.max(1, states.length)
  const gap = n > 1 ? Math.min(3, width / n / 4) : 0
  const w = (width - gap * (n - 1)) / n
  const fill = (s: StepStatus) => (s === 'completed' ? GREEN : s === 'in_progress' ? YELLOW : TRACK)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    states.map((s, i) => `<rect x="${(i * (w + gap)).toFixed(2)}" width="${w.toFixed(2)}" height="${height}" rx="${height / 2}" fill="${fill(s)}"/>`).join('') +
    `</svg>`
}

/** A thin bar for the details rows, as SVG source. */
export const bar = (pct: number, color: string, width = 160): string => {
  const w = Math.max(0, Math.min(100, pct))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4" width="${width}" height="4" preserveAspectRatio="none"><rect width="100" height="4" rx="2" fill="${TRACK}"/>${w > 0 ? `<rect width="${w.toFixed(1)}" height="4" rx="2" fill="${color}"/>` : ''}</svg>`
}

// ── the task list ───────────────────────────────────────────────────────────
type PlanItem = { content?: unknown; status?: unknown }
const asStatus = (s: unknown): StepStatus => (s === 'completed' || s === 'in_progress' ? s : 'pending')

/**
 * The desktop app's plan tool: `{ items }` replaces the list, `{ advance }` completes the step in
 * progress and starts the next, `{ done: [n], start: n }` moves steps by their 1-based place.
 */
export function applyPlan(list: Step[], input: Record<string, unknown>): Step[] {
  if (Array.isArray(input.items)) {
    return (input.items as PlanItem[]).map((it, i) => ({ id: String(i + 1), subject: String(it.content ?? ''), status: asStatus(it.status) }))
  }
  let next = list.map(s => ({ ...s }))
  if (input.advance === true) {
    const cur = next.findIndex(s => s.status === 'in_progress')
    if (cur >= 0) next[cur]!.status = 'completed'
    const after = next.findIndex((s, i) => i > cur && s.status === 'pending')
    if (after >= 0) next[after]!.status = 'in_progress'
  }
  if (Array.isArray(input.done)) {
    for (const n of input.done) if (typeof n === 'number' && next[n - 1]) next[n - 1]!.status = 'completed'
  }
  if (typeof input.start === 'number' && next[input.start - 1]) {
    next = next.map(s => (s.status === 'in_progress' ? { ...s, status: 'pending' as const } : s))
    next[input.start - 1]!.status = 'in_progress'
  }
  return next
}

/** The terminal's TaskUpdate. */
export function applyTaskUpdate(list: Step[], input: Record<string, unknown>): Step[] {
  return list
    .map(s => (s.id !== String(input.taskId) ? s : {
      ...s,
      status: typeof input.status === 'string' ? asStatus(input.status) : s.status,
      subject: typeof input.subject === 'string' ? input.subject : s.subject,
    }))
    .filter(s => (input.status === 'deleted' ? s.id !== String(input.taskId) : true))
}

export type PlanLine = { index: number; total: number; label: string; done: number; isDone: boolean }

export function planLine(list: Step[]): PlanLine | null {
  if (list.length === 0) return null
  const done = list.filter(s => s.status === 'completed').length
  const cur = list.findIndex(s => s.status === 'in_progress')
  const nextUp = list.find(s => s.status !== 'completed')
  return {
    index: cur >= 0 ? cur + 1 : done,
    total: list.length,
    label: cur >= 0 ? list[cur]!.subject : nextUp?.subject ?? list[list.length - 1]!.subject,
    done,
    isDone: done === list.length,
  }
}

export type StepTrack = { done: string; now: string; next: string; more: number; index: number; total: number; states: StepStatus[] }

/** The resting card's left side: the last finished step, the one now, the first one next and how many follow it. */
export function stepTrack(list: Step[]): StepTrack | null {
  if (list.length === 0) return null
  const cur = list.findIndex(s => s.status === 'in_progress')
  const nowAt = cur >= 0 ? cur : list.findIndex(s => s.status === 'pending')
  const done = [...list.slice(0, nowAt >= 0 ? nowAt : list.length)].reverse().find(s => s.status === 'completed')
  const after = list.filter((s, i) => i > nowAt && s.status === 'pending')
  return {
    done: done?.subject ?? '',
    now: nowAt >= 0 ? list[nowAt]!.subject : '',
    next: nowAt >= 0 ? after[0]?.subject ?? '' : '',
    more: nowAt >= 0 ? Math.max(0, after.length - 1) : 0,
    index: nowAt >= 0 ? nowAt + 1 : list.length,
    total: list.length,
    states: list.map(s => s.status),
  }
}

// ── cost (price table from savvy-progress, MIT, JohnnyVizz/claude-kit) ───────
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]
const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]
export type TokenUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }

/** An estimate from token counts at list prices, never a bill. */
export function costOf(model: string, u: TokenUsage): number {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? [4, 20, 0.2, 8]
  return ((u.input_tokens ?? 0) * i + (u.output_tokens ?? 0) * o + (u.cache_read_input_tokens ?? 0) * r + (u.cache_creation_input_tokens ?? 0) * w) / 1e6
}

/** "claude-opus-5-5" → "Opus", for a tag. */
export const modelTag = (model: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)/i.exec(model)
  return m ? m[1]![0]!.toUpperCase() + m[1]!.slice(1).toLowerCase() : model
}

// ── words ───────────────────────────────────────────────────────────────────
export const firstLine = (text: string, max = 90): string => {
  const line = (text ?? '').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(l => l !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const base = (p: string): string => p.replace(/\/+$/, '').split('/').pop() ?? p
const dirOf = (p: string): string => p.replace(/\/+$/, '').split('/').slice(-3, -1).filter(Boolean).join('/')

/** What a subagent's call says about what it is doing, in a few words. */
export function activityOf(tool: string, input: Record<string, unknown>): string | undefined {
  const path = typeof input.file_path === 'string' ? input.file_path : undefined
  if (tool === 'Write' && path) return `writing ${base(path)}`
  if ((tool === 'Edit' || tool === 'MultiEdit') && path) return `editing ${base(path)}`
  if (tool === 'Read' && path) return `reading ${base(path)}`
  if (tool === 'Bash' && typeof input.description === 'string') return input.description.charAt(0).toLowerCase() + input.description.slice(1)
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'searching the web'
  if (tool === 'Grep' || tool === 'Glob') return 'searching files'
  return undefined
}

/** A message that asks what came out of the work. */
export const asksForOutcomes = (text: string): boolean =>
  /\b(what happened|what did you (do|change|make)|show (me )?(the )?(results|outcomes)|outcomes?\b|results\b|what got done|what changed)\b/i.test(text)

// ── test and check output ───────────────────────────────────────────────────

export type CheckCount = { passed: number | null; failed: number | null; errors: number | null }

export function parseCheck(text: string): CheckCount | null {
  const num = (re: RegExp) => {
    let total: number | null = null
    for (const m of text.matchAll(re)) total = (total ?? 0) + Number(m[1])
    return total
  }
  const passed = num(/(\d+)\s+(?:tests?\s+)?pass(?:ed|es|ing)?\b/gi)
  const failed = num(/(\d+)\s+(?:tests?\s+)?fail(?:ed|s|ing|ures?)?\b/gi)
  const errors = num(/Found\s+(\d+)\s+errors?/gi) ?? num(/(\d+)\s+problems?\b/gi)
  if (passed === null && failed === null && errors === null) return null
  return { passed, failed, errors }
}

const WORD = (w: string) => new RegExp(`(^|[^a-z0-9])(${w})([^a-z0-9]|$)`, 'i')
const LINT = WORD('lint|eslint|ruff|flake8|biome|prettier')
const TYPES = WORD('tsc|typecheck|type-check|mypy|pyright')
const VALIDATE = WORD('validate')
const TESTS = WORD('test|tests|pytest|jest|vitest|mocha|unittest')

function checkName(command: string): string {
  if (LINT.test(command)) return 'Lint'
  if (TYPES.test(command)) return 'Type check'
  if (VALIDATE.test(command)) return 'Validation'
  if (TESTS.test(command)) return 'Tests'
  return 'Check'
}

const RUNNER = /^(pytest|jest|vitest|mocha|eslint|ruff|flake8|tsc|mypy|pyright|biome|prettier)$/
const CHECK_SCRIPT = WORD('test|tests|lint|check|checks|validate|typecheck')
/**
 * The part of a shell line that runs a check, or undefined. Only the command each part runs counts: a test file named
 * as an argument (`sed -n 1,60p band.test.tsx`, `cat tests/x.py`, `grep lint`) is reading, not checking.
 */
export function checkPart(command: string): string | undefined {
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().split(/\s+/).filter(w => w !== '' && !/^[A-Z_][A-Z0-9_]*=/.test(w))
    while (/^(npx|bunx|uvx|time|nice)$/.test(words[0] ?? '') || (words[0] === 'pnpm' && words[1] === 'exec') || (/^(uv|poetry)$/.test(words[0] ?? '') && words[1] === 'run')) words.splice(0, words[0] === 'pnpm' || words[0] === 'uv' || words[0] === 'poetry' ? 2 : 1)
    const [first = '', second = '', third = ''] = words
    const base = (w: string) => w.split('/').pop() ?? w
    const hit =
      RUNNER.test(base(first)) ||
      (/^(npm|pnpm|yarn|bun)$/.test(first) && (second === 'test' || (second === 'run' && CHECK_SCRIPT.test(third)) || (first === 'yarn' && CHECK_SCRIPT.test(second)))) ||
      (/^python3?$/.test(first) && ((second === '-m' && /^(pytest|unittest|mypy|ruff)$/.test(third)) || (/\.py$/.test(second) && CHECK_SCRIPT.test(base(second))))) ||
      (/^(node|bash|sh|zsh|deno)$/.test(first) && CHECK_SCRIPT.test(base(second)) && /\.(m?js|ts|sh)$/.test(second)) ||
      (first === 'claude' && second === 'plugin' && /^(test|validate)$/.test(third)) ||
      (first === 'go' && second === 'test') ||
      (first === 'cargo' && /^(test|clippy|check)$/.test(second)) ||
      (first === 'make' && CHECK_SCRIPT.test(second)) ||
      (/\//.test(first) && /\.(sh|py|m?js)$/.test(first) && CHECK_SCRIPT.test(base(first)))
    if (hit) return part.trim()
  }
  return undefined
}

// ── what counts as a result ─────────────────────────────────────────────────
export const DELIVERABLE = /\.(png|jpe?g|gif|webp|svg|mp4|mov|webm|mp3|wav|m4a|pdf|docx?|pptx?|xlsx?|csv|html?|md|epub|zip)$/i
export const PREVIEWABLE = /\.(png|jpe?g|gif|webp)$/i

export type Call = { tool: string; input: Record<string, unknown>; text: string; isError: boolean }
export type Found = Omit<Outcome, 'id' | 'at' | 'task'>

const TICKET_TOOL = /^mcp__.*(linear|jira|github|gitlab|notion|asana|clickup|trello|monday|shortcut|height).*__(create|update|save|add|comment|close|transition|move|assign)/i
const SENT_TOOL = /^mcp__.*__(send|post|reply|create)_?(message|email|draft|comment|post|reply)/i
const PAST: Record<string, string> = { create: 'Opened', close: 'Closed', comment: 'Commented on', edit: 'Updated', reopen: 'Reopened' }

/** Reads one finished call for a result a person would care about. Code edits are not results. */
export function classify(call: Call): Found | null {
  const { tool, input, text, isError } = call
  const ok = !isError

  if (tool === 'Write' && typeof input.file_path === 'string' && DELIVERABLE.test(input.file_path)) {
    return { kind: 'made', title: base(input.file_path), detail: dirOf(input.file_path), path: input.file_path, ok }
  }

  if (tool === 'Artifact' && (input.action === undefined || input.action === 'publish') && input.asset !== true) {
    const url = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.exec(text)?.[0]
    if (!url) return null
    const name = typeof input.title === 'string' ? input.title : typeof input.file_path === 'string' ? base(input.file_path).replace(/\.\w+$/, '') : 'page'
    const desc = typeof input.description === 'string' ? input.description : undefined
    return { kind: 'published', title: `Published ${name}`, ...(desc ? { detail: firstLine(desc, 80) } : {}), href: url, ok }
  }

  if (tool === 'SendUserFile' && Array.isArray(input.files)) {
    const files = input.files.map(String)
    return { kind: 'made', title: `Sent you ${files.map(base).join(', ')}`, path: files[0], ok }
  }

  if (/start_session$/.test(tool) && typeof input.title === 'string') {
    return { kind: 'session', title: `Started session "${input.title}"`, ok }
  }

  if (TICKET_TOOL.test(tool)) {
    const id = [input.identifier, input.issueId, input.issue_id, input.id, input.key].find(v => typeof v === 'string' && /^[A-Z][A-Z0-9]+-\d+$/.test(v as string))
    const what = /comment/i.test(tool) ? 'Commented on' : /create/i.test(tool) ? 'Opened' : 'Updated'
    const url = /https?:\/\/\S+/.exec(text)?.[0]
    return { kind: 'ticket', title: `${what} ${id ?? 'a ticket'}`, ...(typeof input.title === 'string' ? { detail: firstLine(input.title, 80) } : {}), ...(url ? { href: url } : {}), ok }
  }

  if (SENT_TOOL.test(tool)) {
    return { kind: 'sent', title: 'Sent a message', ...(typeof input.to === 'string' ? { detail: `to ${input.to}` } : {}), ok }
  }

  if (tool !== 'Bash') return null
  const cmd = String(input.command ?? '')
  const desc = typeof input.description === 'string' ? input.description : undefined

  if (/\bgh\s+pr\s+create\b/.test(cmd)) {
    const url = /https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/.exec(text)
    return ok && url ? { kind: 'pr', title: `Opened PR #${url[1]}`, detail: repoOf(url[0]), href: url[0], ok } : { kind: 'pr', title: 'Opening a PR failed', detail: firstLine(text, 80), ok: false }
  }
  if (/\bgh\s+pr\s+merge\b/.test(cmd)) {
    const n = /\bmerge\s+#?(\d+)/.exec(cmd)?.[1] ?? /#(\d+)/.exec(text)?.[1]
    return { kind: 'pr', title: ok ? `Merged PR${n ? ` #${n}` : ''}` : `Merging PR${n ? ` #${n}` : ''} failed`, ...(ok ? {} : { detail: firstLine(text, 80) }), ok }
  }
  const issue = /\bgh\s+issue\s+(create|close|comment|edit|reopen)\b(?:\s+#?(\d+))?/.exec(cmd)
  if (issue) {
    const url = /https:\/\/github\.com\/[^\s]+\/issues\/(\d+)/.exec(text)
    const n = issue[2] ?? url?.[1]
    return { kind: 'ticket', title: `${PAST[issue[1]!]} ticket${n ? ` #${n}` : ''}`, ...(url ? { href: url[0], detail: repoOf(url[0]) } : {}), ok }
  }
  const script = /\btools\/ticket\.py\s+(\w[\w-]*)\s+#?(\d+)/.exec(cmd)
  if (script) return { kind: 'ticket', title: `Ticket #${script[2]}: ${script[1]}`, ok }

  if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd)) {
    if (!ok) return /nothing to commit/.test(text) ? null : { kind: 'commit', title: 'Commit failed', detail: firstLine(text, 80), ok }
    const m = /\[([^\s\]]+)(?:\s+\(root-commit\))?\s+[0-9a-f]{7,}\]\s+(.+)/.exec(text)
    return m ? { kind: 'commit', title: `Committed "${firstLine(m[2]!, 70)}"`, detail: `on ${m[1]}`, ok } : null
  }
  if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) {
    const m = /\s(\S+)\s+->\s+(\S+)/.exec(text)
    if (!ok) return { kind: 'push', title: 'Push failed', detail: firstLine(text, 80), ok }
    return /Everything up-to-date/.test(text) ? null : { kind: 'push', title: `Pushed ${m?.[2] ?? 'the branch'}`, ...(m ? { detail: repoOf(text) || undefined } : {}), ok }
  }

  const check = checkPart(cmd)
  if (check !== undefined) {
    const name = checkName(check)
    const n = parseCheck(text)
    const failed = (n?.failed ?? 0) > 0 || (n?.errors ?? 0) > 0 || isError
    const counts = n ? [n.failed ? `${n.failed} failed` : '', n.errors ? `${n.errors} errors` : '', n.passed !== null ? `${n.passed} passed` : ''].filter(Boolean).join(', ') : ''
    return { kind: 'check', title: `${name} ${failed ? 'failed' : 'passed'}${counts ? `: ${counts}` : ''}`, ...(desc ? { detail: desc } : {}), ok: !failed }
  }
  return null
}

const repoOf = (s: string): string => /github\.com[/:]([^/\s]+\/[^/\s.]+)/.exec(s)?.[1] ?? ''

/** Groups many files from one folder into one result ("120 files in frames/"). */
export function groupMade(paths: string[]): { title: string; detail: string; path: string; count: number }[] {
  const byDir = new Map<string, string[]>()
  for (const p of paths) {
    const d = p.replace(/\/[^/]*$/, '')
    byDir.set(d, [...(byDir.get(d) ?? []), p])
  }
  const out: { title: string; detail: string; path: string; count: number }[] = []
  for (const [d, list] of byDir) {
    if (list.length > 4) {
      const ext = /\.(\w+)$/.exec(list[0]!)?.[1] ?? 'file'
      out.push({ title: `${list.length} ${ext} files`, detail: dirOf(`${d}/x`), path: d, count: list.length })
    } else for (const p of list) out.push({ title: base(p), detail: dirOf(p), path: p, count: 1 })
  }
  return out
}

/** Which group a result is shown under. */
export const groupOf = (k: OutcomeKind): 'made' | 'shipped' | 'checked' =>
  k === 'made' || k === 'published' ? 'made' : k === 'check' ? 'checked' : 'shipped'

// ── battery and Modal ───────────────────────────────────────────────────────
export function parsePmset(out: string): { percent: number; onBattery: boolean } | null {
  const m = /(\d+)%;\s*(\w+)/.exec(out)
  if (!m) return null
  return { percent: Number(m[1]), onBattery: /Battery Power/.test(out) || m[2] === 'discharging' }
}

/**
 * docs/modal-spend.csv: date,what,video,jobs,worst_usd,…; newer rows carry the Modal profile as an
 * extra last column. Sums this month's worst-case cost per named account (rows with no account are left out).
 */
export function parseModalCsv(csv: string, month: string, names: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of csv.split('\n').slice(1)) {
    const cols = line.split(',')
    if (!cols[0]?.startsWith(month) || cols.length < 10) continue
    const profile = cols[cols.length - 1]!.trim()
    const name = names[profile]
    const usd = Number(cols[4])
    if (!name || !Number.isFinite(usd)) continue
    out[name] = (out[name] ?? 0) + usd
  }
  return out
}

/** The Modal chip shows only while a Modal job is running; spend alone never shows it. */
export const shownModal = (spend: Record<string, number>, running: number): [string, number][] =>
  running > 0 ? Object.entries(spend).filter(([, v]) => v > 0) : []

export const parseNames = (list: readonly string[]): Record<string, string> =>
  Object.fromEntries(list.map(s => s.split('=')).filter(p => p.length === 2).map(([k, v]) => [k!.trim(), v!.trim()]))

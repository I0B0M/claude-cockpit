import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Cache, Limit, Step, Usage } from '../types'

// Desktop-only band: the terminal has its own status line.
const steps = atom({ plugin: 'session-hud', key: 'steps' } as const, [])
const usage = atom({ plugin: 'session-hud', key: 'usage' } as const, null)
const cache = atom({ plugin: 'session-hud', key: 'cache' } as const, null)
const tick = atom({ plugin: 'session-hud', key: 'tick' } as const, 0)

// How long the prompt cache lives: 60 minutes on the 1-hour tier, 5 on the default; set by the cacheMinutes option.
let CACHE_TTL_MS = 60 * 60 * 1000
const WARN_MS = 10 * 60 * 1000
const NEW_CHAT_AT = 100_000

const GREEN = '#5fbf6a'
const YELLOW = '#e0b030'
const ORANGE = '#f08a24'
const RED = '#e5534b'
const CYAN = '#3fb6c6'
const BLUE = '#4a90e2'
const PURPLE = '#b277d6'
const GREY = '#8a8a8a'
const TRACK = '#8a8a8a40' // the empty part of a bar

// Line icons on a 16-unit grid, in the map's style (no emoji).
export const ICONS = {
  clock: 'M8 2a6 6 0 1 0 0 12A6 6 0 1 0 8 2zM8 5v3.2l2.2 1.5',
  calendar: 'M3.5 3.5h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM2.5 7h11M5.5 2v3M10.5 2v3',
  layers: 'M8 2.5l5.5 3-5.5 3-5.5-3zM2.5 8.5l5.5 3 5.5-3M2.5 11.2l5.5 3 5.5-3',
  bolt: 'M9 1.5L3.5 9h4l-1 5.5L12.5 7h-4z',
} as const
export type IconName = keyof typeof ICONS

const heat = (pct: number) => (pct < 50 ? GREEN : pct < 75 ? YELLOW : pct < 90 ? ORANGE : RED)

const human = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`

const countdown = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
    : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`
}

const weekday = (iso: string) => new Date(iso).toLocaleDateString('en-US', { weekday: 'short' })

const clock = (iso?: string) => {
  if (!iso) return ''
  const d = new Date(iso)
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`
}

// TaskCreate's record carries { task: { id } }; its text says "Task #N created".
const createdId = (result: unknown, text?: string): string | null => {
  const id = (result as { task?: { id?: unknown } } | undefined)?.task?.id
  if (id !== undefined && id !== null) return String(id)
  const m = /Task #(\d+)/.exec(text ?? '')
  return m ? m[1] : null
}

const applyUpdate = (list: Step[], input: Record<string, unknown>): Step[] =>
  list
    .map(s => s.id !== String(input.taskId) ? s : {
      ...s,
      status: typeof input.status === 'string' ? input.status : s.status,
      activeForm: typeof input.activeForm === 'string' ? input.activeForm : s.activeForm,
      subject: typeof input.subject === 'string' ? input.subject : s.subject,
    })
    .filter(s => s.status !== 'deleted')

const toUsage = (context: { percent?: number; tokens?: number }, limits: Limit[]): Usage => ({
  contextPercent: context.percent ?? null,
  contextTokens: context.tokens ?? null,
  limits: limits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
})

export const register: Register = (on, options) => {
  CACHE_TTL_MS = String(options?.cacheMinutes ?? '60') === '5' ? 5 * 60 * 1000 : 60 * 60 * 1000

  on('session.start', async ($, e, next) => {
    // Rebuild the step list from the conversation so far (also after a reload).
    let list: Step[] = []
    for (const m of await $.session.messages()) {
      for (const u of m.toolUses ?? []) {
        if (u.tool === 'TaskCreate') {
          const id = createdId(u.result, u.text)
          if (id) list.push({
            id,
            subject: String(u.input.subject ?? ''),
            activeForm: String(u.input.activeForm ?? ''),
            status: 'pending',
          })
        } else if (u.tool === 'TaskUpdate') {
          list = applyUpdate(list, u.input)
        }
      }
    }
    await update($, steps, () => list)

    const now = await $.session.usage()
    await update($, usage, () => toUsage(now.context, now.rateLimits))

    // Redraw the cache countdown.
    $.clock.every(15_000, () => { void update($, tick, n => n + 1) })

    return next(e)
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const res = await next(e)
    const id = 'result' in res ? createdId(res.result, res.text) : null
    if (id && !e.agentId) {
      const input = e as unknown as Record<string, unknown>
      await update($, steps, list => [...list.filter(s => s.id !== id), {
        id,
        subject: String(input.subject ?? ''),
        activeForm: String(input.activeForm ?? ''),
        status: 'pending',
      }])
    }
    return res
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const res = await next(e)
    if (!e.agentId && !('deny' in res && res.deny)) {
      await update($, steps, list => applyUpdate(list, e as unknown as Record<string, unknown>))
    }
    return res
  })

  // Every response that moves the context also resets the cache's lifetime.
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))
    if (e.changed.includes('context')) {
      const at = await $.clock.now()
      await update($, cache, (c): Cache => ({
        lastReplyAt: at, hit: c?.hit ?? null, size: e.context.tokens ?? c?.size ?? null,
      }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u && !e.agentId) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      const at = await $.clock.now()
      await update($, cache, (c): Cache => ({
        lastReplyAt: at,
        hit: total ? u.cache_read_input_tokens / total : null,
        size: c?.size ?? total,
      }))
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)

    await read($, tick)
    const list = await read($, steps)
    const use = await read($, usage)
    const c = await read($, cache)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const sep = <Text color={GREY}>  │  </Text>
    const rows = []

    // ── row 1: steps ───────────────────────────────────────────────────────
    const total = list.length
    const done = list.filter(s => s.status === 'completed').length
    if (total && done < total) {
      const cur = list.find(s => s.status === 'in_progress')
      const idx = cur ? list.indexOf(cur) + 1 : done
      const label = cur ? (cur.activeForm || cur.subject) : `next: ${list.find(s => s.status !== 'completed')?.subject ?? ''}`
      rows.push(
        <Box key="steps" flexDirection="row">
          <Text color={cur ? YELLOW : BLUE} bold>{cur ? '▶\uFE0E' : '‖'} Step {idx}/{total}  </Text>
          {list.map(s => (
            <Text key={`b${s.id}`} color={s.status === 'completed' ? GREEN : s.status === 'in_progress' ? YELLOW : GREY}>
              {s.status === 'pending' ? '▱' : '▰'}
            </Text>
          ))}
          <Text color={CYAN} bold wrap="truncate-end">  {label}</Text>
          {sep}
          <Text color={GREEN}>{done} done</Text>
          <Text color={GREY}> · </Text>
          <Text>{total - done} left</Text>
        </Box>,
      )
    } else if (total) {
      rows.push(
        <Box key="steps" flexDirection="row">
          <Text color={GREEN} bold>✓ All {total} steps done  </Text>
          <Text color={GREEN}>{'▰'.repeat(total)}</Text>
        </Box>,
      )
    }

    // ── row 2: four tiles — 5-hour, weekly, context, cache ─────────────────
    const { Svg } = $.ui.resolve(e)
    const bar = (pct: number, color: string) => {
      const w = Math.max(0, Math.min(100, pct))
      return (
        <Svg
          source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 6" width="150" height="6" preserveAspectRatio="none"><rect width="100" height="6" rx="3" fill="${TRACK}"/>${w > 0 ? `<rect width="${w.toFixed(1)}" height="6" rx="3" fill="${color}"/>` : ''}</svg>`}
          alt={`${Math.round(w)}%`}
          width={150}
          height={6}
        />
      )
    }
    const glyph = (name: IconName, label: string) => (
      <Svg
        source={`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="12" height="12"><path d="${ICONS[name]}" fill="none" stroke="${GREY}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`}
        alt={label}
        width={12}
        height={12}
      />
    )
    const tile = (key: string, icon: IconName, label: string, corner: string, value: string, valueColor: string, pct: number, note = '') => (
      // A tile in warning (orange) or danger (red) takes that colour on its border too, so it stands out at a glance.
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        {...(valueColor === ORANGE || valueColor === RED ? { borderColor: valueColor } : { borderDimColor: true })}
        paddingX={1}
        width="48%"
        marginRight={1}
        marginBottom={1}
      >
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" alignItems="center" gap={1}>
            {glyph(icon, label)}
            <Text size="caption" color={GREY}>{label}</Text>
          </Box>
          <Text size="caption" color={GREY}>{corner}</Text>
        </Box>
        <Box flexDirection="row" alignItems="flex-end">
          <Text size="heading" weight="semibold" tabular color={valueColor}>{value}</Text>
          {note ? <Text size="caption" color={GREY}> {note}</Text> : null}
        </Box>
        {bar(pct, valueColor)}
      </Box>
    )

    const tiles = []
    for (const l of use?.limits ?? []) {
      const pct = l.percentUsed
      if (l.kind === 'five_hour') {
        tiles.push(tile('5h', 'clock', '5-hour', l.resetsAt ? `resets ${clock(l.resetsAt)}` : '', `${Math.round(pct)}%`, heat(pct), pct))
      } else if (l.kind === 'seven_day') {
        tiles.push(tile('wk', 'calendar', 'Weekly', l.resetsAt ? `resets ${weekday(l.resetsAt)}` : '', `${Math.round(pct)}%`, heat(pct), pct))
      }
    }
    if (use?.contextPercent != null) {
      const pct = use.contextPercent
      tiles.push(tile('ctx', 'layers', 'Context', use.contextTokens != null ? `${human(use.contextTokens)} used` : '', `${Math.round(pct)}%`, heat(pct), pct))
    }
    if (c) {
      const left = c.lastReplyAt + CACHE_TTL_MS - now
      const hit = c.hit == null ? '' : `${Math.round(c.hit * 100)}% hit`
      const size = human(c.size ?? use?.contextTokens ?? 0)
      tiles.push(
        left > 0
          ? tile('cache', 'bolt', 'Cache', hit, countdown(left), left > WARN_MS ? GREEN : ORANGE, (left / CACHE_TTL_MS) * 100, left > WARN_MS ? 'till cold' : `reply to keep ${size} warm`)
          : tile('cache', 'bolt', 'Cache', hit, 'cold', RED, 0, (c.size ?? 0) >= NEW_CHAT_AT ? `re-reads ${size} · new chat?` : `next msg re-reads ${size}`),
      )
    }
    if (tiles.length) {
      rows.push(<Box key="tiles" flexDirection="row" flexWrap="wrap">{tiles}</Box>)
    }

    // Keep what the band holds beneath us (lot-map's small map) at the left.
    const rest = await next(e)
    if (!rows.length) return rest
    return (
      <Box flexDirection="row" alignItems="center">
        {rest}
        <Box flexDirection="column" flexGrow={1}>{rows}</Box>
      </Box>
    )
  })
}

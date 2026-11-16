import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Extras, Hold, Outcome, Step, Tab, Task, Usage, Worker } from '../types'
// @ts-ignore: plain JavaScript, vendored from blast-radius (Apache-2.0)
import { classify as classifyRisk, measure, resolveDir } from './blast.mjs'
import {
  BLUE, GREEN, GREY, ORANGE, RED, YELLOW,
  activityOf, applyPlan, applyTaskUpdate, asksForOutcomes, bar, classify, clockOf, costOf, countdown, elapsed,
  firstLine, groupMade, groupOf, heat, human, modelTag, parseModalCsv, parseNames, parsePmset, planLine, PREVIEWABLE, ring, weekdayOf,
} from './model'

const P = 'cockpit'
const PANE = 'cockpit'
const steps = atom({ plugin: 'cockpit', key: 'steps' } as const, [] as Step[])
const usage = atom({ plugin: 'cockpit', key: 'usage' } as const, null as Usage | null)
const cache = atom({ plugin: 'cockpit', key: 'cache' } as const, null as Cache | null)
const tick = atom({ plugin: 'cockpit', key: 'tick' } as const, 0)
const open = atom({ plugin: 'cockpit', key: 'open' } as const, false as boolean)
const workers = atom({ plugin: 'cockpit', key: 'workers' } as const, [] as Worker[])
const outcomes = atom({ plugin: 'cockpit', key: 'outcomes' } as const, [] as Outcome[])
const tasks = atom({ plugin: 'cockpit', key: 'tasks' } as const, [] as Task[])
const hold = atom({ plugin: 'cockpit', key: 'hold' } as const, null as Hold | null)
const extras = atom({ plugin: 'cockpit', key: 'extras' } as const, { dirty: 0, battery: null, modal: {}, modalRunning: 0 } as Extras)
const tab = atom({ plugin: 'cockpit', key: 'tab' } as const, 'outcomes' as Tab)
const viewTask = atom({ plugin: 'cockpit', key: 'viewTask' } as const, null as number | null)
const heldLog = atom({ plugin: 'cockpit', key: 'held' } as const, [] as { at: number; title: string; answer: string }[])

const KEEP_OUTCOMES = 300
const POLL = '0.25'
const HOLD_LIMIT_MS = 10 * 60 * 1000
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|webm|mp3|wav|m4a|pdf|docx|pptx|xlsx|epub)$/i
const PLAN_TOOL = /update_plan$/
const WRAP_TOOL = /__wrap_up$/

/** Commands whose --yes deletes; Cockpit shows their own dry run before letting them through. */
const DRY_RUNS: { match: RegExp; flag: RegExp }[] = [{ match: /\bcleanup_video\.py\b/, flag: /\s--yes\b/ }]

// What is kept only while this module is loaded: a held call's answer, the paths a task edited, previews.
let decision: string | null = null
let holding = false
let touched = new Set<string>()
const previews = new Map<string, string>()

const isNotice = (text: string) => text.trimStart().startsWith('<task-notification>')

/** Anything that goes wrong in Cockpit must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

async function openPane($: EngineInterface, which: Tab) {
  await update($, tab, () => which)
  return $.ui.open({ id: PANE, title: 'Cockpit' })
}

async function currentTask($: EngineInterface): Promise<number> {
  const list = await read($, tasks)
  return list.length === 0 ? 0 : list[list.length - 1]!.n
}

async function addOutcome($: EngineInterface, found: Omit<Outcome, 'id' | 'at' | 'task'>): Promise<void> {
  const at = await $.clock.now()
  const task = await currentTask($)
  const id = `${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`
  await update($, outcomes, list => {
    // The same file made twice in one task is one result.
    const rest = found.path ? list.filter(o => !(o.task === task && o.path === found.path && o.kind === found.kind)) : list
    return [...rest, { ...found, id, at, task }].slice(-KEEP_OUTCOMES)
  })
}

async function makePreview($: EngineInterface, path: string): Promise<void> {
  if (previews.has(path) || !PREVIEWABLE.test(path)) return
  await quietly(async () => {
    const out = `/tmp/cockpit-preview-${Math.abs(hash(path))}.png`
    const made = await $.process.run(['sips', '-Z', '360', '-s', 'format', 'png', path, '--out', out], { timeoutMs: 10_000 })
    if (made.exitCode !== 0) return
    const b64 = await $.process.run(['base64', '-i', out], { timeoutMs: 10_000 })
    const png = b64.stdout.replace(/\s+/g, '')
    if (png.length > 0 && png.length < 2_000_000) previews.set(path, png)
  })
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)

/** Files this task made that no tool call announced: a render, frames, thumbnails a script wrote. */
async function scanMade($: EngineInterface, cwd: string, marker: string): Promise<string[]> {
  const run = await $.process.run(
    ['bash', '-c', 'find "$1" -maxdepth 6 \\( -name .git -o -name node_modules -o -name ".venv*" -o -name .cache -o -name __pycache__ -o -name Library \\) -prune -o -type f -newer "$2" -print 2>/dev/null | head -n 2000', 'cockpit', cwd, marker],
    { timeoutMs: 10_000 },
  )
  return run.stdout.split('\n').filter(p => MEDIA.test(p))
}

async function countDirty($: EngineInterface, cwd: string): Promise<number> {
  if (touched.size === 0) return 0
  const root = (await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })).stdout.trim()
  if (!root) return 0
  const st = await $.process.run(['git', '-C', root, 'status', '--porcelain', '--untracked-files=all'], { timeoutMs: 8000 })
  const dirty = new Set(st.stdout.split('\n').filter(Boolean).map(l => `${root}/${l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()}`))
  return [...touched].filter(p => dirty.has(p)).length
}

async function readBattery($: EngineInterface): Promise<void> {
  await quietly(async () => {
    const out = await $.process.run(['pmset', '-g', 'batt'], { timeoutMs: 5000 })
    const b = parsePmset(out.stdout)
    await update($, extras, x => ({ ...x, battery: b }))
  })
}

async function readModal($: EngineInterface, cwd: string, names: Record<string, string>): Promise<void> {
  if (Object.keys(names).length === 0) return
  await quietly(async () => {
    const file = `${cwd}/docs/modal-spend.csv`
    if (!(await $.fs.exists(file))) return
    const csv = await $.fs.read(file)
    const month = new Date(await $.clock.now()).toISOString().slice(0, 7)
    const spend = parseModalCsv(String(csv), month, names)
    await update($, extras, x => ({ ...x, modal: spend }))
  })
}

/** "Only on this Mac": files under the targets that are in no commit. */
const ONLY_HERE = `
cd "$1" 2>/dev/null || exit 0; shift
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo none; exit 0; }
a=$(git ls-files --others --exclude-standard -- "$@" 2>/dev/null | wc -l)
b=$(git ls-files --others --ignored --exclude-standard -- "$@" 2>/dev/null | wc -l)
c=$(git diff --name-only HEAD -- "$@" 2>/dev/null | wc -l)
echo $((a + b + c))
`

async function weigh($: EngineInterface, command: string, cwd: string): Promise<Hold | null> {
  const dry = DRY_RUNS.find(d => d.match.test(command) && d.flag.test(command))
  if (dry) {
    const preview = command.replace(dry.flag, '')
    const run = await $.process.run(['bash', '-c', preview], { cwd, timeoutMs: 60_000 })
    const lines = run.stdout.split('\n').filter(l => l.trim() !== '')
    return { command, title: 'Run a delete?', summary: firstLine(lines[lines.length - 1] ?? 'see its dry run', 100), lines: lines.slice(-8, -1), more: 0, onlyHere: null, note: 'From its own dry run (the same command without --yes).' }
  }
  const risk = classifyRisk(command)
  if (risk === null) return null
  const where = risk.dir ? await resolveDir($, cwd, risk.dir) : cwd
  const report = where === null ? { summary: `${risk.label} in ${risk.dir}`, lines: [], more: 0, note: 'Could not find that folder to measure it.' } : await measure($, risk, where)
  let onlyHere: number | null = null
  if (risk.kind === 'rm' && where !== null && risk.targets.length > 0) {
    const out = (await $.process.run(['bash', '-c', ONLY_HERE, 'cockpit', where, ...risk.targets], { timeoutMs: 15_000 })).stdout.trim()
    const files = Number(/delete (\d+) file/.exec(report.summary)?.[1] ?? 0)
    onlyHere = out === 'none' ? files : Number(out) || 0
  }
  const files = /delete (\d+) files?/.exec(report.summary)?.[1]
  return {
    command,
    title: files ? `Delete ${Number(files).toLocaleString('en-US')} ${files === '1' ? 'file' : 'files'}?` : `${risk.label[0]!.toUpperCase()}${risk.label.slice(1)}?`,
    summary: report.summary,
    lines: report.lines ?? [],
    more: report.more ?? 0,
    onlyHere,
    ...(report.note ? { note: report.note } : {}),
  }
}

export const register: Register = (on, options) => {
  const o = (options ?? {}) as Record<string, unknown>
  const CACHE_TTL_MS = String(o.cacheMinutes ?? '60') === '5' ? 5 * 60 * 1000 : 60 * 60 * 1000
  const WARN_MS = Math.min(10 * 60 * 1000, CACHE_TTL_MS / 6)
  const handoffAt = Number(o.handoffAt ?? 55) || 0
  const modalNames = parseNames(Array.isArray(o.modalNames) ? (o.modalNames as string[]) : [])
  const modalCap = Number(o.modalCap ?? 29) || 29
  const hidden = new Set(Array.isArray(o.hiddenRows) ? (o.hiddenRows as string[]) : ['session-hud', 'lot-map', 'cockpit-map', 'blast-radius'])
  let cwd = ''
  let marker = ''

  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      cwd = e.cwd
      await $.command.register({ name: 'cockpit', description: 'Open the Cockpit panel: task, workers and outcomes' })
      await $.command.register({ name: 'outcomes', description: 'Show what the last task produced' })
      // Rebuild the task list from the conversation so far (also after a reload).
      let list: Step[] = []
      for (const m of await $.session.messages()) {
        for (const u of m.toolUses ?? []) {
          if (PLAN_TOOL.test(u.tool)) list = applyPlan(list, u.input)
          else if (u.tool === 'TaskCreate') {
            const id = (u.result as { task?: { id?: unknown } } | undefined)?.task?.id ?? /Task #(\d+)/.exec(u.text ?? '')?.[1]
            if (id !== undefined) list.push({ id: String(id), subject: String(u.input.subject ?? ''), status: 'pending' })
          } else if (u.tool === 'TaskUpdate') list = applyTaskUpdate(list, u.input)
        }
      }
      await update($, steps, () => list)
      const now = await $.session.usage()
      await update($, usage, () => ({ contextPercent: now.context.percent ?? null, contextTokens: now.context.tokens ?? null, limits: now.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }))
      await readBattery($)
      await readModal($, cwd, modalNames)
      $.clock.every(15_000, () => { void update($, tick, n => n + 1) })
      $.clock.every(120_000, () => { void readBattery($) })
      $.clock.every(600_000, () => { void readModal($, cwd, modalNames) })
    })
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async $ => {
    const r = await openPane($, 'now')
    return { text: r.isPlaced ? 'Opened Cockpit.' : `Cockpit could not open here: ${String(r.reason)}` }
  })
  on('command.run', { command: 'outcomes' }, async $ => {
    await update($, viewTask, () => null)
    const r = await openPane($, 'outcomes')
    return { text: r.isPlaced ? 'Opened the outcomes.' : `Cockpit could not open here: ${String(r.reason)}` }
  })

  on('session.measure', async ($, e, next) => {
    await quietly(async () => {
      await update($, usage, () => ({ contextPercent: e.context.percent ?? null, contextTokens: e.context.tokens ?? null, limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })) }))
      if (e.changed.includes('context')) {
        const at = await $.clock.now()
        await update($, cache, c => ({ lastReplyAt: at, hit: c?.hit ?? null, size: e.context.tokens ?? c?.size ?? null }))
      }
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await quietly(async () => {
      if (e.agentId !== undefined) {
        const id = e.agentId
        await update($, workers, list => list.map(w => (w.id === id && w.status !== 'run' ? { ...w, status: 'run' as const } : w)))
        return
      }
      if (e.text === '' || isNotice(e.text)) return
      if (asksForOutcomes(e.text)) {
        await update($, viewTask, () => null)
        await openPane($, 'outcomes')
        return
      }
      // A new request: a new task. Finished workers leave the band; running ones stay.
      const at = await $.clock.now()
      await update($, tasks, list => [...list, { n: (list[list.length - 1]?.n ?? 0) + 1, ask: firstLine(e.text, 80), startedAt: at }].slice(-30))
      await update($, workers, list => list.filter(w => w.status === 'run'))
      await update($, extras, x => ({ ...x, dirty: 0 }))
      touched = new Set()
      marker = `/tmp/cockpit-mark-${Math.abs(hash(cwd))}`
      await $.process.run(['touch', marker], { timeoutMs: 5000 })
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const res = await next(e)
    await quietly(async () => {
      if (!('agentId' in res) || !res.agentId) return
      const at = await $.clock.now()
      const w: Worker = { id: res.agentId, name: e.description || e.subagentType, model: res.model ?? e.model ?? e.parentModel, status: 'run', startedAt: at, cost: 0 }
      await update($, workers, list => [...list.filter(x => x.id !== w.id), w].slice(-12))
    })
    return res
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await quietly(async () => {
      const at = await $.clock.now()
      if (e.agentId !== undefined) {
        const id = e.agentId
        await update($, workers, list => list.map(w => (w.id !== id ? w : {
          ...w,
          status: e.reason === 'answer' ? 'done' as const : 'failed' as const,
          endedAt: at,
          ...(e.answer ? { result: firstLine(e.answer, 90) } : {}),
          cost: w.cost + (e.usage ? costOf(w.model, e.usage) : 0),
        })))
        return
      }
      const u = e.usage
      if (u) {
        const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
        await update($, cache, c => ({ lastReplyAt: at, hit: total ? u.cache_read_input_tokens / total : null, size: c?.size ?? total }))
      }
      // The task's end: what is still open, what files appeared, what is left uncommitted.
      const n = await currentTask($)
      if (n === 0) return
      const left = (await read($, steps)).filter(s => s.status !== 'completed').map(s => s.subject)
      await update($, tasks, list => list.map(t => (t.n === n ? { ...t, endedAt: at, left } : t)))
      if (cwd && marker) {
        const known = new Set((await read($, outcomes)).filter(x => x.task === n && x.path).map(x => x.path!))
        const fresh = (await scanMade($, cwd, marker)).filter(p => !known.has(p))
        for (const g of groupMade(fresh).slice(0, 12)) await addOutcome($, { kind: 'made', title: g.title, detail: g.detail, path: g.path, ok: true })
        const dirty = await countDirty($, cwd)
        await update($, extras, x => ({ ...x, dirty }))
      }
      for (const x of (await read($, outcomes)).filter(x => x.task === n && x.path && PREVIEWABLE.test(x.path)).slice(0, 6)) await makePreview($, x.path!)
    })
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    const tool = e.tool

    // A delete waits for the person's answer.
    if (tool === 'Bash') {
      const command = String(input.command ?? '')
      const weighed = await quietly(async () => weigh($, command, cwd || (await $.session.cwd())))
      if (weighed) {
        while ((await read($, hold)) !== null) {
          if (next.signal.aborted) return { deny: 'Cockpit held this command and did not run it: the turn was interrupted. Do not retry it unless the user asks you to.' }
          await $.process.run(['sleep', POLL], { timeoutMs: 5000 })
        }
        decision = null
        holding = true
        await update($, hold, () => weighed)
        const startedAt = await $.clock.now()
        let answer = 'error'
        try {
          while (decision === null) {
            if (next.signal.aborted) { decision = 'interrupted'; break }
            if ((await $.clock.now()) - startedAt > HOLD_LIMIT_MS) { decision = 'timeout'; break }
            await $.process.run(['sleep', POLL], { timeoutMs: 5000 })
          }
          answer = decision ?? 'error'
        } finally {
          await update($, hold, () => null)
          const at = await $.clock.now()
          await update($, heldLog, list => [...list, { at, title: weighed.title, answer: answer === 'proceed' ? 'deleted' : answer === 'cancel' ? 'cancelled' : answer }].slice(-20))
        }
        holding = false
        if (answer !== 'proceed') {
          const why = { cancel: 'the user pressed Cancel', timeout: 'no answer within 10 minutes', interrupted: 'the turn was interrupted' }[answer] ?? 'Cockpit could not get an answer'
          return { deny: `Cockpit held this command and did not run it: ${why}. It would have: ${weighed.summary}. Do not retry it unless the user asks you to.` }
        }
      }
    }

    const isModal = tool === 'Bash' && /\bmodal\b/.test(String(input.command ?? ''))
    if (isModal) await quietly(() => update($, extras, x => ({ ...x, modalRunning: x.modalRunning + 1 })))
    if (e.agentId !== undefined) {
      const id = e.agentId
      const now = activityOf(tool, input)
      if (now) await quietly(() => update($, workers, list => list.map(w => (w.id === id ? { ...w, now } : w))))
    }

    let ran
    try {
      ran = await next(e)
    } finally {
      if (isModal) {
        await quietly(() => update($, extras, x => ({ ...x, modalRunning: Math.max(0, x.modalRunning - 1) })))
        void readModal($, cwd, modalNames)
      }
    }

    await quietly(async () => {
      if ('deny' in ran && ran.deny !== undefined) return
      const isError = 'isError' in ran && ran.isError === true
      const text = 'text' in ran && typeof ran.text === 'string' ? ran.text : ''
      if (e.agentId === undefined && !isError) {
        if (PLAN_TOOL.test(tool)) await update($, steps, list => applyPlan(list, input))
        else if (tool === 'TaskCreate') {
          const id = /Task #(\d+)/.exec(text)?.[1] ?? (('result' in ran ? (ran.result as { task?: { id?: unknown } })?.task?.id : undefined) as string | undefined)
          if (id !== undefined) await update($, steps, list => [...list.filter(s => s.id !== String(id)), { id: String(id), subject: String(input.subject ?? ''), status: 'pending' }])
        } else if (tool === 'TaskUpdate') await update($, steps, list => applyTaskUpdate(list, input))
        else if (WRAP_TOOL.test(tool)) {
          const n = await currentTask($)
          const recap = typeof input.recap === 'string' ? input.recap : undefined
          if (recap) await update($, tasks, list => list.map(t => (t.n === n ? { ...t, recap } : t)))
          await update($, steps, list => list.map(s => ({ ...s, status: 'completed' as const })))
        }
      }
      if (typeof input.file_path === 'string' && /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) touched.add(input.file_path)
      const found = classify({ tool, input, text, isError })
      if (found) await addOutcome($, found)
    })
    return ran
  }).catch(($, e, next) => {
    // A crash while a delete is held refuses that delete; anywhere else the call goes on as if Cockpit were not here.
    if (holding) {
      holding = false
      void quietly(() => update($, hold, () => null))
      return next.called ? next(e) : { deny: 'Cockpit held this command and did not run it: it hit an error while waiting for an answer. Do not retry it unless the user asks you to.' }
    }
    return next(e)
  })

  // Cockpit owns the band: the rows it replaces step aside. Their panes and commands keep working.
  on('ui.render', { plugin: '*', component: 'AbovePromptList' }, async ($, e, next) => {
    if (e.surface === 'terminal' || !e.props.rows.some(r => r.plugin === P)) return next(e)
    const mine = e.props.rows.filter(r => r.plugin === P)
    const rest = e.props.rows.filter(r => r.plugin !== P && !hidden.has(r.plugin))
    return next({ ...e, props: { ...e.props, rows: [...mine, ...rest] } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    await read($, tick)
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const u = await read($, usage)
    const c = await read($, cache)
    const plan = planLine(await read($, steps))
    const isOpen = await read($, open)
    const team = await read($, workers)
    const held = await read($, hold)
    const x = await read($, extras)
    const allTasks = await read($, tasks)
    const task = allTasks[allTasks.length - 1]
    const results = task ? (await read($, outcomes)).filter(r => r.task === task.n) : []
    const narrow = e.props.bodyColumns < 70

    const limit = (kind: string) => u?.limits.find(l => l.kind === kind)
    const ctx = u?.contextPercent ?? null
    const five = limit('five_hour')
    const week = limit('seven_day')
    const pastHandoff = handoffAt > 0 && ctx !== null && ctx >= handoffAt
    const ctxColor = ctx === null ? GREY : pastHandoff && heat(ctx) === GREEN ? ORANGE : pastHandoff && heat(ctx) === YELLOW ? ORANGE : heat(ctx)
    const left = c ? c.lastReplyAt + CACHE_TTL_MS - now : null
    const cacheColor = left === null ? GREY : left <= 0 ? RED : left <= WARN_MS ? ORANGE : GREEN

    const gauge = (key: string, pct: number | null, color: string, value: string, label: string, alt: string) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1}>
        <Svg source={ring(pct ?? 0, color)} alt={alt} width={14} height={14} />
        <Text size="footnote" tabular color={color === GREEN || color === GREY ? undefined : color}>{value}</Text>
        {narrow ? null : <Text size="caption" dimColor>{label}</Text>}
      </Box>
    )

    // The left side: what is happening now.
    const running = team.filter(w => w.status === 'run')
    const status = held ? <Text color={RED}>●</Text> : running.length > 0 || e.props.isWorking ? <Text color={YELLOW}>●</Text> : <Text color={GREEN}>✓</Text>
    const label = held ? 'Waiting on you' : plan ? plan.label : task ? task.ask : 'Ready'
    const done = task?.endedAt !== undefined && !e.props.isWorking && (results.length > 0 || (task.left?.length ?? 0) > 0 || plan !== null)
    const chips: unknown[] = []
    if (done && task) {
      const made = results.filter(r => r.ok).length
      const leftN = task.left?.length ?? 0
      chips.push(<Button key="cockpit-results" plain label={`${made} done${leftN ? ` · ${leftN} left` : ''} · See results`} onPress={() => void quietly(async () => { await update($, viewTask, () => task.n); await openPane($, 'outcomes') })} />)
    }
    const doneTeam = team.filter(w => w.status !== 'run')
    if (running.length === 0 && doneTeam.length > 0) chips.push(<Text key="team" size="footnote" dimColor>✓ {doneTeam.length} {doneTeam.length === 1 ? 'worker' : 'workers'} · ${doneTeam.reduce((s, w) => s + w.cost, 0).toFixed(2)}</Text>)
    if (x.dirty > 0) chips.push(<Text key="dirty" size="footnote" color={YELLOW}>● {x.dirty} not committed</Text>)
    const modalShown = Object.entries(x.modal).filter(([, v]) => x.modalRunning > 0 || v >= 20)
    for (const [name, v] of modalShown) chips.push(<Text key={`modal-${name}`} size="footnote" color={v >= modalCap - 2 ? RED : v >= 20 ? ORANGE : undefined}>Modal {name} ${Math.round(v)} / {modalCap}</Text>)
    if (x.battery && x.battery.onBattery && x.battery.percent < 30) chips.push(<Text key="battery" size="footnote" color={RED}>● Battery {x.battery.percent}% · plug in</Text>)
    if (pastHandoff) chips.push(<Button key="cockpit-handoff" plain label="Hand off" onPress={() => void quietly(() => $.prompt.fill({ text: 'Write the handoff for the next chat, then tell me it is ready.', mode: 'replace' }))} />)

    const island = (
      <Box key="island" flexDirection="row" alignItems="center" width="100%" borderStyle="round" borderDimColor paddingX={1} gap={2}>
        <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} gap={1}>
          {status}
          {narrow ? null : <Text size="footnote" weight="medium" wrap="truncate-end">{label}</Text>}
          {plan && !plan.isDone ? <Text size="footnote" tabular dimColor>{plan.index}/{plan.total}</Text> : null}
          {chips}
        </Box>
        {gauge('ctx', ctx, ctxColor, ctx === null ? '–' : `${Math.round(ctx)}%`, 'ctx', 'Context used')}
        {gauge('5h', five?.percentUsed ?? null, five ? heat(five.percentUsed) : GREY, five ? `${Math.round(five.percentUsed)}%` : '–', '5h', '5-hour limit used')}
        {gauge('wk', week?.percentUsed ?? null, week ? heat(week.percentUsed) : GREY, week ? `${Math.round(week.percentUsed)}%` : '–', 'wk', 'Weekly limit used')}
        {narrow || left === null ? null : gauge('cache', left > 0 ? (left / CACHE_TTL_MS) * 100 : 0, cacheColor, left > 0 ? countdown(left) : 'cold', 'cache', 'Cache time left')}
        <Button key="cockpit-more" plain dimColor label={isOpen ? '⌃' : '⌄'} onPress={() => void quietly(() => update($, open, v => !v))} />
      </Box>
    )

    const above: unknown[] = []
    if (held) {
      const onlyHere = held.onlyHere
      above.push(
        <Box key="hold" flexDirection="column" borderStyle="round" borderColor={RED} paddingX={1} gap={1}>
          <Text weight="semibold">{held.title}</Text>
          <Text size="footnote" dimColor wrap="truncate-end">{held.command}</Text>
          <Text size="footnote">{held.summary}</Text>
          {held.lines.length > 0 ? (
            <Box flexDirection="column">
              {held.lines.slice(0, 5).map((l, i) => <Text key={`l${i}`} size="footnote" dimColor wrap="truncate-end">{l}</Text>)}
              {held.more > 0 || held.lines.length > 5 ? <Text size="footnote" dimColor>+ {held.more + Math.max(0, held.lines.length - 5)} more</Text> : null}
            </Box>
          ) : null}
          {onlyHere === null ? (held.note ? <Text size="footnote" dimColor>{held.note}</Text> : null)
            : onlyHere > 0 ? <Text size="footnote" color={RED}>● {onlyHere.toLocaleString('en-US')} {onlyHere === 1 ? 'file is' : 'files are'} in no commit: only on this Mac</Text>
            : <Text size="footnote" color={GREEN}>● Every file is in a commit</Text>}
          <Box flexDirection="row" gap={2}>
            <Button key="cockpit-cancel" variant="primary" autoFocus hotkey="2" label="Cancel" onPress={() => { if (decision === null) decision = 'cancel' }} />
            <Button key="cockpit-delete" hotkey="1" label="Delete" onPress={() => { if (decision === null) decision = 'proceed' }} />
          </Box>
        </Box>,
      )
    } else if (running.length > 0) {
      const cost = team.reduce((s, w) => s + w.cost, 0)
      above.push(
        <Box key="team" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text size="footnote" weight="semibold">{team.length} {team.length === 1 ? 'worker' : 'workers'} · {running.length} running</Text>
            <Text size="footnote" tabular dimColor>${cost.toFixed(2)} est.</Text>
          </Box>
          {team.map(w => (
            <Box key={`w-${w.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text size="footnote" color={w.status === 'run' ? YELLOW : w.status === 'done' ? GREEN : RED}>{w.status === 'run' ? '●' : w.status === 'done' ? '✓' : '✕'}</Text>
                <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="truncate-end">{w.name}</Text></Box>
                <Text size="caption" dimColor>{modelTag(w.model)}</Text>
                <Text size="caption" tabular dimColor>{elapsed((w.endedAt ?? now) - w.startedAt)}</Text>
              </Box>
              {w.result || w.now ? <Text size="caption" dimColor wrap="truncate-end">   {w.status === 'run' ? w.now : w.result}</Text> : null}
            </Box>
          ))}
        </Box>,
      )
    }

    const details = isOpen ? (
      <Box key="details" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {([
          ['Context', ctx, ctxColor, u?.contextTokens != null ? `${human(u.contextTokens)} used` : ''],
          ['5-hour', five?.percentUsed ?? null, five ? heat(five.percentUsed) : GREY, five?.resetsAt ? `resets ${clockOf(five.resetsAt)}` : ''],
          ['Weekly', week?.percentUsed ?? null, week ? heat(week.percentUsed) : GREY, week?.resetsAt ? `resets ${weekdayOf(week.resetsAt)}` : ''],
          ['Cache', left === null ? null : left > 0 ? (left / CACHE_TTL_MS) * 100 : 0, cacheColor, c?.hit != null ? `${Math.round(c.hit * 100)}% hit` : ''],
        ] as [string, number | null, string, string][]).map(([name, pct, color, meta]) => (
          <Box key={`d-${name}`} flexDirection="row" alignItems="center" gap={2}>
            <Box width={8}><Text size="footnote" dimColor>{name}</Text></Box>
            <Svg source={bar(pct ?? 0, color)} alt={`${name} ${Math.round(pct ?? 0)}%`} width={160} height={4} />
            <Box width={6}><Text size="footnote" tabular>{name === 'Cache' ? (left === null ? '–' : left > 0 ? countdown(left) : 'cold') : pct === null ? '–' : `${Math.round(pct)}%`}</Text></Box>
            <Text size="caption" dimColor>{meta}</Text>
          </Box>
        ))}
        <Box flexDirection="row" gap={2}>
          <Button key="cockpit-panel" plain dimColor label="Open panel" onPress={() => void quietly(() => openPane($, 'now'))} />
        </Box>
      </Box>
    ) : null

    return (
      <Box flexDirection="column" width="100%" gap={1}>
        {above}
        {details}
        {island}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link, Image } = $.ui.resolve(e)
    const which = await read($, tab)
    const allTasks = await read($, tasks)
    const pick = await read($, viewTask)
    const all = await read($, outcomes)
    const team = await read($, workers)
    const list = await read($, steps)
    const log = await read($, heldLog)
    const now = await $.clock.now()
    const task = (pick !== null ? allTasks.find(t => t.n === pick) : undefined) ?? [...allTasks].reverse().find(t => all.some(o => o.task === t.n) || t.recap) ?? allTasks[allTasks.length - 1]

    const tabs = (
      <Box key="tabs" flexDirection="row" gap={1}>
        {(['now', 'workers', 'outcomes'] as Tab[]).map(t => (
          <Button key={`tab-${t}`} variant={t === which ? 'primary' : 'secondary'} label={t === 'now' ? 'Now' : t === 'workers' ? 'Workers' : 'Outcomes'} onPress={() => void quietly(() => update($, tab, () => t))} />
        ))}
      </Box>
    )
    const heading = (s: string) => <Text key={`h-${s}`} size="caption" weight="semibold" dimColor>{s.toUpperCase()}</Text>

    let body: unknown
    if (which === 'outcomes') {
      if (!task) {
        body = <Text dimColor>Nothing yet. Results show here when a task finishes: files made, pages published, commits, PRs, tickets and checks.</Text>
      } else {
        const mine = all.filter(o => o.task === task.n)
        const made = mine.filter(o => groupOf(o.kind) === 'made')
        const shipped = mine.filter(o => groupOf(o.kind) === 'shipped')
        const checked = mine.filter(o => groupOf(o.kind) === 'checked')
        const left = [...(task.left ?? []), ...checked.filter(o => !o.ok).map(o => o.title)]
        const row = (o: Outcome) => (
          <Box key={`o-${o.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={o.ok ? GREEN : RED}>{o.ok ? '✓' : '✕'}</Text>
              <Box flexGrow={1} flexShrink={1}><Text weight="medium" wrap="truncate-end">{o.title}</Text></Box>
              {o.href ? <Link href={o.href} label="Open" /> : o.path ? <Link href={`file://${o.path}`} label="Open" /> : null}
            </Box>
            {o.detail ? <Text size="caption" dimColor wrap="truncate-end">   {o.detail}</Text> : null}
            {o.path && previews.has(o.path) ? <Image source={{ png: previews.get(o.path)! }} columns={24} rows={8} alt={o.title} /> : null}
          </Box>
        )
        body = (
          <Box flexDirection="column" gap={1}>
            <Text weight="semibold" wrap="wrap">{task.ask}</Text>
            {task.recap ? <Text size="footnote" dimColor wrap="wrap">{task.recap}</Text> : null}
            {made.length ? <Box flexDirection="column">{heading('Made')}{made.map(row)}</Box> : null}
            {shipped.length ? <Box flexDirection="column">{heading('Shipped')}{shipped.map(row)}</Box> : null}
            {checked.length ? <Box flexDirection="column">{heading('Checked')}{checked.map(row)}</Box> : null}
            {left.length ? (
              <Box flexDirection="column">{heading('Not done')}{left.map((l, i) => <Box key={`left-${i}`} flexDirection="row" gap={1}><Text color={ORANGE}>○</Text><Text wrap="wrap">{l}</Text></Box>)}</Box>
            ) : null}
            {!made.length && !shipped.length && !checked.length && !left.length ? <Text dimColor>No results recorded for this task.</Text> : null}
            {allTasks.length > 1 ? (
              <Box flexDirection="column">
                {heading('Earlier')}
                {[...allTasks].reverse().filter(t => t.n !== task.n).slice(0, 8).map(t => (
                  <Button key={`task-${t.n}`} plain dimColor label={`${t.ask} · ${all.filter(o => o.task === t.n).length} results`} onPress={() => void quietly(() => update($, viewTask, () => t.n))} />
                ))}
              </Box>
            ) : null}
          </Box>
        )
      }
    } else if (which === 'workers') {
      body = team.length === 0 ? <Text dimColor>No workers this task.</Text> : (
        <Box flexDirection="column" gap={1}>
          {team.map(w => (
            <Box key={`pw-${w.id}`} flexDirection="column">
              <Box flexDirection="row" gap={1}>
                <Text color={w.status === 'run' ? YELLOW : w.status === 'done' ? GREEN : RED}>{w.status === 'run' ? '●' : w.status === 'done' ? '✓' : '✕'}</Text>
                <Box flexGrow={1} flexShrink={1}><Text weight="medium" wrap="truncate-end">{w.name}</Text></Box>
                <Text size="caption" dimColor>{modelTag(w.model)} · {elapsed((w.endedAt ?? now) - w.startedAt)} · ${w.cost.toFixed(2)}</Text>
              </Box>
              <Text size="footnote" dimColor wrap="wrap">   {w.status === 'run' ? w.now ?? 'starting' : w.result ?? 'finished'}</Text>
            </Box>
          ))}
          <Text size="caption" dimColor>Costs are estimates from token counts at list prices, not a bill.</Text>
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" gap={1}>
          {heading('Task')}
          {list.length === 0 ? <Text dimColor>No task list yet.</Text> : list.map(s => (
            <Box key={`s-${s.id}`} flexDirection="row" gap={1}>
              <Text color={s.status === 'completed' ? GREEN : s.status === 'in_progress' ? YELLOW : GREY}>{s.status === 'completed' ? '✓' : s.status === 'in_progress' ? '▶' : '○'}</Text>
              <Text wrap="wrap" dimColor={s.status === 'pending'}>{s.subject}</Text>
            </Box>
          ))}
          {log.length ? <Box flexDirection="column">{heading('Held')}{[...log].reverse().slice(0, 6).map((h, i) => <Text key={`hl-${i}`} size="footnote" dimColor>{h.answer === 'deleted' ? '✓' : '✕'} {h.title} · {h.answer}</Text>)}</Box> : null}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        {body}
      </Box>
    )
  })
}

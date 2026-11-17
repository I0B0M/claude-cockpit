import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Board, Cache, Entry, Extras, Hold, Outcome, StationId, Status, Step, Tab, Task, Usage, Worker } from '../types'
import { classify as stationOf, clean, drawMap, setupFrom, shortModel } from './lotmap/map'
// @ts-ignore: plain JavaScript, vendored from blast-radius (Apache-2.0)
import { classify as classifyRisk, measure, resolveDir } from './blast.mjs'
import {
  BLUE, GREEN, GREY, ORANGE, RED, YELLOW,
  activityOf, applyPlan, applyTaskUpdate, asksForOutcomes, bar, classify, clockOf, costOf, countdown, elapsed,
  firstLine, groupMade, groupOf, heat, human, modelTag, parseModalCsv, parseNames, parsePmset, planLine, PREVIEWABLE, ring, segments, shownModal, stepTrack, weekdayOf,
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
const board = atom({ plugin: 'cockpit', key: 'board' } as const, { entries: [], counts: {} } as Board)

// The activity map (lot-map's drawing). Only the activity colours are set, in Cockpit's blue and purple, so the
// greys still follow the app's light or dark theme; no ground of its own, so it sits in the card.
const MAP = {
  ...setupFrom({ background: 'transparent', colors: ['accent=#0a84ff', 'active=#64d2ff', 'memory=#bf5af2', 'memoryActive=#da8fff', 'error=#ff453a'] }),
  compact: true,
}
const MAP_KEEP = 80
const batteryIcon = (pct: number): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 11"><rect x=".5" y=".5" width="16.5" height="10" rx="2.6" fill="none" stroke="#98989d"/><rect x="18" y="3.5" width="1.6" height="4" rx=".8" fill="#98989d"/><rect x="2" y="2" width="${Math.max(1, Math.round((13.5 * pct) / 100))}" height="7" rx="1.4" fill="#ff453a"/></svg>`
/** What the map shows, in words, for a reader that cannot see it. */
const describeBoard = (b: Board): string => {
  const busy = [...new Set(b.entries.filter(x => x.status === 'run').map(x => x.station))]
  return busy.length ? `Busy: ${busy.join(', ')}.` : 'Nothing running.'
}
const MAP_CREW = 12
let mapSeq = 0

const KEEP_OUTCOMES = 300
const POLL_MS = 250 // how often a held delete looks for your answer: the engine's own timer, no process started
const HOLD_LIMIT_MS = 10 * 60 * 1000
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|webm|mp3|wav|m4a|pdf|docx|pptx|xlsx|epub)$/i
const FIND_MEDIA = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'mp3', 'wav', 'm4a', 'pdf', 'docx', 'pptx', 'xlsx', 'epub'].map(x => `-iname "*.${x}"`).join(' -o ')
const PLAN_TOOL = /update_plan$/
const WRAP_TOOL = /__wrap_up$/

/** Commands whose --yes deletes; Cockpit shows their own dry run before letting them through. */
const DRY_RUNS: { match: RegExp; flag: RegExp }[] = [{ match: /\bcleanup_video\.py\b/, flag: /\s--yes\b/ }]

// What is kept only while this module is loaded: a held call's answer, the paths a task edited, previews.
let decision: string | null = null
let holding = false
const previews = new Map<string, string>()

const isNotice = (text: string) => text.trimStart().startsWith('<task-notification>')

type MapStart = { station: StationId; label: string; from?: Entry['from']; status?: Status; agentId?: string; mark?: Entry['mark']; patch?: Partial<Pick<Board, 'model' | 'step'>> }

/** One action lands on the map (lot-map's begin, without its per-name tally). Returns the row's id. */
async function mapBegin($: EngineInterface, start: MapStart): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: `${now.toString(36)}-${(mapSeq++).toString(36)}`,
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    const fault = (entry.status === 'err' || entry.status === 'block') && entry.station !== 'you'
    await update($, board, b => {
      const from = b.entries.length + 1 - MAP_KEEP
      return {
        ...b,
        ...start.patch,
        entries: [...(from <= 0 ? b.entries : b.entries.filter((x, i) => i >= from || x.status === 'run')), entry],
        counts: { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
        ...(fault ? { faults: { ...b.faults, [entry.station]: (b.faults?.[entry.station] ?? 0) + 1 } } : {}),
        ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId) ? { agents: [...(b.agents ?? []), entry.agentId].slice(-MAP_CREW) } : {}),
      }
    })
    return entry.id
  })
}

/** A row on the map is answered: it stops pulsing, as a fault when it failed or was refused. */
async function mapFinish($: EngineInterface, id: string | undefined, status: Status): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const row = b.entries.find(x => x.id === id && x.status === 'run')
      if (row === undefined) return b
      const fault = status === 'err' || status === 'block'
      return {
        ...b,
        entries: b.entries.map(x => (x === row ? { ...x, status, endedAt: now } : x)),
        ...(fault ? { faults: { ...b.faults, [row.station]: (b.faults?.[row.station] ?? 0) + 1 } } : {}),
      }
    })
  })
}

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
    // The media filter runs inside find, so the cap counts only media: a day of logs or code edits never pushes a render past it.
    ['bash', '-c', `find "$1" -maxdepth 6 \\( -name .git -o -name node_modules -o -name ".venv*" -o -name .cache -o -name __pycache__ -o -name Library \\) -prune -o -type f -newer "$2" \\( ${FIND_MEDIA} \\) -print 2>/dev/null | head -n 2000`, 'cockpit', cwd, marker],
    { timeoutMs: 10_000 },
  )
  return run.stdout.split('\n').filter(p => MEDIA.test(p))
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
      await update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} }))
      await mapBegin($, { station: 'you', label: 'New message', from: 'inbound', status: 'ok' })
      if (asksForOutcomes(e.text)) {
        await update($, viewTask, () => null)
        await openPane($, 'outcomes')
        return
      }
      // A new request: a new task. Finished workers leave the band; running ones stay.
      const at = await $.clock.now()
      await update($, tasks, list => [...list, { n: (list[list.length - 1]?.n ?? 0) + 1, ask: firstLine(e.text, 80), startedAt: at }].slice(-30))
      await update($, workers, list => list.filter(w => w.status === 'run'))
      marker = `/tmp/cockpit-mark-${Math.abs(hash(cwd))}`
      await $.process.run(['touch', marker], { timeoutMs: 5000 })
    })
    return next(e)
  })

  // Each model step lights the model station while it thinks.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const id = await mapBegin($, {
      station: 'model',
      label: `${shortModel(e.model)} · step ${e.index + 1}${isMain ? '' : ' · subagent'}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    try {
      return yield* next(e)
    } finally {
      await mapFinish($, id, 'ok')
    }
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
        await update($, board, b => ({
          ...b,
          agents: (b.agents ?? []).filter(a => a !== id),
          entries: b.entries.map(r => (r.status === 'run' && r.agentId === id ? { ...r, status: 'ok' as const, endedAt: at } : r)),
        }))
        return
      }
      await mapBegin($, { station: 'you', label: e.isAborted ? 'Stopped' : 'Answer ready', status: e.isAborted ? 'err' : 'ok', ...(e.isAborted ? {} : { mark: 'done' as const }) })
      await update($, board, b => ({ ...b, entries: b.entries.map(r => (r.status === 'run' && r.from === 'core' ? { ...r, status: 'ok' as const, endedAt: at } : r)) }))
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
          await $.clock.sleep(POLL_MS)
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
            await $.clock.sleep(POLL_MS)
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

    const mapId = await mapBegin($, { ...stationOf(tool, input, MAP), ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    let ran
    try {
      ran = await next(e)
      await mapFinish($, mapId, 'deny' in ran && ran.deny !== undefined ? 'block' : 'isError' in ran && ran.isError === true ? 'err' : 'ok')
    } catch (err) {
      await mapFinish($, mapId, 'err')
      throw err
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
          if (id !== undefined) await update($, steps, list => [...list.filter(s => s.id !== String(id)), { id: String(id), subject: String(input.subject ?? ''), status: 'pending' as const }])
        } else if (tool === 'TaskUpdate') await update($, steps, list => applyTaskUpdate(list, input))
        else if (WRAP_TOOL.test(tool)) {
          const n = await currentTask($)
          const recap = typeof input.recap === 'string' ? input.recap : undefined
          if (recap) await update($, tasks, list => list.map(t => (t.n === n ? { ...t, recap } : t)))
          await update($, steps, list => list.map(s => ({ ...s, status: 'completed' as const })))
        }
      }
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
    // The line under the card holds only what needs you now: hand off, a low battery, a Modal job running.
    const chips: RenderChildren[] = []
    for (const [name, v] of shownModal(x.modal, x.modalRunning)) chips.push(<Text key={`modal-${name}`} size="footnote" color={v >= modalCap - 2 ? RED : v >= 20 ? ORANGE : undefined}>{`● Modal ${name} running · $${Math.round(v)} of $${modalCap}`}</Text>)
    if (x.battery && x.battery.onBattery && x.battery.percent < 30) chips.push(<Box key="battery" flexDirection="row" alignItems="center" gap={1}><Svg source={batteryIcon(x.battery.percent)} alt="" width={20} height={11} /><Text size="footnote" color={RED}>{`${x.battery.percent}%`}</Text><Text size="footnote" dimColor>Plug in</Text></Box>)
    if (pastHandoff) chips.push(<Button key="cockpit-handoff" plain label="Hand off" onPress={() => void quietly(() => $.prompt.fill({ text: 'Write the handoff for the next chat, then tell me it is ready.', mode: 'replace' }))} />)

    const island = (
      <Box key="island" flexDirection="row" alignItems="center" width="100%" borderStyle="round" borderDimColor paddingX={1} gap={2}>
        <Box flexDirection="row" alignItems="center" flexGrow={1} flexShrink={1} gap={1}>
          {status}
          {narrow ? null : <Text size="footnote" weight="medium" wrap="truncate-end">{label}</Text>}
          {plan && !plan.isDone ? <Text size="footnote" tabular dimColor>{plan.index}/{plan.total}</Text> : null}
          {chips}
        </Box>
        {gauge('5h', five?.percentUsed ?? null, five ? heat(five.percentUsed) : GREY, five ? `${Math.round(five.percentUsed)}%` : '–', '5h', '5-hour limit used')}
        {gauge('wk', week?.percentUsed ?? null, week ? heat(week.percentUsed) : GREY, week ? `${Math.round(week.percentUsed)}%` : '–', 'wk', 'Weekly limit used')}
        {gauge('ctx', ctx, ctxColor, ctx === null ? '–' : `${Math.round(ctx)}%`, 'ctx', 'Context used')}
        {narrow || left === null ? null : gauge('cache', left > 0 ? (left / CACHE_TTL_MS) * 100 : 0, cacheColor, left > 0 ? countdown(left) : 'cold', 'cache', 'Cache time left')}
        <Button key="cockpit-more" plain dimColor label={isOpen ? '⌃' : '⌄'} onPress={() => void quietly(() => update($, open, v => !v))} />
      </Box>
    )

    const above: RenderChildren[] = []
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

    // The resting card, as tall as one step line and one row of numbers: the steps on the left (a colour bar, then
    // Done, Now, Next), the four numbers on the right. Every text shrinks and ends in an ellipsis, so nothing overlaps.
    // Opened, the same card keeps its shape and the map comes in underneath.
    const track = stepTrack(await read($, steps))
    const stack = e.props.bodyColumns < 96
    // Stacked under the steps, the rings get a row of their own: they spread across it and each names its detail
    // (reset time, tokens used, cache hit), so the row has no empty right half.
    const spread = stack
    const cell = (key: string, pct: number | null, color: string, value: string, name: string, sub: string, alt: string) => (
      <Box key={key} flexDirection="row" alignItems="center" gap={1} {...(spread ? { flexShrink: 1, minWidth: 0 } : { width: 11, flexShrink: 0 })}>
        <Svg source={ring(pct ?? 0, color, 28)} alt={sub === '' ? alt : `${alt}, ${sub}`} width={28} height={28} />
        <Box flexDirection="column" flexShrink={1} minWidth={0}>
          <Text size="footnote" weight="semibold" tabular wrap="truncate-end" color={color === GREEN || color === GREY ? undefined : color}>{value}</Text>
          {spread && !narrow && sub !== '' ? (
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Text size="caption" dimColor>{name}</Text>
              <Box flexShrink={1} minWidth={0}><Text size="caption" dimColor wrap="truncate-end">{sub}</Text></Box>
            </Box>
          ) : <Text size="caption" dimColor wrap="truncate-end">{name}</Text>}
        </Box>
      </Box>
    )
    // Opened, the reset times and the rest sit beside the map, so the card above keeps its shape.
    const details = [
      five?.resetsAt ? `5-hour resets ${clockOf(five.resetsAt)}` : '',
      week?.resetsAt ? `Weekly resets ${weekdayOf(week.resetsAt)}` : '',
      u?.contextTokens != null ? `Context: ${human(u.contextTokens)} used` : '',
      c?.hit != null ? `Cache: ${Math.round(c.hit * 100)}% hit` : '',
    ].filter(Boolean)
    const rings = (
      <Box key="rings" flexDirection="row" alignItems="center" columnGap={1} {...(spread ? { width: '100%', justifyContent: 'space-between' } : { flexShrink: 0 })}>
        {cell('r-5h', five?.percentUsed ?? null, five ? heat(five.percentUsed) : GREY, five ? `${Math.round(five.percentUsed)}%` : '–', '5-hour', five?.resetsAt ? `resets ${clockOf(five.resetsAt)}` : '', '5-hour limit used')}
        {cell('r-wk', week?.percentUsed ?? null, week ? heat(week.percentUsed) : GREY, week ? `${Math.round(week.percentUsed)}%` : '–', 'Weekly', week?.resetsAt ? `resets ${weekdayOf(week.resetsAt)}` : '', 'Weekly limit used')}
        {cell('r-ctx', ctx, ctxColor, ctx === null ? '–' : `${Math.round(ctx)}%`, 'Context', u?.contextTokens != null ? `${human(u.contextTokens)} used` : '', 'Context used')}
        {narrow || left === null ? null : cell('r-cache', left > 0 ? (left / CACHE_TTL_MS) * 100 : 0, cacheColor, left > 0 ? countdown(left) : 'cold', 'Cache', c?.hit != null ? `${Math.round(c.hit * 100)}% hit` : '', 'Cache time left')}
        <Button key="cockpit-more" plain dimColor label={isOpen ? '⌃' : '⌄'} onPress={() => void quietly(() => update($, open, v => !v))} />
      </Box>
    )
    const column = (key: string, title: string, color: string, body: RenderChildren, grow: number) => (
      <Box key={key} flexDirection="column" flexGrow={grow} flexShrink={1} width={0} minWidth={0}>
        <Text size="caption" color={color} wrap="truncate-end">{title}</Text>
        {body}
      </Box>
    )
    const steps3 = track ? (
      <Box key="steps" flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={0}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box flexShrink={1} minWidth={0}><Svg source={segments(track.states, 240)} alt={`Step ${track.index} of ${track.total}`} height={5} /></Box>
          <Text size="caption" tabular dimColor>{`${track.index} of ${track.total}`}</Text>
        </Box>
        <Box flexDirection="row" columnGap={2}>
          {column('c-done', 'Done', GREEN, <Text size="footnote" dimColor wrap="truncate-end">{track.done === '' ? '–' : `✓ ${track.done}`}</Text>, 1)}
          {column('c-now', 'Now', YELLOW, <Text size="footnote" weight="semibold" wrap="truncate-end">{held ? 'Waiting on you' : track.now === '' ? 'All done' : track.now}</Text>, 1)}
          {column('c-next', 'Next', GREY, (
            <Box flexDirection="row" gap={1} minWidth={0}>
              <Box flexShrink={1} minWidth={0}><Text size="footnote" wrap="truncate-end">{track.next === '' ? '–' : track.next}</Text></Box>
              {track.more > 0 ? <Text size="caption" dimColor>{`+${track.more}`}</Text> : null}
            </Box>
          ), 1)}
        </Box>
      </Box>
    ) : (
      <Box key="steps" flexDirection="row" alignItems="center" gap={1} flexGrow={1} flexShrink={1} minWidth={0}>
        {status}
        <Box flexShrink={1} minWidth={0}><Text size="footnote" weight="semibold" wrap="truncate-end">{label}</Text></Box>
      </Box>
    )
    const main = (
      <Box key="main" flexDirection={stack ? 'column' : 'row'} alignItems={stack ? 'stretch' : 'center'} gap={stack ? 1 : 3}>
        {steps3}
        {rings}
      </Box>
    )
    const chipRow = chips.length > 0 ? <Box key="chips" flexDirection="row" flexWrap="wrap" columnGap={2}>{chips}</Box> : null
    const card = (
      <Box key="card" flexDirection="column" width="100%" borderStyle="round" borderDimColor paddingX={1} gap={1}>
        {main}
        {chipRow}
        {isOpen ? (
          <Box key="map" flexDirection={narrow ? 'column' : 'row'} alignItems="flex-end" gap={2}>
            <Svg source={drawMap(await read($, board), now, MAP)} alt={`Activity map. ${describeBoard(await read($, board))}`} width={240} height={224} />
            <Box flexDirection="column" gap={1} flexShrink={1} minWidth={0}>
              {details.map((d, i) => <Text key={`d${i}`} size="caption" dimColor wrap="truncate-end">{d}</Text>)}
              <Button key="cockpit-fullmap" plain label="Open full map" onPress={() => void quietly(() => openPane($, 'map'))} />
            </Box>
          </Box>
        ) : null}
      </Box>
    )

    // A card above (a delete, workers) folds this into the slim pill, so the numbers stay and the map waits.
    return (
      <Box flexDirection="column" width="100%" gap={1}>
        {above}
        {above.length > 0 ? island : card}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Link } = els
    // The terminal has no pictures: previews and the map are left out there.
    const Image = 'Image' in els ? els.Image : undefined
    const Svg = 'Svg' in els ? els.Svg : undefined
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
        {(['now', 'workers', 'outcomes', 'map'] as Tab[]).map(t => (
          <Button key={`tab-${t}`} variant={t === which ? 'primary' : 'secondary'} label={t === 'now' ? 'Now' : t === 'workers' ? 'Workers' : t === 'outcomes' ? 'Outcomes' : 'Map'} onPress={() => void quietly(() => update($, tab, () => t))} />
        ))}
      </Box>
    )
    const heading = (s: string) => <Text key={`h-${s}`} size="caption" weight="semibold" dimColor>{s.toUpperCase()}</Text>

    let body: RenderChildren
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
            {Image && o.path && previews.has(o.path) ? <Image source={{ png: previews.get(o.path)! }} columns={24} rows={8} alt={o.title} /> : null}
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
    } else if (which === 'map') {
      const b = await read($, board)
      const w = Math.min(460, Math.max(240, e.props.bodyColumns * 7))
      body = (
        <Box flexDirection="column" gap={1}>
          {Svg ? <Svg source={drawMap(b, now, { ...MAP, compact: false })} alt={`Activity map. ${describeBoard(b)}`} width={w} height={Math.round((w * 430) / 460)} /> : <Text dimColor>{describeBoard(b)}</Text>}
          {heading('Recent')}
          {[...b.entries].reverse().slice(0, 12).map(r => (
            <Box key={`m-${r.id}`} flexDirection="row" gap={1}>
              <Text size="footnote" color={r.status === 'run' ? BLUE : r.status === 'ok' ? GREEN : RED}>{r.status === 'run' ? '●' : r.status === 'ok' ? '✓' : '✕'}</Text>
              <Box width={9}><Text size="footnote" dimColor>{r.station}</Text></Box>
              <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="truncate-end">{r.label}</Text></Box>
            </Box>
          ))}
        </Box>
      )
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

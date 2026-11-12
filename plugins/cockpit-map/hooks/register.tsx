import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Entry, Seen, StationId, Status } from '../types'
import { MAP_SIZE, STATIONS, classify, clean, describeNow, drawMap, firstLine, foldRows, formatMs, hookRefusal, memoryIds, setupFrom, shortModel, stationSpots, tallyName, taskNotice, taskOf } from './map'
import type { Setup } from './map'

const PANE = 'cockpit-map'
const KEEP = 80
const CREW = 12
/** Width of the band's map in CSS pixels (the full map is 920). */
const BAND_MAP = 200
/** Width of the big view's map in CSS pixels; station buttons are placed by the same scale. */
const PANE_MAP = 380

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'cockpit-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-3' })

// Local change: what each station was used for this session, for the big view's lists.
const seen = atom({ plugin: 'cockpit-map', key: 'seen' } as const, {} as Seen)
const picked = atom({ plugin: 'cockpit-map', key: 'picked' } as const, null as StationId | null)
const SEEN_CAP = 60

async function tally($: EngineInterface, station: StationId, label: string, at: number, use: 0 | 1, failed: 0 | 1): Promise<void> {
  const name = tallyName(station, label)
  if (name === '') return
  await update($, seen, all => {
    const mine = { ...(all[station] ?? {}) }
    const was = mine[name]
    mine[name] = { n: (was?.n ?? 0) + use, last: use ? at : (was?.last ?? at), failed: (was?.failed ?? 0) + failed }
    const names = Object.keys(mine)
    if (names.length > SEEN_CAP) {
      const oldest = names.reduce((a, b) => ((mine[a]?.last ?? 0) <= (mine[b]?.last ?? 0) ? a : b))
      delete mine[oldest]
    }
    return { ...all, [station]: mine }
  })
}

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

/** The newest rows, and beside them every background task still going, however long ago it started. */
const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: newId(now),
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt ?? now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    await update($, board, b => ({
      ...b,
      ...start.patch,
      entries: kept([...b.entries, entry]),
      counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      // An interrupted turn lands on the person's own station and is no fault of anything.
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
        ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
        : {}),
    }))
    if (!start.uncounted) await tally($, entry.station, entry.label, now, 1, isFault(entry.status) && entry.station !== 'you' ? 1 : 0)
    return entry.id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    if (isFault(status)) {
      const was = (await read($, board)).entries.find(e => e.id === id && e.status === 'run')
      if (was !== undefined) await tally($, was.station, was.label, now, 0, 1)
    }
    await update($, board, b => {
      const open = b.entries.find(e => e.id === id && e.status === 'run')
      return {
        ...b,
        ...patch,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(open !== undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** The call started work that goes on after it answered: its row stays open under the task's id. */
async function background($: EngineInterface, id: string | undefined, task: string): Promise<void> {
  if (id === undefined) return
  await quietly(() => update($, board, b => ({ ...b, entries: b.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)) })))
}

/** A background task ended: its row closes, as a fault when the task failed. */
async function settle($: EngineInterface, task: string, status: Status): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    if (isFault(status)) {
      const was = (await read($, board)).entries.find(e => e.task === task && e.status === 'run')
      if (was !== undefined) await tally($, was.station, was.label, now, 0, 1)
    }
    await update($, board, b => {
      const open = b.entries.find(e => e.task === task && e.status === 'run')
      if (open === undefined) return b
      return {
        ...b,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  const { t } = setup
  // The feed's second column fits the longest station name of the language.
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'cockpit-map', description: t.command }))
    // Local change: no pane at start; the small map rides in the band above the prompt. /cockpit-map opens the big one.
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    return next(e)
  })

  on('command.run', { command: 'cockpit-map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.cannotOpen(String(opened.reason)) }
  })

  on('turn.start', async ($, e, next) => {
    const notice = e.agentId === undefined ? taskNotice(e.text) : undefined
    if (notice !== undefined) {
      // A background task reporting back is no message of the person's.
      if (notice.status !== undefined) await settle($, notice.id, notice.status)
    } else if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    try {
      return yield* next(e)
    } finally {
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled.
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          agents: (b.agents ?? []).filter(id => id !== agentId),
          entries: b.entries.map(x => (x.status === 'run' && (x.agentId === agentId || x.task === agentId) ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      const seen = classify(e.tool, e as unknown as Record<string, unknown>, setup)
      return begin($, { ...seen, ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    })
    try {
      const ran = await next(e)
      // A settings hook's refusal reaches here as the call's error; the hook itself is left alone.
      const reason = ran.isError === true ? hookRefusal(ran.text) : undefined
      const wasRefused = ran.deny !== undefined || reason !== undefined
      if (reason !== undefined) await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(reason) : '') || t.stopped(e.tool), status: 'block' })
      const task = wasRefused || ran.isError === true ? undefined : taskOf(ran.result)
      if (task !== undefined) {
        await background($, id, task)
        return ran
      }
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  // A notification delivered into a running turn starts no turn of its own; this is where it is seen.
  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => {
      if (e.origin?.kind !== 'task-notification') return
      const notice = taskNotice(e.text)
      if (notice?.status !== undefined) await settle($, notice.id, notice.status)
    })
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await update($, board, b => {
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === e.skill)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label: e.skill, from: 'core', startedAt: now, endedAt: now, status: 'ok' }
        return { ...b, entries: [...b.entries, entry].slice(-KEEP), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
      const listed = (await read($, seen)).skills?.[e.skill]
      if (listed === undefined || now - listed.last > 2000) await tally($, 'skills', e.skill, now, 1, 0)
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  // Local change: a small map at the left of the band, whatever the band holds beside it (session-hud's figures).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.surface === 'terminal' || e.props.hasSurvey) return next(e)
    const rest = await next(e)
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Svg, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center">
        <Box position="relative">
          <Svg source={drawMap(state, now, { ...setup, compact: true })} alt={`${t.title}. ${describeNow(state, t)}`} width={BAND_MAP} />
          <Box position="absolute" top={2} left={2}>
            <Button key="cockpit-map-expand" plain dimColor label="⤢" onPress={() => void quietly(() => $.ui.open({ id: PANE, title: t.title }))} />
          </Box>
        </Box>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>{rest}</Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const rows = foldRows(state.entries).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const line = `${mark} ${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}${took === '' ? '' : `  ${took}`}`
      return (
        <Text mono size="footnote" color={color} dimColor={entry.status === 'ok' && !isSwitch}>
          {line}
        </Text>
      )
    })
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>

    if (e.surface === 'terminal') {
      const tally = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${state.counts[s.id]}`).join(' · ')
      return (
        <Box flexDirection="column">
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }

    // Local change: the big view. Station names are buttons on the map; a row of them with counts below;
    // then what the picked station was used for this session.
    const { Svg, Button } = $.ui.resolve(e)
    const all = await read($, seen)
    const pick = await read($, picked)
    const k = PANE_MAP / MAP_SIZE.w
    const choose = (id: StationId) => () => void quietly(() => update($, picked, p => (p === id ? null : id)))
    const used = (id: StationId) => Object.values(all[id] ?? {}).reduce((sum, x) => sum + x.n, 0)

    const onMap = stationSpots(setup).map(spot => (
      <Box key={`at-${spot.id}`} position="absolute" left={Math.round(spot.x * k - 45)} top={Math.round((spot.y + MAP_SIZE.node + 2) * k)} width={90} flexDirection="row" justifyContent="center">
        <Button key={`map-${spot.id}`} plain dimColor={pick !== spot.id} label={t.stations[spot.id]} onPress={choose(spot.id)} />
      </Box>
    ))

    const chips = STATIONS.filter(st => used(st.id) > 0 || st.id === pick).map(st => (
      <Button key={`chip-${st.id}`} variant={st.id === pick ? 'primary' : undefined} onPress={choose(st.id)}>
        {t.stations[st.id]} <Text dimColor>{used(st.id)}</Text>
      </Button>
    ))

    const names = pick === null ? [] : Object.entries(all[pick] ?? {}).sort((a, b) => b[1].last - a[1].last).slice(0, 40)
    const list = pick === null ? (
      <Text dimColor size="footnote">{t.pickStation}</Text>
    ) : names.length === 0 ? (
      <Text dimColor size="footnote">{t.nothingAt(t.stations[pick])}</Text>
    ) : (
      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        {names.map(([name, x]) => (
          <Box key={`row-${name}`} flexDirection="row" justifyContent="space-between">
            <Text size="footnote" color={x.failed > 0 ? 'error' : undefined} wrap="truncate-end">{x.failed > 0 ? '✕ ' : ''}{name}</Text>
            <Text size="footnote" dimColor color={x.failed > 0 ? 'error' : undefined}>  ×{x.n}{x.failed > 0 ? ` · ${x.failed} failed` : ''} · {formatMs(Math.max(0, now - x.last), t)} {t.ago}</Text>
          </Box>
        ))}
      </Box>
    )

    return (
      <Box flexDirection="column">
        <Box key="big-map" position="relative" width={PANE_MAP} height={Math.round(MAP_SIZE.h * k)}>
          <Svg source={drawMap(state, now, { ...setup, labels: false })} alt={`${t.title}. ${describeNow(state, t)}`} width={PANE_MAP} height={Math.round(MAP_SIZE.h * k)} />
          {onMap}
        </Box>
        {current}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>{chips}</Box>
        {list}
        <Box flexDirection="column" marginTop={1}>{feed}</Box>
      </Box>
    )
  })
}

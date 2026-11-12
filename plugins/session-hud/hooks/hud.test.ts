import { expect, mock, test } from 'claude-code/testing'
import { ICONS } from './register'

const text = (node: unknown): string =>
  typeof node === 'string' ? node
    : Array.isArray(node) ? node.map(text).join('')
    : node && typeof node === 'object' ? text((node as { children?: unknown }).children ?? '') : ''

const PROPS = { hasSurvey: false, isWorking: true, maxRows: 4, bodyColumns: 120 }

test('desktop band shows steps, limits, context and cache', async ($, on) => {
  mock.clock(on)
  let next = 0
  on('tool.call', (_$, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++next) } } : {} }))
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('turn.complete', (_$, e) => ({}))
  // stands in for the engine's own drawing
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'engine default') })

  for (const subject of ['Write migration', 'Build pay service', 'Add query']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject, activeForm: `Doing ${subject}` })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Building shared pay service' })
  await $.session.measure({
    context: { tokens: 152_000, window: 1_000_000, percent: 15 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-03T16:10:00Z' },
      { kind: 'seven_day', percentUsed: 61 },
    ],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const drawn = text(await ui.drawn())
  for (const want of ['Step 2/3', 'Building shared pay service', '1 done', '2 left', 'engine default', '5-hour', '42%', 'resets', 'Weekly', '61%', 'Context', '15%', '152k used', 'Cache', 'till cold']) {
    expect(drawn).toContain(want)
  }
  const tree = JSON.stringify(await ui.drawn())
  expect(tree).toContain(ICONS.clock)
  expect(tree).toContain(ICONS.bolt)
  expect(/\p{Extended_Pictographic}\uFE0F|[\u{1F300}-\u{1FAFF}\u23F0-\u23FA]/u.test(tree)).toBe(false)
  await ui.unmount()

  const term = await $.ui.mount({ plugin: 'session-hud', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(text((await term.drawn()) ?? null)).not.toContain('Step 2/3')
})


test('the model name is gone from the band', async ($, on) => {
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '') })
  await $.session.measure({ context: { tokens: 1000, window: 1_000_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(text(await ui.drawn())).not.toContain('◆')
  await ui.unmount()
})

// Finds the element with this key in a drawn tree.
const byKey = (node: unknown, key: string): Record<string, unknown> | undefined => {
  if (!node || typeof node !== 'object') return undefined
  if (Array.isArray(node)) { for (const n of node) { const f = byKey(n, key); if (f) return f } return undefined }
  const o = node as Record<string, unknown>
  if (o.key === key || (o.props as Record<string, unknown> | undefined)?.key === key) return o
  for (const v of Object.values(o)) { const f = byKey(v, key); if (f) return f }
  return undefined
}
const GREEN = '#5fbf6a', YELLOW = '#e0b030', ORANGE = '#f08a24', RED = '#e5534b'

for (const [pct, colour, bordered] of [[30, GREEN, false], [60, YELLOW, false], [80, ORANGE, true], [95, RED, true]] as const) {
  test(`5-hour at ${pct}% is ${colour}${bordered ? ', border too' : ''}`, async ($, on) => {
    mock.clock(on)
    on('session.measure', (_$, e) => ({ changed: e.changed }))
    on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '') })
    await $.session.measure({ context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct }], changed: ['rateLimits'] })
    const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    const tile = JSON.stringify(byKey(await ui.drawn(), '5h'))
    expect(tile).toContain(`"color":"${colour}"`)
    expect(tile.includes(`"borderColor":"${colour}"`)).toBe(bordered)
    await ui.unmount()
  })
}

test('cache goes green, then orange in its last 10 minutes, then red when cold', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '') })
  await $.session.measure({ context: { tokens: 150_000, window: 1_000_000, percent: 15 }, rateLimits: [], changed: ['context'] })
  const cacheTile = async () => {
    const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    const t = JSON.stringify(byKey(await ui.drawn(), 'cache'))
    await ui.unmount()
    return t
  }
  expect(await cacheTile()).toContain(`"color":"${GREEN}"`)
  await clock.advance(55 * 60_000)
  const warn = await cacheTile()
  expect(warn).toContain(`"borderColor":"${ORANGE}"`)
  expect(warn).toContain('reply to keep')
  await clock.advance(6 * 60_000)
  const cold = await cacheTile()
  expect(cold).toContain(`"borderColor":"${RED}"`)
  expect(cold).toContain('cold')
})

test('with cacheMinutes 5 the cache goes cold after 5 minutes', { options: { cacheMinutes: '5' } }, async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '') })
  await $.session.measure({ context: { tokens: 1000, window: 1_000_000, percent: 1 }, rateLimits: [], changed: ['context'] })
  await clock.advance(6 * 60_000)
  const ui = await $.ui.mount({ plugin: 'session-hud', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const cache = JSON.stringify(byKey(await ui.drawn(), 'cache'))
  expect(cache).toContain(`"borderColor":"${RED}"`)
  expect(cache).not.toContain('till cold')
  await ui.unmount()
})

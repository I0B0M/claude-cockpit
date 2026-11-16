import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { EngineInterface } from 'claude-code'

type $T = Parameters<TestBody>[0]
type OnT = Parameters<TestBody>[1]

const BAND = { plugin: 'cockpit', component: 'AbovePrompt', props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} } } as const

const MEASURE = {
  context: { tokens: 184_000, window: 1_000_000, percent: 18 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 14, resetsAt: '2026-11-16T23:30:00Z' },
    { kind: 'seven_day', percentUsed: 5, resetsAt: '2026-11-20T17:00:00Z' },
  ],
  changed: ['context'],
} as never

const PLAN = {
  tool: 'mcp__ccd_turn__update_plan',
  items: [
    { content: 'Read band code', status: 'completed' },
    { content: 'Render scene 4 of 9', status: 'in_progress' },
    { content: 'Write tests', status: 'pending' },
  ],
} as never

async function busySession($: $T, on: OnT) {
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('tool.call', () => ({ result: {} }))
  await $.session.measure(MEASURE)
  await $.tool.call(PLAN)
}

const drawn = async (ui: { drawn: () => Promise<unknown> }) => JSON.stringify(await ui.drawn())

test('at rest: the step on top, four named numbers, no map', async ($, on) => {
  mock.clock(on)
  await busySession($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const json = await drawn(ui)
  for (const words of ['Render scene 4 of 9', '2 of 3', '18%', 'Context', '14%', '5-hour', '5%', 'Weekly']) expect(json).toContain(words)
  for (const words of ['"Done"', '"✓ Read band code"', '"Now"', '"Next"', '"Write tests"']) expect(json).toContain(words)
  expect(json).not.toContain('Open full map')
  expect(json).not.toContain('5-hour resets')
  expect(json).not.toContain('CLAUDE')
  await ui.unmount()
})

test('tapping the card slides the map in, in Cockpit colours with no box of its own; tapping again hides it', async ($, on) => {
  mock.clock(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }) as never)
  await busySession($, on)
  await $.turn.start({ text: 'Render the episode', turnId: 't1' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'cockpit-more' })
  const open = await drawn(ui)
  expect(open).toContain('Open full map')
  expect(open).toContain('CLAUDE')
  expect(open).toContain('Render scene 4 of 9')
  expect(open).toContain('5-hour resets')
  expect(open).not.toContain('#e1ac6e') // lot-map copper
  expect(open).not.toContain('#62c7ba') // lot-map teal
  expect(open).not.toContain('width=\\"460\\" height=\\"430\\" rx=\\"12\\"') // lot-map's own ground
  await ui.press({ key: 'cockpit-more' })
  expect(await drawn(ui)).not.toContain('CLAUDE')
  await ui.unmount()
})

test('a command lights the shell on the map in Cockpit blue', async ($, on) => {
  mock.clock(on)
  await busySession($, on)
  await $.tool.call({ tool: 'Bash', command: 'git status', description: 'Show status' } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'cockpit-more' })
  const open = await drawn(ui)
  expect(open).toContain('#0a84ff')
  expect(open).toContain('Shell')
  await ui.unmount()
})

test('a narrow band keeps context, 5-hour and weekly', async ($, on) => {
  mock.clock(on)
  await busySession($, on)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, bodyColumns: 50 } })
  const json = await drawn(ui)
  for (const words of ['18%', 'Context', '14%', '5-hour', '5%', 'Weekly']) expect(json).toContain(words)
  await ui.unmount()
})

test('the terminal and surveys are left alone', async ($, on) => {
  on('ui.render', (($: never, e: never) => { const { Text } = ($ as EngineInterface).ui.resolve(e) as { Text: never }; return h(Text, {}, 'below') }) as never)
  for (const [surface, hasSurvey] of [['terminal', false], ['desktop', true]] as const) {
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey } })
    expect(await drawn(ui)).not.toContain('Context')
    await ui.unmount()
  }
})

test('on battery under 30% a chip shows the level and says plug in', async ($, on) => {
  mock.clock(on)
  on('session.measure', () => ({ changed: ['context'] }) as never)
  on('command.register', () => ({ value: { command: 'x' } }))
  on('session.messages', () => ({ value: [] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000, percent: 18 }, rateLimits: [] } }) as never)
  on('fs.exists', () => ({ value: false }))
  on('process.run', (_, e) => ({
    value: { exitCode: 0, stderr: '', stdout: e.argv[0] === 'pmset' ? "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t24%; discharging; 1:02 remaining" : '' },
  }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true } as never)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const json = await drawn(ui)
  expect(json).toContain('24%')
  expect(json).toContain('Plug in')
  expect(json).not.toContain('Battery 24% · plug in')
  await ui.unmount()
})

// ── a held delete ───────────────────────────────────────────────────────────
function holdSession(on: OnT, ran: string[]) {
  on('session.cwd', () => ({ value: '/w' }) as never)
  on('process.run', (_, e) => {
    const tag = e.argv[3]
    // blast-radius measures the folder: 1,284 files, 2.1 GB, found. Cockpit asks git what is in no commit: all of it.
    const stdout = tag === 'blast-radius' ? '1284 2100000000 1\nframes/f0001.png\nframes/f0002.png' : tag === 'cockpit' ? '1284' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('tool.call', (_, e) => { ran.push(String((e as { command?: unknown }).command)); return { result: {} } as never })
}

test('a delete waits for you: Cancel refuses it before it runs, and the card says what lives only here', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[] = []
  holdSession(on, ran)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf frames', description: 'Delete frames' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const card = JSON.stringify(await ui.drawn())
  expect(card).toContain('cockpit-cancel')
  expect(card).toContain('Delete 1,284 files?')
  expect(card).toContain('in no commit: only on this Mac')
  await ui.press({ key: 'cockpit-cancel' })
  await clock.advance(300)
  const result = (await call) as { deny?: string }
  expect(result.deny).toContain('the user pressed Cancel')
  expect(result.deny).toContain('Do not retry it')
  expect(ran).not.toContain('rm -rf frames')
  await ui.unmount()
})

test('a delete you approve runs', async ($, on) => {
  const clock = mock.clock(on)
  const ran: string[] = []
  holdSession(on, ran)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf frames', description: 'Delete frames' } as never)
  await clock.settle()
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(JSON.stringify(await ui.drawn())).toContain('cockpit-delete')
  expect(ran).not.toContain('rm -rf frames')
  await ui.press({ key: 'cockpit-delete' })
  await clock.advance(300)
  await call
  expect(ran).toContain('rm -rf frames')
  await ui.unmount()
})

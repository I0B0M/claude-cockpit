import { expect, mock, test } from 'claude-code/testing'

// Local change: the small map rides in the band above the prompt, beside whatever else the band holds.
const BAND = { plugin: 'cockpit-map', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 120 } } as const

test('desktop band: small map at the left, the band underneath kept beside it', async ($, on) => {
  mock.clock(on)
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'figures from session-hud') })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('<svg')
  expect(drawn).toContain('figures from session-hud')
  expect(drawn).toContain('"width":200')
  expect(drawn).toContain('scale(1.5)')
  await ui.unmount()
})

test('terminal band and surveys are left alone', async ($, on) => {
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, 'below') })
  for (const [surface, hasSurvey] of [['terminal', false], ['desktop', true]] as const) {
    const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, hasSurvey } })
    expect(JSON.stringify(await ui.drawn())).not.toContain('<svg')
    await ui.unmount()
  }
})

const BIG = {
  plugin: 'cockpit-map',
  component: 'Pane',
  requestId: 'cockpit-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the band\'s expand button opens the big view', async ($, on) => {
  mock.clock(on)
  const opened: string[] = []
  on('ui.open', (_$, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return h(Text, {}, '') })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await ui.press({ key: 'cockpit-map-expand' })
  expect(opened).toContain('cockpit-map')
  await ui.unmount()
})

test('pressing a station lists what it was used for, failures marked; pressing again clears it', async ($, on) => {
  mock.clock(on)
  on('tool.call', (_$, e) => (e.tool === 'Bash' ? { result: {}, isError: true, text: 'boom' } : { result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })
  await $.tool.call({ tool: 'Bash', command: 'false', description: 'run the checks' })

  const ui = await $.ui.mount({ ...BIG, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Pick a station/ }))?.text).toBeDefined()

  await ui.press({ key: 'map-files' })
  expect((await ui.find({ type: 'Text', text: /b\/content\.py/ }))?.text).toContain('b/content.py')
  expect((await ui.find({ type: 'Text', text: /×2/ }))?.text).toContain('×2')

  await ui.press({ key: 'chip-shell' })
  expect((await ui.find({ type: 'Text', text: /run the checks/ }))?.text).toContain('✕')
  expect((await ui.find({ type: 'Text', text: /failed/ }))?.text).toContain('1 failed')

  await ui.press({ key: 'chip-shell' })
  expect((await ui.find({ type: 'Text', text: /Pick a station/ }))?.text).toBeDefined()
  await ui.unmount()
})

import { expect, test } from 'claude-code/testing'

import { applyPlan, classify, groupMade, parseCheck, parseModalCsv, parseNames, parsePmset, ring, segments, shownModal, stepTrack } from './model'

const bash = (command: string, text: string, isError = false) => classify({ tool: 'Bash', input: { command }, text, isError })

// ── outcomes: repos ─────────────────────────────────────────────────────────
test('a commit reads as its message and branch, in any repo', () => {
  const r = bash('git commit -m "Add map"', '[cockpit-island 0f62920] Add map\n 3 files changed')
  expect(r?.kind).toBe('commit')
  expect(r?.title).toBe('Committed "Add map"')
  expect(r?.detail).toBe('on cockpit-island')
})

test('searching the log for the word commit is not a commit', () => {
  expect(bash('git log --oneline --grep commit', 'e95b5e2 Filter new-file scan')).toBe(null)
})

test('a push names the branch; nothing to push is no result', () => {
  expect(bash('git push -u origin feat', 'To github.com:I0B0M/x.git\n * [new branch]      feat -> feat')?.title).toBe('Pushed feat')
  expect(bash('git push', 'Everything up-to-date')).toBe(null)
})

test('a PR opened and merged on GitHub', () => {
  const opened = bash('gh pr create --title x --body y', 'https://github.com/I0B0M/pov-pipeline/pull/512\n')
  expect(opened?.title).toBe('Opened PR #512')
  expect(opened?.detail).toBe('I0B0M/pov-pipeline')
  expect(bash('gh pr merge 512 --squash', '✓ Merged')?.title).toBe('Merged PR #512')
})

// ── outcomes: tickets and projects ──────────────────────────────────────────
test('GitHub issues and the pipeline ticket script are tickets', () => {
  expect(bash('gh issue comment 220 --body x', 'https://github.com/I0B0M/pov-pipeline/issues/220#issuecomment-1')?.title).toBe('Commented on ticket #220')
  expect(bash('python3 tools/ticket.py close 451', 'closed')?.title).toBe('Ticket #451: close')
})

test('a Linear ticket written through its connector is a ticket; reading one is not', () => {
  const saved = classify({ tool: 'mcp__claude_ai_Linear__save_issue', input: { id: 'ARC-123', title: 'Fix the logo' }, text: 'https://linear.app/x/issue/ARC-123', isError: false })
  expect(saved?.kind).toBe('ticket')
  expect(saved?.title).toBe('Updated ARC-123')
  expect(saved?.href).toBe('https://linear.app/x/issue/ARC-123')
  const comment = classify({ tool: 'mcp__claude_ai_Linear__create_comment', input: { issueId: 'ARC-5', body: 'x' }, text: '', isError: false })
  expect(comment?.title).toBe('Commented on ARC-5')
  expect(classify({ tool: 'mcp__claude_ai_Linear__list_issues', input: {}, text: '', isError: false })).toBe(null)
})

// ── outcomes: things made ───────────────────────────────────────────────────
test('a published page and a written deliverable are results; a code edit is not', () => {
  const page = classify({ tool: 'Artifact', input: { file_path: '/s/cockpit/index.html', description: 'The resting card' }, text: 'Published at https://claude.ai/artifact/P1kSyaBoybJ2uwYHuBmsSQ (Version 11)', isError: false })
  expect(page?.kind).toBe('published')
  expect(page?.href).toBe('https://claude.ai/artifact/P1kSyaBoybJ2uwYHuBmsSQ')
  expect(classify({ tool: 'Write', input: { file_path: '/v/thumb_A.png' }, text: '', isError: false })?.kind).toBe('made')
  expect(classify({ tool: 'Write', input: { file_path: '/repo/hooks/register.tsx' }, text: '', isError: false })).toBe(null)
})

// ── outcomes: checks ────────────────────────────────────────────────────────
test('a test run with a failure is a failed check, with its counts', () => {
  const r = bash('pytest -q', '12 passed, 1 failed in 3.2s', true)
  expect(r?.kind).toBe('check')
  expect(r?.ok).toBe(false)
  expect(r?.title).toBe('Tests failed: 1 failed, 12 passed')
})

test('runners in every common spelling count as checks', () => {
  expect(bash('npm test', 'Tests: 30 passed, 30 total')?.title).toBe('Tests passed: 30 passed')
  expect(bash('claude plugin test .', '52 pass\n0 fail')?.title).toBe('Tests passed: 52 passed')
  expect(bash('cd web && npx eslint src', '')?.title).toBe('Lint passed')
  expect(bash('python3 tools/script_lint.py videos/x', 'ok')?.title).toBe('Lint passed')
})

test('reading, listing or searching a test file is not a check', () => {
  expect(bash('sed -n 1,60p hooks/band.test.tsx', 'import { expect }')).toBe(null)
  expect(bash('cat tests/test_api.py | head', 'def test_x(): pass')).toBe(null)
  expect(bash('grep -rn "lint" docs', 'docs/a.md: lint')).toBe(null)
  expect(bash('ls tests', 'test_api.py')).toBe(null)
})

test('check counts read from common runners', () => {
  expect(parseCheck('52 pass\n0 fail')).toEqual({ passed: 52, failed: 0, errors: null })
  expect(parseCheck('Found 3 errors in 2 files.')).toEqual({ passed: null, failed: null, errors: 3 })
  expect(parseCheck('all good')).toBe(null)
})

test('many files in one folder are one result', () => {
  const frames = Array.from({ length: 120 }, (_, i) => `/v/frames/f${i}.png`)
  const out = groupMade([...frames, '/v/render.mp4'])
  expect(out).toEqual([
    { title: '120 png files', detail: 'v/frames', path: '/v/frames', count: 120 },
    { title: 'render.mp4', detail: 'v', path: '/v/render.mp4', count: 1 },
  ])
})

// ── the task list ───────────────────────────────────────────────────────────
test('the plan list follows items, advance, done and start', () => {
  let list = applyPlan([], { items: [{ content: 'Read', status: 'in_progress' }, { content: 'Build', status: 'pending' }, { content: 'Test', status: 'pending' }] })
  expect(list.map(s => s.status)).toEqual(['in_progress', 'pending', 'pending'])
  list = applyPlan(list, { advance: true })
  expect(list.map(s => s.status)).toEqual(['completed', 'in_progress', 'pending'])
  list = applyPlan(list, { done: [2], start: 3 })
  expect(list.map(s => s.status)).toEqual(['completed', 'completed', 'in_progress'])
})

// ── battery and Modal ───────────────────────────────────────────────────────
test('pmset on battery and on power', () => {
  expect(parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t24%; discharging; 1:02 remaining")).toEqual({ percent: 24, onBattery: true })
  expect(parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging;")).toEqual({ percent: 80, onBattery: false })
})

test('Modal spend sums this month per named account and skips unnamed rows', () => {
  const csv = [
    'date,what,video,jobs,worst_usd,a,b,c,d,profile',
    '2026-11-03,render,v1,4,3.50,,,,,profileA',
    '2026-11-09,render,v2,2,1.25,,,,,profileA',
    '2026-11-10,render,v3,1,9.00,,,,,profileB',
    '2026-10-30,render,v0,1,7.00,,,,,profileA',
    '2026-11-11,old row,v4,1,5.00',
  ].join('\n')
  expect(parseModalCsv(csv, '2026-11', parseNames(['profileA=A', 'profileB=B']))).toEqual({ A: 4.75, B: 9 })
})

// ── the resting card ────────────────────────────────────────────────────────
const S = (subject: string, status: 'completed' | 'in_progress' | 'pending') => ({ id: subject, subject, status })

test('the step track: last done, now, the first next and how many more', () => {
  const list = [S('a', 'completed'), S('b', 'completed'), S('c', 'completed'), S('d', 'in_progress'), S('e', 'pending'), S('f', 'pending'), S('g', 'pending')]
  expect(stepTrack(list)).toEqual({ done: 'c', now: 'd', next: 'e', more: 2, index: 4, total: 7, states: ['completed', 'completed', 'completed', 'in_progress', 'pending', 'pending', 'pending'] })
})

test('the step track before any step starts, and when all are done', () => {
  expect(stepTrack([S('a', 'pending'), S('b', 'pending')])).toMatchObject({ done: '', now: 'a', next: 'b', more: 0, index: 1 })
  expect(stepTrack([S('a', 'completed'), S('b', 'completed')])).toMatchObject({ done: 'b', now: '', next: '', more: 0, index: 2 })
  expect(stepTrack([])).toBe(null)
})

test('the colour bar: green done, yellow now, grey next', () => {
  const svg = segments(['completed', 'in_progress', 'pending'], 120)
  expect(svg.match(/<rect /g)?.length).toBe(3)
  expect(svg.indexOf('#30d158')).toBeLessThan(svg.indexOf('#ffd60a'))
  expect(svg).toContain('#8e8e9340')
})

test('big rings are drawn thick, small ones stay thin', () => {
  expect(ring(40, '#30d158', 30)).toContain('stroke-width="4.5"')
  expect(ring(40, '#30d158', 14)).toContain('stroke-width="2"')
})

test('Modal shows only while a Modal job runs, whatever the spend', () => {
  expect(shownModal({ A: 21, B: 3 }, 0)).toEqual([])
  expect(shownModal({ A: 21, B: 0 }, 1)).toEqual([['A', 21]])
})

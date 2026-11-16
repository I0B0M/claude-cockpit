export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the task list, from the app's plan tool or the terminal's task tools. */
export type Step = { id: string; subject: string; status: StepStatus }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = { contextPercent: number | null; contextTokens: number | null; limits: Limit[] }

export type Cache = { lastReplyAt: number; hit: number | null; size: number | null }

export type WorkerStatus = 'run' | 'done' | 'failed'

/** A subagent: what it is, what it is doing now, and what it came back with. */
export type Worker = {
  id: string
  name: string
  model: string
  status: WorkerStatus
  startedAt: number
  endedAt?: number
  /** What it is doing now, in a few words ("writing story2.md"). */
  now?: string
  /** The first line of its answer once it is done. */
  result?: string
  cost: number
}

export type OutcomeKind = 'made' | 'published' | 'commit' | 'push' | 'pr' | 'ticket' | 'sent' | 'session' | 'check'

/** One result of the work, never code: a file made, a page published, a PR, a ticket, a check that ran. */
export type Outcome = {
  id: string
  kind: OutcomeKind
  title: string
  detail?: string
  href?: string
  path?: string
  ok: boolean
  at: number
  task: number
}

/** One request of the person's: from their message to the next one. */
export type Task = { n: number; ask: string; startedAt: number; endedAt?: number; recap?: string; left?: string[] }

/** A delete held for an answer. */
export type Hold = {
  command: string
  title: string
  summary: string
  lines: string[]
  more: number
  /** Files under the targets in no commit (untracked, ignored or changed); null when not measured. */
  onlyHere: number | null
  note?: string
}

export type Extras = {
  /** Files this task edited that are not committed. */
  dirty: number
  battery: { percent: number; onBattery: boolean } | null
  /** This month's Modal spend per account name, from the project's docs/modal-spend.csv. */
  modal: Record<string, number>
  modalRunning: number
}

export type Tab = 'now' | 'workers' | 'outcomes'

declare module 'claude-code' {
  interface PluginState {
    cockpit: {
      steps: Step[]
      usage: Usage | null
      cache: Cache | null
      tick: number
      open: boolean
      workers: Worker[]
      outcomes: Outcome[]
      tasks: Task[]
      hold: Hold | null
      extras: Extras
      tab: Tab
      viewTask: number | null
      held: { at: number; title: string; answer: string }[]
    }
  }
}

export type Step = { id: string; subject: string; activeForm: string; status: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Usage = { contextPercent: number | null; contextTokens: number | null; limits: Limit[] }
export type Cache = { lastReplyAt: number; hit: number | null; size: number | null }

declare module 'claude-code' {
  interface PluginState {
    'session-hud': {
      steps: Step[]
      usage: Usage | null
      cache: Cache | null
      tick: number
    }
  }
}

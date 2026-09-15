import { ToolError } from "@flintd/core"
import type { Flint } from "@flintd/core"

const DAY_MS = 86_400_000
const CHECK_MS = 60_000
const STOP_GRACE_MS = 2000

export interface ObserverScheduleOptions {
  // How long the daemon must have run no call before an observer run may start.
  idleMs: number
  everyMs?: number
  checkMs?: number
  // How long stop() waits for a run in flight before it leaves it to the Flint's own stop.
  stopGraceMs?: number
  clock?: () => number
  onLog?: (said: string) => void
}

export interface ObserverSchedule {
  stop(): Promise<void>
}

// Daily, and only while the daemon is idle: the Observer reads every Library and asks the model, and a busy
// daemon has better uses for both. The first run comes one whole period after the daemon started.
export function startObserver(flint: Flint, options: ObserverScheduleOptions): ObserverSchedule {
  const clock = options.clock ?? Date.now
  const everyMs = options.everyMs ?? DAY_MS
  const checkMs = options.checkMs ?? CHECK_MS
  const stopGraceMs = options.stopGraceMs ?? STOP_GRACE_MS
  let since = clock()
  let busy = false
  // The run in flight, not the last tick: stop() has to wait for the work and not for the check that found none.
  let pending: Promise<void> = Promise.resolve()
  let stopped = false

  async function idle(): Promise<boolean> {
    const entries = await flint.library()
    const times = entries
      .map((entry) => (entry.lastCallAt === null ? Number.NaN : Date.parse(entry.lastCallAt)))
      .filter((at) => Number.isFinite(at))
    return times.length === 0 || clock() - Math.max(...times) >= options.idleMs
  }

  // Nothing here may throw: the timer drops the promise, and an unhandled rejection would end the daemon.
  async function tick(): Promise<void> {
    if (stopped || busy || clock() - since < everyMs) return
    busy = true
    try {
      if (!(await idle())) return
      since = clock()
      pending = flint.observer.run().then((done) => {
        options.onLog?.(
          `observer: ${done.candidates.length} candidates, ${done.drafts.length} drafts, ${done.refusals.length} refused, ${done.retirements.length} retirement proposals`,
        )
      })
      await pending
    } catch (cause) {
      options.onLog?.(`observer: the run did not finish: ${cause instanceof ToolError ? cause.message : String(cause)}`)
    } finally {
      busy = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, checkMs)
  timer.unref()

  return {
    // Only the Flint's own stop() cancels a run, so this waits a grace and then leaves the run to it.
    async stop(): Promise<void> {
      stopped = true
      clearInterval(timer)
      let timeout: NodeJS.Timeout | undefined
      await Promise.race([
        pending.catch(() => undefined),
        new Promise<void>((wake) => {
          timeout = setTimeout(wake, stopGraceMs)
          timeout.unref()
        }),
      ])
      clearTimeout(timeout)
    },
  }
}

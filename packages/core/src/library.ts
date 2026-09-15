import { ToolError, causeMessage } from "./errors.ts"
import { loadEngine } from "./engine.ts"
import type { Engine, EngineOptions } from "./engine.ts"
import { scanLibrary } from "./gate.ts"
import { lockLibrary } from "./lock.ts"
import type { LibraryLock } from "./lock.ts"
import type { ExecutionLimits } from "./quickjs.ts"
import { createStore } from "./store.ts"
import type { IndexedTool, Store, StoreSync } from "./store.ts"
import type { InvalidTool, LibraryKind, LibraryStatus, ReviewEntry } from "./types.ts"

export interface LibraryPlan {
  kind: LibraryKind
  dir: string
  remote: string | undefined
  syncTimeoutMs: number
}

// Every touch of the Tool files takes its turn: two writes collide on the repository lock, and a read between the four files of a write sees half of it.
export interface WriteQueue {
  serialize<T>(action: () => Promise<T>): Promise<T>
  settled(): Promise<void>
}

export interface OpenLibrary {
  kind: LibraryKind
  store: Store
  engine: Engine
  queue: WriteQueue
  invalid: InvalidTool[]
  remote: string | null
  error: string | null
  pushing: Promise<void> | undefined
  pushAgain: boolean
  // Raised while the turn in flight runs a Body and has written nothing, so a Tool that turn called reads the Library without a turn of its own.
  proving: number
  // The lower-case names a create has taken and not yet written, so a second create of one is refused before it proves an Example.
  creating: Set<string>
  rescan(): Promise<void>
}

export interface Winner {
  tool: IndexedTool
  library: OpenLibrary
}

export interface Closable {
  library: OpenLibrary
  close(): Promise<void>
}

export async function openLibrary(
  plan: LibraryPlan,
  engineOptions: Omit<EngineOptions, "libraryDir">,
  limits: ExecutionLimits,
): Promise<Closable> {
  // The lock comes before the repository: two flintds that start together must not both run `git init`.
  const lock = await lockLibrary(plan.dir)
  const store = createStore(plan.dir)
  let engine: Engine | undefined
  try {
    engine = await loadEngine({ ...engineOptions, libraryDir: plan.dir })
    const running = engine
    const opened = await store.open({ remote: plan.remote, syncTimeoutMs: plan.syncTimeoutMs })
    const library: OpenLibrary = {
      kind: plan.kind,
      store,
      engine: running,
      queue: writeQueue(),
      invalid: [],
      remote: opened.remote,
      error: opened.error,
      pushing: undefined,
      pushAgain: false,
      proving: 0,
      creating: new Set<string>(),
      rescan: async () => {
        const found = await scanLibrary(store, running, limits, (action) => whileProving(library, action))
        library.invalid = found.map((entry) => ({ ...entry, library: plan.kind }))
      },
    }
    await library.rescan()
    // The sync merge and the file channel both commit outside the write queue, so start() sends what they wrote.
    if (opened.remote !== null && opened.error === null && (await store.sync?.ahead()) === true) {
      await pushLibrary(library)
    }
    return { library, close: () => release(library, lock) }
  } catch (cause) {
    await engine?.close()
    await store.close()
    await lock.release()
    throw cause
  }
}

export async function whileProving<T>(library: OpenLibrary, action: () => Promise<T>): Promise<T> {
  library.proving += 1
  try {
    return await action()
  } finally {
    library.proving -= 1
  }
}

function writeQueue(): WriteQueue {
  let turns: Promise<unknown> = Promise.resolve()
  return {
    serialize<T>(action: () => Promise<T>): Promise<T> {
      const next = turns.then(action)
      turns = next.catch(() => undefined)
      return next
    },
    async settled(): Promise<void> {
      let last = turns
      for (;;) {
        await last.catch(() => undefined)
        if (turns === last) return
        last = turns
      }
    },
  }
}

async function release(library: OpenLibrary, lock: LibraryLock): Promise<void> {
  await library.engine.close()
  await library.store.close()
  await lock.release()
}

// One push per Library at a time, and one more when a write lands during it: a push holds no lock and waits on a network.
export function pushLibrary(library: OpenLibrary): Promise<void> {
  if (library.remote === null) return Promise.resolve()
  if (library.pushing !== undefined) {
    library.pushAgain = true
    return library.pushing
  }
  library.pushing = drain(library)
  return library.pushing
}

export async function pushSettled(library: OpenLibrary): Promise<void> {
  while (library.pushing !== undefined) await library.pushing
}

async function drain(library: OpenLibrary): Promise<void> {
  try {
    do {
      library.pushAgain = false
      await attempt(library)
    } while (library.pushAgain)
  } finally {
    library.pushing = undefined
  }
}

async function attempt(library: OpenLibrary): Promise<void> {
  const sync = library.store.sync
  if (sync === undefined) return
  try {
    await sync.push()
    library.error = null
  } catch (cause) {
    library.error = sync.stale(cause) ? await catchUp(library, sync) : failedPush(library, cause)
  }
}

// The remote holds a Version this Library never saw. Take it inside the write queue, gate what arrived, and send again.
async function catchUp(library: OpenLibrary, sync: StoreSync): Promise<string | null> {
  return library.queue.serialize(async () => {
    try {
      await sync.pull()
      await library.rescan()
      await sync.push()
      return null
    } catch (cause) {
      return failedPush(library, cause)
    }
  })
}

function failedPush(library: OpenLibrary, cause: unknown): string {
  return `push to ${String(library.remote)}: ${causeMessage(cause)}`
}

export function broken(library: OpenLibrary, name: string): InvalidTool | undefined {
  return library.invalid.find((entry) => entry.name.toLowerCase() === name.toLowerCase())
}

export function holds(library: OpenLibrary, name: string): boolean {
  return library.store.get(name) !== undefined || broken(library, name) !== undefined
}

export function holder(libraries: readonly OpenLibrary[], name: string): OpenLibrary | undefined {
  return libraries.find((library) => holds(library, name))
}

export function named(libraries: readonly OpenLibrary[], kind: LibraryKind): OpenLibrary {
  const found = libraries.find((library) => library.kind === kind)
  if (found === undefined) {
    throw new ToolError(
      "not_found",
      `This flintd holds no ${kind} Library, so a call cannot name one. Leave meta.library out to use the ${libraries[0]?.kind ?? "user"} Library.`,
      { library: kind },
    )
  }
  return found
}

export function winners(libraries: readonly OpenLibrary[]): Winner[] {
  const taken = new Set<string>()
  const found: Winner[] = []
  for (const library of libraries) {
    for (const entry of library.invalid) taken.add(entry.name.toLowerCase())
    for (const tool of library.store.all()) {
      const key = tool.name.toLowerCase()
      if (taken.has(key)) continue
      taken.add(key)
      found.push({ tool, library })
    }
  }
  return found.sort((left, right) => left.tool.name.localeCompare(right.tool.name))
}

export function callable(libraries: readonly OpenLibrary[]): Winner[] {
  return winners(libraries).filter(({ tool }) => tool.state !== "retired")
}

export function review(libraries: readonly OpenLibrary[]): ReviewEntry[] {
  return libraries.flatMap((library) =>
    library.store
      .all()
      .filter((tool) => tool.needs_review && broken(library, tool.name) === undefined)
      .map((tool) => ({ name: tool.name, library: library.kind })),
  )
}

export function summary(library: OpenLibrary): LibraryStatus {
  const all = library.store.all().filter((tool) => broken(library, tool.name) === undefined)
  return {
    library: library.kind,
    dir: library.store.dir,
    tools: all.filter((tool) => tool.state !== "retired").length,
    retired: all.filter((tool) => tool.state === "retired").length,
    remote: library.remote,
    error: library.error,
  }
}

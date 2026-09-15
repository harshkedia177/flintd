import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { ToolError, causeMessage } from "./errors.ts"

export const LOCK_FILE = "flintd.lock"

export interface LibraryLock {
  release(): Promise<void>
}

export async function lockLibrary(dir: string): Promise<LibraryLock> {
  const path = join(dir, LOCK_FILE)
  await mkdir(dir, { recursive: true }).catch((cause: unknown) => {
    throw new ToolError("store_error", `The Library directory ${dir} could not be made.`, { reason: causeMessage(cause) })
  })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await claim(path)) {
      return {
        async release(): Promise<void> {
          if ((await holder(path)) === process.pid) await rm(path, { force: true })
        },
      }
    }
    const pid = await holder(path)
    if (pid !== null && running(pid)) throw held(dir, pid)
    await reclaim(dir, path)
  }
  throw held(dir, (await holder(path)) ?? 0)
}

async function claim(path: string): Promise<boolean> {
  const temp = `${path}.${process.pid}.${randomUUID()}`
  return guard(path, async () => {
    await writeFile(temp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 })
    try {
      // link fails when the lock exists, and it puts the pid there whole, never as an empty file another claim could read.
      await link(temp, path)
      return true
    } catch (cause) {
      const code = errno(cause)
      if (code === "EEXIST") return false
      if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
        throw new ToolError(
          "store_error",
          `The Library lock at ${path} needs a hard link, and this filesystem refused one (${code}). Put the Library on a filesystem that makes hard links.`,
          { path, reason: code },
        )
      }
      throw cause
    } finally {
      await rm(temp, { force: true })
    }
  })
}

// rename is atomic, so of two processes that both read a dead pid only one takes the lock file away.
async function reclaim(dir: string, path: string): Promise<void> {
  const stale = `${path}.stale.${randomUUID()}`
  const moved = await guard(path, async () => {
    try {
      await rename(path, stale)
      return true
    } catch (cause) {
      if (errno(cause) === "ENOENT") return false
      throw cause
    }
  })
  if (!moved) return
  const pid = await holder(stale)
  const alive = pid !== null && running(pid)
  if (alive) await link(stale, path).catch(() => undefined)
  await rm(stale, { force: true })
  if (alive) throw held(dir, pid as number)
}

async function holder(path: string): Promise<number | null> {
  const text = await readFile(path, "utf8").catch(() => "")
  try {
    const pid: unknown = (JSON.parse(text) as { pid?: unknown }).pid
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    // EPERM says the process exists and belongs to somebody else, so the Library is still held.
    return errno(cause) === "EPERM"
  }
}

async function guard<T>(path: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (cause) {
    if (cause instanceof ToolError) throw cause
    throw new ToolError("store_error", `The Library lock at ${path} could not be taken.`, {
      reason: causeMessage(cause),
    })
  }
}

function held(dir: string, pid: number): ToolError {
  return new ToolError(
    "dir_in_use",
    `The Library at ${dir} is already open in process ${pid}. Stop that flintd, or point this one at another directory.`,
    { dir, pid },
  )
}

function errno(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null ? (cause as { code?: string }).code : undefined
}

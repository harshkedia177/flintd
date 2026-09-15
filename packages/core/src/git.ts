import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { ToolError, causeMessage } from "./errors.ts"

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 5_000
// An ssh remote can ask for a passphrase or a host key long after git's own prompt is off; the operator's own setting wins.
const SSH_COMMAND = "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new"
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024
const FIELD = "\u001f"
const IDENTITY = [
  "-c",
  "user.name=flintd",
  "-c",
  "user.email=flintd@localhost",
  "-c",
  "commit.gpgsign=false",
]

export interface Written {
  version: string
  tree: string
}

export interface CommitEntry {
  id: string
  timestamp: string
  subject: string
}

export async function ensureRepository(dir: string): Promise<void> {
  try {
    await access(join(dir, ".git"))
    return
  } catch {
    await git(dir, ["init", "-b", "main"])
  }
}

export async function commit(dir: string, paths: string[], message: string, tree: string): Promise<Written> {
  await git(dir, ["add", "--", ...paths])
  await git(dir, [...IDENTITY, "commit", "-m", message, "--", ...paths])
  const [version = "", written = ""] = lines(await git(dir, ["rev-parse", "HEAD", `HEAD:${tree}`], false))
  return { version, tree: written }
}

export async function remoteUrl(dir: string): Promise<string | null> {
  const url = await git(dir, ["remote", "get-url", "origin"]).catch(() => "")
  return url === "" ? null : url
}

export async function setRemote(dir: string, url: string): Promise<void> {
  const current = await remoteUrl(dir)
  if (current === url) return
  await git(dir, ["remote", current === null ? "add" : "set-url", "origin", url])
}

export async function branchName(dir: string): Promise<string> {
  const branch = await git(dir, ["branch", "--show-current"])
  if (branch === "") {
    throw new ToolError("store_error", `The Library repository at ${dir} has no branch checked out.`, { dir })
  }
  return branch
}

export async function fetchOrigin(dir: string, timeoutMs: number): Promise<void> {
  await git(dir, ["fetch", "--quiet", "origin"], true, timeoutMs)
}

export async function pushOrigin(dir: string, branch: string, timeoutMs: number): Promise<void> {
  await git(dir, ["push", "--quiet", "origin", branch], true, timeoutMs)
}

export async function unpushed(dir: string, branch: string): Promise<boolean> {
  const remote = `refs/remotes/origin/${branch}`
  const known = (await revision(dir, remote).catch(() => null)) !== null
  const count = await git(dir, ["rev-list", "--count", known ? `${remote}..HEAD` : "HEAD"]).catch(() => "0")
  return count !== "0"
}

export async function mergeBase(dir: string, left: string, right: string): Promise<string | null> {
  return git(dir, ["merge-base", left, right]).catch(() => null)
}

export async function fastForward(dir: string, ref: string): Promise<void> {
  await git(dir, ["merge", "--ff-only", "--quiet", ref])
}

export async function mergeNoCommit(dir: string, ref: string): Promise<void> {
  // Two Libraries that were filled before either pulled share no commit, and their Tool directories must still meet.
  await git(dir, ["merge", "--no-commit", "--no-ff", "--allow-unrelated-histories", "--quiet", ref]).catch(
    async (cause: unknown) => {
      // A merge that stops on a conflict exits non-zero and leaves the unmerged paths behind, which is the answer we want.
      if ((await unmergedPaths(dir).catch(() => [])).length === 0) throw cause
    },
  )
}

export async function unmergedPaths(dir: string): Promise<string[]> {
  return lines(await git(dir, ["diff", "--name-only", "--diff-filter=U"], false))
}

export async function checkoutOurs(dir: string, paths: string[]): Promise<void> {
  await git(dir, ["checkout", "--ours", "--", ...paths])
}

export async function stage(dir: string, paths: string[]): Promise<void> {
  await git(dir, ["add", "--", ...paths])
}

export async function commitMerge(dir: string, message: string): Promise<void> {
  await git(dir, [...IDENTITY, "commit", "--quiet", "-m", message])
}

export async function abortMerge(dir: string): Promise<void> {
  await git(dir, ["merge", "--abort"]).catch(() => undefined)
}

export async function unstage(dir: string, paths: string[]): Promise<void> {
  await git(dir, ["reset", "--quiet", "--", ...paths])
}

export async function clean(dir: string, paths: string[]): Promise<void> {
  await git(dir, ["clean", "-f", "-d", "-q", "--", ...paths])
}

export async function statusEntries(dir: string, path: string): Promise<string[]> {
  // -z keeps a non-ASCII path unquoted, and every entry still starts with two status characters and a space.
  const out = await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all", "--", path], false)
  return out.split("\0").filter((entry) => entry !== "")
}

export async function lsTree(dir: string, ref: string): Promise<string[]> {
  return lines(await git(dir, ["ls-tree", ref], false))
}

// This is not the credential registry of redact.ts: the password is in the text flintd is about to write, not in a set it holds.
function withoutPassword(text: string): string {
  return text.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]*@/g, "$1")
}

function lines(out: string): string[] {
  return out.split("\n").filter((line) => line !== "")
}

export async function tracked(dir: string, path: string): Promise<boolean> {
  return (await git(dir, ["ls-files", "--", path])) !== ""
}

export async function revision(dir: string, rev: string): Promise<string> {
  return git(dir, ["rev-parse", "--verify", rev])
}

export async function log(dir: string, path: string, from: string | undefined, limit: number): Promise<CommitEntry[]> {
  const range = from === undefined ? [] : [from]
  // --full-history keeps the Versions of both sides of a sync merge, which path simplification would drop.
  const out = await git(dir, [
    "log",
    "--full-history",
    `--max-count=${limit}`,
    "--format=%H%x1f%cI%x1f%s",
    ...range,
    "--",
    path,
  ])
  if (out === "") return []
  return out.split("\n").map((line) => {
    const [id = "", timestamp = "", subject = ""] = line.split(FIELD)
    return { id, timestamp, subject }
  })
}

export async function show(dir: string, id: string, path: string): Promise<string> {
  return git(dir, ["show", `${id}:${path}`], false)
}

async function git(dir: string, args: string[], trim = true, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd: dir,
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      env: { GIT_SSH_COMMAND: SSH_COMMAND, ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    })
    return trim ? stdout.trim() : stdout
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT") {
      throw new ToolError("store_error", "git is not on the PATH, and flintd keeps every Library in a git repository.")
    }
    throw new ToolError("store_error", `The Library repository at ${dir} refused \`git ${withoutPassword(args.join(" "))}\`.`, {
      reason: withoutPassword(causeMessage(cause)),
    })
  }
}

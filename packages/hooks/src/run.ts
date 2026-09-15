import { adapt, isHookHarness } from "./adapt.ts"
import { HOOK_TIMEOUT_MS, postObservation } from "./post.ts"
import { hookSettings } from "./settings.ts"

const MAX_PAYLOAD_BYTES = 1_048_576

// A hook never blocks the harness and never writes to stdout, because a harness reads what a hook prints as a decision.
export async function runHook(argv: string[], input: NodeJS.ReadableStream = process.stdin): Promise<void> {
  try {
    const harness = argv[0]
    if (!isHookHarness(harness)) throw new Error(`${JSON.stringify(argv[0] ?? "")} is not a harness this hook knows`)
    const settings = await hookSettings(harness)
    const observation = adapt(harness, await payload(input), settings.transcripts)
    if (observation === undefined) return
    await postObservation(settings.url, settings.token, observation)
  } catch (cause) {
    // stderr and never stdout: the harness shows this line only when the operator asks it to.
    process.stderr.write(`flintd-hook: ${cause instanceof Error ? cause.message : String(cause)}\n`)
  }
}

async function payload(input: NodeJS.ReadableStream): Promise<unknown> {
  const text = await read(input)
  if (text.trim() === "") return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function read(input: NodeJS.ReadableStream & { destroy?: () => void }): Promise<string> {
  // A harness that starts the hook with no pipe leaves stdin open for ever, so the read has the same clock the POST has.
  if ((input as NodeJS.ReadStream).isTTY === true) return Promise.resolve("")
  return new Promise<string>((done) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (): void => {
      clearTimeout(timer)
      input.removeListener("data", onData)
      input.removeListener("end", finish)
      input.removeListener("error", finish)
      // The handle goes too: a harness that holds the pipe open would otherwise keep this process alive with it.
      input.destroy?.()
      done(Buffer.concat(chunks).toString("utf8"))
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_PAYLOAD_BYTES) return finish()
      chunks.push(buffer)
    }
    const timer = setTimeout(finish, HOOK_TIMEOUT_MS)
    timer.unref()
    input.on("data", onData)
    input.once("end", finish)
    input.once("error", finish)
  })
}

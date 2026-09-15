import { parentPort } from "node:worker_threads"
import { ToolError, causeMessage } from "./errors.ts"
import { loadQuickJS } from "./quickjs.ts"
import type { Executor } from "./quickjs.ts"
import type { ExecuteRequest, HostCallName, SerializedError, WorkerCommand, WorkerMessage } from "./engine.ts"
import type { JsonValue, ToolErrorCode } from "./types.ts"

interface Answer {
  ok(value: JsonValue): void
  fail(code: ToolErrorCode, message: string): void
}

const port = parentPort
const answers = new Map<number, Answer>()
let nextCall = 1

if (port !== null) {
  let executor: Executor | undefined
  // The worker environment carries no credentials, so an environment at all means this Worker was started wrong.
  const carried = Object.keys(process.env).length
  if (carried > 0) {
    send({ type: "unavailable", error: serialize(startedWrong(carried)) })
  } else {
    try {
      executor = await loadQuickJS()
    } catch (cause) {
      send({ type: "unavailable", error: serialize(cause) })
    }
  }
  if (executor !== undefined) {
    const ready = executor
    port.on("message", (command: WorkerCommand) => {
      if (command.type === "execute") {
        void execute(ready, command.request)
        return
      }
      const waiting = answers.get(command.call)
      if (waiting === undefined) return
      answers.delete(command.call)
      if (command.type === "host-result") waiting.ok(command.value)
      else waiting.fail(command.code, command.message)
    })
    send({ type: "ready" })
  }
}

async function execute(executor: Executor, request: ExecuteRequest): Promise<void> {
  try {
    send({ type: "result", id: request.id, token: request.token, value: await executor.run(request, host(request)) })
  } catch (cause) {
    send({ type: "failure", id: request.id, token: request.token, error: serialize(cause) })
  } finally {
    // The answer to a host call of a finished request never arrives, so nothing may wait for it.
    answers.clear()
  }
}

function startedWrong(carried: number): ToolError {
  return new ToolError(
    "worker_unavailable",
    `The flintd executor started with ${carried} environment entries, and a Body must never run beside a credential.`,
    { entries: carried },
  )
}

function host(request: ExecuteRequest): (name: HostCallName, argument: JsonValue) => Promise<JsonValue> {
  return (name, argument) =>
    new Promise<JsonValue>((resolve, reject) => {
      const call = nextCall++
      answers.set(call, { ok: resolve, fail: (code, message) => reject(new ToolError(code, message)) })
      send({ type: "host", id: request.id, token: request.token, call, name, argument })
    })
}

function send(message: WorkerMessage): void {
  port?.postMessage(message)
}

function serialize(cause: unknown): SerializedError {
  if (cause instanceof ToolError) return cause.toJSON()
  return { code: "internal_error", message: causeMessage(cause), details: {} }
}

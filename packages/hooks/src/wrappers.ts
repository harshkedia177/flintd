export interface HookCommand {
  command: string
  args: string[]
}

// The three harnesses that load code rather than run a program get a file that normalizes their own shape and pipes
// it to the same binary, so the reading of a payload lives in one place.
export function openCodePlugin(hook: HookCommand): string {
  return `${header()}import { spawn } from "node:child_process"

const COMMAND = ${json(hook.command)}
const ARGS = ${json([...hook.args, "opencode"])}
const seen = new Map()

function send(record) {
  try {
    const child = spawn(COMMAND, ARGS, { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(JSON.stringify(record))
  } catch {}
}

export const FlintdObserver = async () => ({
  "tool.execute.before": async (input, output) => {
    seen.set(input?.callID ?? input?.tool, Object.keys(output?.args ?? {}))
  },
  "tool.execute.after": async (input, output) => {
    const key = input?.callID ?? input?.tool
    const args = {}
    for (const name of seen.get(key) ?? []) args[name] = null
    seen.delete(key)
    send({
      tool: input?.tool ?? "",
      session: input?.sessionID ?? null,
      args,
      status: output?.metadata?.error === undefined ? "ok" : "error",
    })
  },
  event: async ({ event }) => {
    if (event?.type === "session.created") send({ tool: "session.created", session: null, args: {}, status: "ok" })
  },
})
`
}

export function hermesPlugin(hook: HookCommand): string {
  return `${header("#")}import json
import subprocess

COMMAND = ${json([hook.command, ...hook.args, "hermes"])}


def _send(record):
    try:
        child = subprocess.Popen(COMMAND, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child.communicate(json.dumps(record).encode("utf-8"), timeout=2)
    except Exception:
        pass


def register(ctx):
    def on_tool_call(tool_name, params, result):
        _send(
            {
                "tool": tool_name or "",
                "session": None,
                "args": dict.fromkeys(params) if isinstance(params, dict) else {},
                "status": "error" if isinstance(result, dict) and result.get("success") is False else "ok",
            }
        )

    def on_session_start(session_id=None, **kwargs):
        del kwargs
        _send({"tool": "on_session_start", "session": session_id, "args": {}, "status": "ok"})

    ctx.register_hook("post_tool_call", on_tool_call)
    ctx.register_hook("on_session_start", on_session_start)
`
}

export function hermesManifest(): string {
  return `name: flintd
version: "1.0"
description: Forwards what Hermes ran to the flintd daemon.
`
}

export function openClawHook(hook: HookCommand): string {
  return `${header()}import { spawn } from "node:child_process"

const COMMAND = ${json(hook.command)}
const ARGS = ${json([...hook.args, "openclaw"])}

export default async function flintd(event: { type?: string; sessionEntry?: { id?: string } }): Promise<void> {
  try {
    const child = spawn(COMMAND, ARGS, { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.on("error", () => {})
    child.stdin.end(
      JSON.stringify({
        tool: event?.type ?? "command:new",
        session: event?.sessionEntry?.id ?? null,
        args: {},
        status: "ok",
      }),
    )
  } catch {}
}
`
}

export function openClawHookDoc(): string {
  return `---
name: flintd
description: "Forwards what OpenClaw ran to the flintd daemon"
metadata:
  { "openclaw": { "events": ["command:new", "command:reset"] } }
---

# flintd

Sends one Observation to the local flintd daemon when a conversation starts or is reset. OpenClaw fires no event
for a tool call, so this hook records the session and nothing else.
`
}

function header(mark = "//"): string {
  return `${mark} Written by \`flintd init\`. Edit the flintd config, not this file: a later init writes it again.\n`
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

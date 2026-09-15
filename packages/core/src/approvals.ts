import { createHash, randomUUID } from "node:crypto"
import { ToolError } from "./errors.ts"
import { isEmptyManifest, manifestHash, manifestSummary, tierFor } from "./manifest.ts"
import type { Store } from "./store.ts"
import type { Approval, ApprovalKey, JsonValue, Manifest, Tier, Tool } from "./types.ts"

type Declared = Pick<Tool, "name" | "manifest">

// A decision is about the Body a person read as much as about the Manifest, so both name the row.
export function approvalKey(manifest: Manifest, body: string): ApprovalKey {
  return { manifestHash: manifestHash(manifest), bodyDigest: createHash("sha256").update(body).digest("hex") }
}

// The row the Tool declares now, worked out and not written: the decision this exact pair already carries is inherited.
export function plannedApproval(
  store: Store,
  tool: Declared,
  body: string,
  version: string | null,
  requester: string | null,
): Approval | undefined {
  if (isEmptyManifest(tool.manifest)) return undefined
  const key = approvalKey(tool.manifest, body)
  const held = store.approval(tool.name, key)
  return {
    ...key,
    id: held?.id ?? randomUUID(),
    tool: tool.name,
    // The save writes the Version this asked for; a request raised before the save keeps the one it already had.
    version: version ?? held?.version ?? null,
    manifest: tool.manifest,
    summary: manifestSummary(tool.manifest),
    status: held?.status ?? "pending",
    requester: held?.requester ?? requester,
    requestedAt: held?.requestedAt ?? new Date().toISOString(),
    decidedBy: held?.decidedBy ?? null,
    decidedAt: held?.decidedAt ?? null,
    note: held?.note ?? null,
  }
}

// One live Approval per Tool: the one for the Manifest and the Body it declares now.
export function requestApproval(
  store: Store,
  tool: Declared,
  body: string,
  version: string | null,
  requester: string | null,
): Approval | undefined {
  const planned = plannedApproval(store, tool, body, version, requester)
  if (planned === undefined) {
    // An empty Manifest asks for nothing, so no row is live; the decisions this Tool already carries stay for a restore.
    store.clearLiveApproval(tool.name)
    return undefined
  }
  return store.putApproval(planned)
}

// Until one person approves the Manifest the answer is nothing, so an unapproved Body touches no file, reaches no host and runs no command.
export function grantedRun(
  store: Store,
  tool: Declared,
  body: string,
): { manifest: Manifest; tier: Tier } {
  const tier = tierFor(tool.name, tool.manifest, body)
  if (granted(store, tool, body)) return { manifest: tool.manifest, tier }
  // Taking the capabilities away must not take the runtime away with them: a Body of the Node or the container tier
  // proves in the Node tier, where Buffer and the ten builtins are, and an empty Manifest is what makes it reach nothing.
  return { manifest: {}, tier: tier === "quickjs" ? "quickjs" : "node" }
}

// Anything else is granted only by a row that says so: a pair with no row at all is a pair nobody has decided on, and it reaches nothing.
export function granted(store: Store, tool: Declared, body: string): boolean {
  if (isEmptyManifest(tool.manifest)) return true
  return store.approval(tool.name, approvalKey(tool.manifest, body))?.status === "approved"
}

// The sentence a Tool whose Examples need what its Manifest asks for has to read: the save stood, and the proof waits.
export function deferredAdvice(approval: Approval, indices: readonly number[]): string {
  const which = indices.length === 1 ? `Example ${indices[0]}` : `Examples ${indices.join(", ")}`
  return `${which} could not run, because this Tool's Manifest asks to ${approval.summary} and flintd runs no Body with what a Manifest asks for until one person approves it. The Tool is saved as a Draft and ${indices.length === 1 ? "that Example is" : "those Examples are"} deferred. Run \`flintd approvals approve ${approval.tool}\`: flintd runs every Example again with the Manifest in force, and only then does the Tool go on to its Held-out run.`
}

export function liveApproval(store: Store, tool: Declared, body: string): Approval | undefined {
  if (isEmptyManifest(tool.manifest)) return undefined
  return store.approval(tool.name, approvalKey(tool.manifest, body))
}

// An empty Manifest needs no Approval; anything else runs only on one that says "approved".
export function assertApproved(store: Store, tool: Declared, body: string): void {
  if (granted(store, tool, body)) return
  // A pair with no row is a request nobody has seen, so the refusal writes it rather than answer about nothing.
  const approval = liveApproval(store, tool, body) ?? requestApproval(store, tool, body, null, null)
  if (approval !== undefined) throw awaitingApproval(approval)
}

export function awaitingApproval(approval: Approval): ToolError {
  const denied = approval.status === "denied"
  const next = denied
    ? `It was denied${approval.note === null ? "" : `: ${approval.note}`}. Change the Manifest with tool_update so the Tool asks for less, or ask again for the decision to be changed with \`flintd approvals approve ${approval.tool}\`.`
    : `Nobody has decided yet. Run \`flintd approvals approve ${approval.tool}\` to grant it, or \`flintd approvals deny ${approval.tool}\` to refuse it.`
  return new ToolError(
    "awaiting_approval",
    `The Tool ${JSON.stringify(approval.tool)} declares a Manifest, and a Manifest runs only after one person approves it. It asks to ${approval.summary}. ${next}`,
    {
      name: approval.tool,
      approval: approval.id,
      status: approval.status,
      manifest: approval.manifest as unknown as JsonValue,
      summary: approval.summary,
    },
  )
}

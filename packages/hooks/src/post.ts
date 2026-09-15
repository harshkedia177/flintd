import type { HookObservation } from "./adapt.ts"

// A hook runs inside the harness's own turn, so the daemon gets half a second and the turn gets everything else.
export const HOOK_TIMEOUT_MS = 500

export async function postObservation(url: string, token: string, observation: HookObservation): Promise<void> {
  const response = await fetch(`${url.replace(/\/+$/, "")}/api/v1/observations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(observation),
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  })
  // The body is read and thrown away, because a connection nobody drains stays open past the process.
  await response.text()
  if (!response.ok) throw new Error(`the daemon answered ${response.status}`)
}

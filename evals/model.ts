import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ModelProvider } from "@flintd/core"

const KEY_FILE = join(homedir(), ".flintd", "eval.env")

// USD per million tokens, read from the provider's own pricing page on 2026-09-14.
// OpenAI: https://developers.openai.com/api/docs/pricing (the gpt-5.1 to gpt-5.6 rows re-read 2026-09-14)
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
const PRICES: Record<string, { input: number; output: number }> = {
  "gpt-5-nano": { input: 0.05, output: 0.4 },
  "gpt-5-mini": { input: 0.25, output: 2 },
  "gpt-5": { input: 1.25, output: 10 },
  "gpt-5.1": { input: 1.25, output: 10 },
  "gpt-5.2": { input: 1.75, output: 14 },
  "gpt-5.4-nano": { input: 0.2, output: 1.25 },
  "gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "gpt-5.4": { input: 2.5, output: 15 },
  "gpt-5.5": { input: 5, output: 30 },
  "gpt-5.5-pro": { input: 30, output: 180 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-terra": { input: 2, output: 12 },
  "gpt-5.6-sol": { input: 4, output: 20 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
}

const UPSTREAM: Record<ModelProvider, string> = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
}

const DEFAULT_MODEL: Record<ModelProvider, string> = {
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-5",
}

export interface Credentials {
  provider: ModelProvider
  apiKey: string
  upstream: string
  // What the provider wants beside the key, and what the meter adds on the way out: never written anywhere.
  headers: Record<string, string>
}

export interface Price {
  input: number
  output: number
}

export function defaultModel(provider: ModelProvider): string {
  return DEFAULT_MODEL[provider]
}

// What a harness needs in its environment to speak to the meter instead of the provider, or null where none does.
export function providerEnv(provider: ModelProvider, base: string, apiKey: string): Record<string, string> {
  return provider === "anthropic"
    ? { ANTHROPIC_BASE_URL: base, ANTHROPIC_API_KEY: apiKey }
    : { OPENAI_BASE_URL: `${base}/v1`, OPENAI_API_KEY: apiKey }
}

export function providerFrom(value: string | undefined): ModelProvider {
  if (value === undefined || value === "" || value === "openai") return "openai"
  if (value === "anthropic") return "anthropic"
  throw new Error(`EVAL_PROVIDER is "openai" or "anthropic", and it is ${JSON.stringify(value)}.`)
}

export async function readCredentials(provider: ModelProvider): Promise<Credentials> {
  const file = await readFile(KEY_FILE, "utf8").catch(() => "")
  const held = envFile(file)
  const named = (key: string): string | undefined => {
    const fromEnvironment = process.env[key]
    return fromEnvironment !== undefined && fromEnvironment !== "" ? fromEnvironment : held[key]
  }
  const keyName = provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"
  const apiKey = named(keyName)
  if (apiKey === undefined || apiKey === "") {
    throw new Error(`No ${keyName}. Put it in ${KEY_FILE} (mode 0600) or in the environment, and run the evals again.`)
  }
  const headers: Record<string, string> = {}
  if (provider === "openai") {
    const org = named("OPENAI_ORG_ID")
    const project = named("OPENAI_PROJECT_ID")
    if (org !== undefined) headers["openai-organization"] = org
    if (project !== undefined) headers["openai-project"] = project
    headers["authorization"] = `Bearer ${apiKey}`
  } else {
    headers["x-api-key"] = apiKey
    headers["anthropic-version"] = "2023-06-01"
  }
  return { provider, apiKey, upstream: UPSTREAM[provider], headers }
}

// The model the run uses has to be one the provider serves now, so the list is read rather than assumed.
export async function resolveModel(credentials: Credentials, asked: string | undefined): Promise<string> {
  const wanted = asked ?? process.env["EVAL_MODEL"] ?? DEFAULT_MODEL[credentials.provider]
  const served = await modelIds(credentials)
  if (served.includes(wanted)) return wanted
  throw new Error(
    `The provider ${credentials.provider} does not serve ${JSON.stringify(wanted)}. It serves: ${served.join(", ")}.`,
  )
}

export function priceOf(model: string): Price | null {
  const keys = Object.keys(PRICES)
    .filter((key) => model === key || model.startsWith(`${key}-`))
    .sort((left, right) => right.length - left.length)
  const best = keys[0]
  return best === undefined ? null : (PRICES[best] as Price)
}

export function costOf(model: string, input: number, output: number): number | null {
  const price = priceOf(model)
  if (price === null) return null
  return (input * price.input + output * price.output) / 1_000_000
}

export function usd(amount: number | null): string {
  return amount === null ? "unpriced" : `$${amount.toFixed(4)}`
}

async function modelIds(credentials: Credentials): Promise<string[]> {
  const response = await fetch(`${credentials.upstream}/v1/models?limit=1000`, {
    headers: credentials.headers,
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await response.json().catch(() => ({}))) as { data?: { id?: unknown }[] }
  if (!response.ok || !Array.isArray(body.data)) {
    throw new Error(`${credentials.upstream}/v1/models answered ${response.status} and no model list.`)
  }
  return body.data.map((one) => String(one.id)).sort()
}

function envFile(text: string): Record<string, string> {
  const held: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "" || trimmed.startsWith("#")) continue
    const cut = trimmed.indexOf("=")
    if (cut < 1) continue
    const value = trimmed.slice(cut + 1).trim()
    held[trimmed.slice(0, cut).trim()] = value.replace(/^(['"])(.*)\1$/, "$2")
  }
  return held
}

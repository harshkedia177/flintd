import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// tsc rewrites an import specifier and never a `new URL("./worker.ts", import.meta.url)`, and Node refuses to strip
// types under node_modules, so a published Worker and a published tier child have to be named as the .js they are.
const dir = fileURLToPath(new URL("../dist/", import.meta.url))
const RUNTIME_URL = /(new URL\("\.\/[\w-]+)\.ts("\s*,\s*import\.meta\.url)/g

for (const file of await readdir(dir, { recursive: true })) {
  if (!file.endsWith(".js")) continue
  const path = join(dir, file)
  const text = await readFile(path, "utf8")
  const rewritten = text.replace(RUNTIME_URL, "$1.js$2")
  if (rewritten !== text) await writeFile(path, rewritten)
}

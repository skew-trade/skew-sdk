import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

// The package's surface: two entry points, the app's (".") and the maker's ("./maker"), and what
// each of them reaches.

const SRC = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8")) as { exports: Record<string, unknown> }

/** The source module of an entry point: "./dist/maker.js" is src/maker.ts. */
function source(entry: string): string {
  const e = pkg.exports[entry] as { default: string; types: string }
  assert.equal(e.types, e.default.replace(/\.js$/u, ".d.ts"), `${entry}: its types are its module's`)
  return join(SRC, e.default.replace(/^\.\/dist\//u, "").replace(/\.js$/u, ".ts"))
}

/** Every module a module reaches through relative imports and re-exports, types included. */
function reach(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen
  seen.add(file)
  for (const m of readFileSync(file, "utf8").matchAll(/\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/gu)) {
    const target = resolve(dirname(file), m[1]!)
    reach(target.endsWith(".ts") ? target : `${target}.ts`, seen)
  }
  return seen
}

describe("the package", () => {
  it("exports the app SDK and the maker SDK, and nothing else", () => {
    assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./maker", "./package.json"])
  })

  it("keeps them apart: the app's entry never reaches the maker's, the maker's none of the app's own modules", () => {
    const app = reach(source("."))
    const maker = reach(source("./maker"))
    assert.equal(app.has(join(SRC, "maker.ts")), false)
    for (const own of ["helduser.ts", "rest.ts", "markets.ts", "markets-core.ts"]) assert.equal(maker.has(join(SRC, own)), false, own)
  })

  it("has no module that no entry point reaches", () => {
    const reached = new Set([...reach(source(".")), ...reach(source("./maker"))])
    for (const f of readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))) {
      assert.ok(reached.has(join(SRC, f)), `${f} is reached by no entry point`)
    }
  })
})

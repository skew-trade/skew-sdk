// The last step of `npm run build`: every relative import specifier tsc wrote into dist/ gets its
// file extension ("./hl" -> "./hl.js", "./gen" -> "./gen/index.js"), which Node's ESM loader
// needs and every bundler accepts. Usage: node scripts/esm-specifiers.mjs dist
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const specifier = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.{1,2}\/[^"']*)\2/gu

function withExtension(file, spec) {
  if (/\.(?:js|mjs|cjs|json)$/u.test(spec)) return spec
  const base = resolve(dirname(file), spec)
  if (existsSync(`${base}.js`)) return `${spec}.js`
  if (existsSync(join(base, "index.js"))) return `${spec}/index.js`
  throw new Error(`${file}: cannot resolve ${spec}`)
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      walk(p)
    } else if (p.endsWith(".js") || p.endsWith(".d.ts")) {
      const text = readFileSync(p, "utf8")
      const out = text.replace(specifier, (_m, lead, q, spec) => `${lead}${q}${withExtension(p, spec)}${q}`)
      if (out !== text) writeFileSync(p, out)
    }
  }
}

const dir = process.argv[2]
if (!dir) throw new Error("usage: node scripts/esm-specifiers.mjs DIR")
walk(resolve(dir))

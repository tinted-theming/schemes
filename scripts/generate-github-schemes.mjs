#!/usr/bin/env node
// Regenerate the GitHub base16 / base24 schemes from @primer/primitives.
//
// Sources (single pinned npm dependency, see package.json):
//   - Grays (base00..07) + black/white  ->  src json5 `base.color.neutral.*`
//     (the literal "neutral scale"), resolved per theme through the
//     parent + @extends override file chain, following {ref} pointers.
//   - Accents (base08..0F, base12..17)  ->  the already-resolved CSS custom
//     properties in dist (`--ansi-*` etc.), which bake in all per-variant
//     (dimmed / high-contrast / colorblind) layering for us.
//
// Everything below the CONFIG block is mechanical; tune the CONFIG to change
// which upstream color feeds which scheme slot.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSON5 from 'json5'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'node_modules', '@primer', 'primitives')
const SRC = path.join(PKG, 'src', 'tokens', 'base', 'color')
const DIST = path.join(PKG, 'dist', 'css', 'functional', 'themes')
const AUTHOR = 'Tinted Theming (https://github.com/tinted-theming)'

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────

// The 7 GitHub themes we generate. `theme` is both the primer dist CSS file
// name AND (for non-default themes) the override key. `base` is the src json5
// neutral file chain (parent first, override last).
const THEMES = [
  { file: 'github',                       name: 'Github',                       variant: 'light', theme: 'light',               base: ['light/light'] },
  { file: 'github-dark',                  name: 'Github Dark',                  variant: 'dark',  theme: 'dark',                base: ['dark/dark'] },
  { file: 'github-light-high-contrast',   name: 'Github Light High Contrast',   variant: 'light', theme: 'light-high-contrast', base: ['light/light', 'light/light.high-contrast'] },
  { file: 'github-dark-high-contrast',    name: 'Github Dark High Contrast',    variant: 'dark',  theme: 'dark-high-contrast',  base: ['dark/dark', 'dark/dark.high-contrast'] },
  { file: 'github-dark-dimmed',           name: 'Github Dark Dimmed',           variant: 'dark',  theme: 'dark-dimmed',         base: ['dark/dark', 'dark/dark.dimmed'] },
  { file: 'github-light-colorblind',      name: 'Github Light Colorblind',      variant: 'light', theme: 'light-colorblind',    base: ['light/light'] },
  { file: 'github-dark-colorblind',       name: 'Github Dark Colorblind',       variant: 'dark',  theme: 'dark-colorblind',     base: ['dark/dark'] },
]

// base00..07 monotone ramp = these neutral-scale steps (bg -> fg), per polarity.
// Light goes lightest..darkest; dark goes darkest..lightest.
const MONO_STEPS = {
  light: [0, 1, 6, 8, 9, 10, 12, 13],
  dark:  [1, 2, 6, 8, 9, 11, 12, 13],
}

// Accent slots -> resolved dist CSS custom property (without the leading `--`).
// Two philosophies, selectable with `--mode`:
//
//   prettylights  (default) — map GitHub's *code syntax* (prettylights) colors
//     onto base16's semantic roles, so a base16 highlighter reproduces GitHub's
//     editor view. This is the original "match GitHub code highlighting" goal.
//
//   ansi — map GitHub's *terminal* (ANSI) palette by hue (base08=red, etc).
//     Matches GitHub's terminal colors; the editor view diverges.
//
// Neither GitHub palette defines a "class" gold (base0A) — both fall back to
// ANSI yellow (brown in light, gold in dark) and it's flagged. The base24
// bright slots have no syntax/prettylights analogue, so they always use ANSI
// bright variants.
const BRIGHTS = {
  base12: 'ansi-redBright',
  base13: 'ansi-yellowBright',
  base14: 'ansi-greenBright',
  base15: 'ansi-cyanBright',
  base16: 'ansi-blueBright',
  base17: 'ansi-magentaBright',
}
const ACCENT_MODES = {
  prettylights: {
    base08: 'prettylights-syntax-variable',   // variables
    base09: 'prettylights-syntax-constant',   // constants / numbers
    base0A: 'fgColor-attention',               // classes — GitHub 'attention' gold (no true syntax eqv)
    base0B: 'prettylights-syntax-string',     // strings
    base0C: 'prettylights-syntax-stringRegexp',// regex / escapes
    base0D: 'prettylights-syntax-entity',     // functions / entities
    base0E: 'prettylights-syntax-keyword',    // keywords
    base0F: 'prettylights-syntax-bracketHighlighterUnmatched',
    ...BRIGHTS,
  },
  ansi: {
    base08: 'ansi-red',
    base09: 'prettylights-syntax-variable',   // orange — ANSI has none
    base0A: 'fgColor-attention',               // GitHub 'attention' gold
    base0B: 'ansi-green',
    base0C: 'ansi-cyan',
    base0D: 'ansi-blue',
    base0E: 'ansi-magenta',
    base0F: 'ansi-redBright',
    ...BRIGHTS,
  },
}
const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]) || 'prettylights'
if (!ACCENT_MODES[MODE]) { console.error(`unknown --mode=${MODE} (use prettylights|ansi)`); process.exit(1) }
const ACCENT_VARS = ACCENT_MODES[MODE]

const BASE16_SLOTS = ['base00','base01','base02','base03','base04','base05','base06','base07',
                      'base08','base09','base0A','base0B','base0C','base0D','base0E','base0F']
const BASE24_SLOTS = [...BASE16_SLOTS,
                      'base10','base11','base12','base13','base14','base15','base16','base17']

// ─────────────────────────────────────────────────────────────────────────
// src json5 neutral-scale resolver
// ─────────────────────────────────────────────────────────────────────────

function deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k]) &&
        target[k] && typeof target[k] === 'object') {
      deepMerge(target[k], source[k])
    } else {
      target[k] = source[k]
    }
  }
  return target
}

// Returns base.color.* tree for a theme (parent merged with @extends overrides).
function loadColorTree(baseChain) {
  const tree = {}
  for (const rel of baseChain) {
    const file = path.join(SRC, `${rel}.json5`)
    const parsed = JSON5.parse(fs.readFileSync(file, 'utf8'))
    deepMerge(tree, parsed.base.color)
  }
  return tree
}

// Resolve a base.color dotted path (e.g. "neutral.9", "black") to a hex string.
function resolveColor(tree, dottedPath, seen = new Set()) {
  if (seen.has(dottedPath)) throw new Error(`ref cycle at ${dottedPath}`)
  seen.add(dottedPath)
  let node = tree
  for (const part of dottedPath.split('.')) node = node?.[part]
  if (!node || !('$value' in node)) throw new Error(`missing token base.color.${dottedPath}`)
  const v = node.$value
  if (typeof v === 'object' && v.hex) return v.hex
  if (typeof v === 'string') {
    const m = v.match(/^\{base\.color\.(.+)\}$/)
    if (!m) throw new Error(`unexpected ref ${v}`)
    return resolveColor(tree, m[1], seen)
  }
  throw new Error(`unresolvable $value for base.color.${dottedPath}`)
}

// ─────────────────────────────────────────────────────────────────────────
// dist CSS var map
// ─────────────────────────────────────────────────────────────────────────

function loadCssVars(theme) {
  const css = fs.readFileSync(path.join(DIST, `${theme}.css`), 'utf8')
  const raw = {}
  for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]+|var\(--[\w-]+\))\s*;/g)) {
    const key = m[1].toLowerCase()
    if (!(key in raw)) raw[key] = m[2]
  }
  const resolve = (name, depth = 0) => {
    const val = raw[name.toLowerCase()]
    if (val === undefined) throw new Error(`missing CSS var --${name} in ${theme}.css`)
    const ref = val.match(/^var\(--([\w-]+)\)$/)
    if (ref) { if (depth > 5) throw new Error(`var() too deep for --${name}`); return resolve(ref[1], depth + 1) }
    return val
  }
  return resolve
}

// ─────────────────────────────────────────────────────────────────────────
// generate
// ─────────────────────────────────────────────────────────────────────────

const norm = (hex) => hex.toLowerCase()

function buildPalette(t) {
  const tree = loadColorTree(t.base)
  const cssVar = loadCssVars(t.theme)
  const p = {}

  // base00..07 from the neutral scale
  MONO_STEPS[t.variant].forEach((step, i) => {
    p[`base0${i}`] = norm(resolveColor(tree, `neutral.${step}`))
  })

  // accents
  for (const [slot, varName] of Object.entries(ACCENT_VARS)) {
    p[slot] = norm(cssVar(varName))
  }

  // base24 extra backgrounds: base10 near-black, base11 pure black
  p.base10 = norm(resolveColor(tree, 'black'))
  p.base11 = '#000000'

  return p
}

function toYaml(t, palette, slots) {
  const lines = [
    `system: "${t.system}"`,
    `name: "${t.name}"`,
    `author: "${AUTHOR}"`,
    `variant: "${t.variant}"`,
    'palette:',
    ...slots.map((s) => `  ${s}: "${palette[s]}"`),
  ]
  return lines.join('\n') + '\n'
}

const OUT = (process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]) || ROOT
// Optional filename/name suffix (e.g. --suffix=-test for A/B comparisons) and
// theme filter (e.g. --themes=github-dark,github-dark-dimmed).
const SUFFIX = (process.argv.find((a) => a.startsWith('--suffix='))?.split('=')[1]) || ''
const ONLY = (process.argv.find((a) => a.startsWith('--themes='))?.split('=')[1])?.split(',')

let written = 0
for (const t of THEMES) {
  if (ONLY && !ONLY.includes(t.file)) continue
  const palette = buildPalette(t)
  for (const system of ['base16', 'base24']) {
    const slots = system === 'base16' ? BASE16_SLOTS : BASE24_SLOTS
    // The light default is named "Github" in base16 but "Github Light" in base24,
    // matching the pre-existing files; every other scheme shares one name.
    let name = (system === 'base24' && t.theme === 'light') ? 'Github Light' : t.name
    if (SUFFIX) name += ` (${SUFFIX.replace(/^-/, '')})`
    const out = toYaml({ ...t, system, name }, palette, slots)
    const dir = path.join(OUT, system)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${t.file}${SUFFIX}.yaml`), out)
    written++
  }
}
console.log(`[mode=${MODE}] ${written} files generated under ${OUT}`)

#!/usr/bin/env node
/**
 * Re-vendor the career-ops System Layer into runtime/.
 *
 *   node scripts/refresh-runtime.mjs                 # latest upstream release
 *   node scripts/refresh-runtime.mjs --ref v1.40.0   # a tag or commit
 *   node scripts/refresh-runtime.mjs --modes de fr   # also ship those market modes
 *   node scripts/refresh-runtime.mjs --dry-run
 *
 * It keeps the two plugin-side adaptations (runtime/dsh-liveness.mjs is ours and is
 * never deleted; generate-pdf.mjs gets its lazy-Playwright patch re-applied), and
 * prints the upstream version + commit to paste into THIRD-PARTY-NOTICES.md.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const RUNTIME = path.join(ROOT, 'runtime')
let CACHE = path.join(ROOT, '.runtime-cache', 'career-ops')
const UPSTREAM = 'https://github.com/career-ops-hq/career-ops.git'

const KEEP_DIRS = ['lib', 'providers', 'plugins', 'templates', 'config', 'seeds', 'utils', 'data-static', 'scaffolder', 'batch']
const ENGLISH_MODE_SUBDIRS = ['heuristics', 'interview', 'oferta-signals', 'pdf', 'regional']
const ROOT_EXCLUDE = [
  // test suites
  'test-all.mjs', 'updater-migration-tests.mjs', 'upgrade-tests.mjs',
  // Playwright
  'check-liveness.mjs', 'browser-extract.mjs', 'img-to-pdf.mjs', 'scan-interamt.mjs',
  'scan-dayforce.mjs', 'archive-posting.mjs', 'playwright.cv.config.mjs',
  // standalone LLM evaluators (Harness runs the evaluation itself)
  'gemini-eval.mjs', 'openai-tailor.mjs', 'batch-evaluate-gemini.mjs', 'scan-hn.mjs',
  // upstream self-update / CI-only tooling
  'update-system.mjs', 'doctor.mjs', 'seed-fixture.mjs',
  'validate-system-paths-coverage.mjs', 'validate-untrusted-content-coverage.mjs',
  // imports the excluded browser-extract.mjs
  'fetch-jd.mjs',
]

const argv = process.argv.slice(2)
const flagValue = (name, fallback = '') => {
  const at = argv.indexOf(name)
  return at >= 0 ? (argv[at + 1] ?? fallback) : fallback
}
const ref = flagValue('--ref', 'HEAD')
const dryRun = argv.includes('--dry-run')
const offline = flagValue('--from', '')
const extraModes = (() => {
  const at = argv.indexOf('--modes')
  if (at < 0) return []
  return argv.slice(at + 1).filter((value) => !value.startsWith('--'))
})()

function log(...parts) {
  process.stdout.write(`${parts.join(' ')}\n`)
}

function copyInto(srcDir, destDir, { filter } = {}) {
  if (!fs.existsSync(srcDir)) {
    log(`  ! not in upstream: ${path.relative(ROOT, srcDir)}`)
    return
  }
  if (dryRun) {
    log(`  would copy ${path.relative(ROOT, srcDir)} -> ${path.relative(ROOT, destDir)}`)
    return
  }
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    dereference: false,
    filter: filter ?? (() => true),
  })
}

if (offline) {
  CACHE = path.resolve(offline)
  log(`using the local checkout at ${CACHE}`)
  if (!fs.existsSync(path.join(CACHE, '.git'))) throw new Error(`--from ${CACHE} is not a git checkout`)
} else if (fs.existsSync(path.join(CACHE, '.git'))) {
  log(`refreshing ${UPSTREAM} @ ${ref} in ${CACHE}`)
  execFileSync('git', ['-C', CACHE, 'fetch', '--depth', '1', 'origin', ref], { stdio: 'inherit' })
  execFileSync('git', ['-C', CACHE, 'checkout', '-f', 'FETCH_HEAD'], { stdio: 'inherit' })
} else {
  log(`cloning ${UPSTREAM} @ ${ref} into ${CACHE}`)
  fs.mkdirSync(path.dirname(CACHE), { recursive: true })
  execFileSync('git', ['clone', '--depth', '1', '--', UPSTREAM, CACHE], { stdio: 'inherit' })
  if (ref !== 'HEAD') {
    execFileSync('git', ['-C', CACHE, 'fetch', '--depth', '1', 'origin', ref], { stdio: 'inherit' })
    execFileSync('git', ['-C', CACHE, 'checkout', '-f', 'FETCH_HEAD'], { stdio: 'inherit' })
  }
}
const sha = execFileSync('git', ['-C', CACHE, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const version = JSON.parse(fs.readFileSync(path.join(CACHE, 'package.json'), 'utf8')).version

log(`upstream career-ops ${version} @ ${sha}`)

fs.mkdirSync(RUNTIME, { recursive: true })

for (const dir of KEEP_DIRS) copyInto(path.join(CACHE, dir), path.join(RUNTIME, dir))

const keepMarketModes = new Set(ENGLISH_MODE_SUBDIRS.concat(extraModes))
const allMarketDirs = fs.existsSync(path.join(CACHE, 'modes'))
  ? fs.readdirSync(path.join(CACHE, 'modes'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []
copyInto(path.join(CACHE, 'modes'), path.join(RUNTIME, 'modes'), {
  filter: (src) => {
    const rel = path.relative(path.join(CACHE, 'modes'), src)
    if (!rel) return true
    const top = rel.split(path.sep)[0]
    // modes root: keep the .md files and the whitelisted subdirectories only.
    if (!allMarketDirs.includes(top)) return true
    return keepMarketModes.has(top)
  },
})

const modeFilter = new Set(allMarketDirs.filter((d) => !keepMarketModes.has(d)))
if (!dryRun && fs.existsSync(path.join(RUNTIME, 'modes'))) {
  for (const dir of modeFilter) fs.rmSync(path.join(RUNTIME, 'modes', dir), { recursive: true, force: true })
}

let copied = 0
for (const name of fs.readdirSync(CACHE)) {
  if (!name.endsWith('.mjs')) continue
  if (ROOT_EXCLUDE.includes(name)) continue
  if (dryRun) {
    log(`  would copy runtime/${name}`)
    copied += 1
    continue
  }
  fs.copyFileSync(path.join(CACHE, name), path.join(RUNTIME, name))
  copied += 1
}
if (!dryRun) {
  for (const name of ROOT_EXCLUDE) fs.rmSync(path.join(RUNTIME, name), { force: true })
  // Upstream scripts that moved out of scope between releases: drop anything whose
  // static imports point at a module this package does not ship, until stable.
  const imports = /from\s+['"]\.\/([^'"]+\.mjs)['"]/g
  for (let pass = 0; pass < 6; pass += 1) {
    const doomed = []
    for (const name of fs.readdirSync(RUNTIME)) {
      if (!name.endsWith('.mjs')) continue
      const text = fs.readFileSync(path.join(RUNTIME, name), 'utf8')
      const missing = [...text.matchAll(imports)]
        .map((match) => match[1])
        .filter((target) => !fs.existsSync(path.join(RUNTIME, target)))
      if (missing.length) doomed.push([name, [...new Set(missing)]])
    }
    if (!doomed.length) break
    for (const [name, missing] of doomed) {
      log(`  ! dropping ${name}: imports ${missing.join(', ')} which is not vendored`)
      fs.rmSync(path.join(RUNTIME, name), { force: true })
    }
  }
}

// Re-apply the plugin-side lazy-Playwright patch to generate-pdf.mjs.
const pdf = path.join(RUNTIME, 'generate-pdf.mjs')
if (!dryRun && fs.existsSync(pdf)) {
  let text = fs.readFileSync(pdf, 'utf8')
  if (text.includes("import { chromium } from 'playwright';")) {
    text = text.replace("import { chromium } from 'playwright';",
`// dsh-career-ops patch: Playwright is not a plugin dependency, so the browser is
// imported lazily. Fact gates and HTML building work without it; a real render asks
// for it explicitly.
async function launchChromium(options) {
  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error('Playwright is not installed in the career-ops plugin runtime. Install it in the profile (pnpm add playwright && npx playwright install chromium) or export the tailored CV to PDF through Harness.')
  }
  return chromium.launch(options)
}`)
    text = text.replaceAll('opts.launchBrowser || ((options) => chromium.launch(options))', 'opts.launchBrowser || launchChromium')
    fs.writeFileSync(pdf, text)
    log('  applied lazy-Playwright patch to runtime/generate-pdf.mjs')
  } else if (text.includes('launchChromium')) {
    log('  runtime/generate-pdf.mjs already patched')
  } else {
    log('  ? runtime/generate-pdf.mjs changed upstream: review the Playwright import by hand')
  }
}

log('')
log(`done${dryRun ? ' (dry run)' : ''}: ${copied} root scripts + ${KEEP_DIRS.length} directories refreshed`)
log('Update THIRD-PARTY-NOTICES.md with:')
log(`  - Upstream version vendored here: ${version}`)
log(`  - Upstream commit: ${sha}`)
log('Then run: node --check index.js && (a Harness session) reload the career-ops plugin row.')

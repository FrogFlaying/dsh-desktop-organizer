/**
 * Desktop Organizer — core scan and classification logic.
 *
 * Pure Node builtins only (no npm dependencies), so it runs both inside the
 * DSH Host plugin and standalone from a shell for testing.
 *
 * Three inventories are merged:
 *   1. desktop items      — what is actually sitting on the desktop
 *   2. start-menu links   — what the Start menu can launch
 *   3. AppsFolder         — every launchable app, including Store/MSIX apps
 *                           that never get a real .lnk anywhere
 *
 * @module scan.js
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

/* ────────────────────────────── paths ────────────────────────────── */

export function knownFolders() {
  const home = os.homedir()
  const appdata = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
  const programData = process.env.ProgramData ?? 'C:\\ProgramData'
  return {
    desktop: path.join(home, 'Desktop'),
    publicDesktop: path.join(programData, 'Desktop'),
    startMenuUser: path.join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    startMenuAll: path.join(programData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  }
}

/* ─────────────────────── PowerShell bridge ─────────────────────── */

/**
 * Run a PowerShell script and parse its JSON output.
 *
 * `shell:AppsFolder` and .lnk target resolution have no reliable pure-Node
 * equivalent (MSIX apps are virtual, not files), so those two probes shell out.
 * Everything else stays in Node.
 */
export function powershellJson(script, timeoutMs = 60_000) {
  // PowerShell emits text in the console code page (GBK on a Chinese Windows)
  // unless it is told otherwise, which corrupts any non-ASCII app name and
  // breaks JSON.parse. Pin every encoding layer to UTF-8 before the payload.
  const preamble = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
`
  const encoded = Buffer.from(preamble + script, 'utf16le').toString('base64')
  const stdout = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  )
  const text = stdout.replace(/^\uFEFF/, '').trim()
  if (text === '') return null
  return JSON.parse(text)
}

/** Enumerate every launchable app the shell knows about (includes MSIX/Store apps). */
export function scanAppsFolder() {
  const script = `
$ErrorActionPreference='Stop'
$sh = New-Object -ComObject Shell.Application
$folder = $sh.NameSpace('shell:AppsFolder')
$rows = @()
foreach ($item in $folder.Items()) {
  $rows += [pscustomobject]@{
    name = [string]$item.Name
    appId = [string]$item.Path
  }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`
  try {
    const rows = powershellJson(script)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** Resolve the target of each shortcut in one batch (fast: one PS process). */
export function resolveShortcutTargets(lnkPaths) {
  if (lnkPaths.length === 0) return new Map()
  // Pass paths via a temp file to avoid any quoting/injection concerns.
  const tmp = path.join(os.tmpdir(), `dsh-do-lnk-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(tmp, JSON.stringify(lnkPaths), 'utf8')
  const script = `
$paths = Get-Content -Raw -LiteralPath '${tmp.replace(/'/g, "''")}' -Encoding UTF8 | ConvertFrom-Json
$sh = New-Object -ComObject WScript.Shell
$rows = @()
foreach ($p in @($paths)) {
  $target = ''; $args = ''; $exists = $false
  try {
    $lnk = $sh.CreateShortcut([string]$p)
    $target = [string]$lnk.TargetPath
    $args = [string]$lnk.Arguments
    if ($target -ne '') { $exists = Test-Path -LiteralPath $target }
  } catch { }
  $rows += [pscustomobject]@{ path = [string]$p; target = $target; args = $args; targetExists = $exists }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 3
`
  try {
    const rows = powershellJson(script)
    const map = new Map()
    for (const r of Array.isArray(rows) ? rows : []) map.set(r.path, r)
    return map
  } catch {
    return new Map()
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* best effort */ }
  }
}

/* ───────────────────────── desktop scan ───────────────────────── */

/** Directories and files that must never be treated as user content. */
const DESKTOP_IGNORE = new Set(['desktop.ini', 'thumbs.db', '.ds_store'])

export function scanDesktop(folders = knownFolders()) {
  const roots = [
    { dir: folders.desktop, scope: 'user' },
    { dir: folders.publicDesktop, scope: 'public' },
  ]
  const items = []
  for (const { dir, scope } of roots) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (DESKTOP_IGNORE.has(entry.name.toLowerCase())) continue
      const full = path.join(dir, entry.name)
      let stat
      try { stat = fs.statSync(full) } catch { continue }
      items.push({
        name: entry.name,
        base: path.basename(entry.name, path.extname(entry.name)),
        ext: entry.isDirectory() ? '' : path.extname(entry.name).toLowerCase(),
        path: full,
        scope,
        isDir: entry.isDirectory(),
        size: entry.isDirectory() ? 0 : stat.size,
        modified: stat.mtimeMs,
        hidden: (stat.attributes ?? 0) !== 0 || entry.name.startsWith('.'),
      })
    }
  }
  return items
}

/* ──────────────────────── start menu scan ──────────────────────── */

export function scanStartMenu(folders = knownFolders()) {
  const out = []
  const walk = (dir, scope, depth = 0) => {
    if (depth > 6) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full, scope, depth + 1); continue }
      if (path.extname(entry.name).toLowerCase() !== '.lnk') continue
      out.push({ name: path.basename(entry.name, '.lnk'), path: full, scope })
    }
  }
  walk(folders.startMenuUser, 'user')
  walk(folders.startMenuAll, 'all')
  return out
}

/* ──────────────────────── classification ──────────────────────── */

/**
 * Ordered classification rules. First match wins, so put the specific
 * categories before the generic ones. Rules are plain data so a user can
 * override them from the plugin Config.
 */
export const DEFAULT_RULES = [
  { id: 'ai', label: 'AI 与大模型', patterns: [
    'anythingllm', 'ollama', 'lm ?studio', 'cherry ?studio', 'chatbox', '\\bjan\\b', 'gpt4all', 'msty',
    'open ?webui', 'lobe ?chat', 'dify', 'n8n', 'comfyui', 'stable ?diffusion', 'trae', 'cursor',
    'windsurf', 'claude', 'chatgpt', 'copilot', 'codex', 'gemini', 'qwen', 'kimi', '豆包', 'doubao',
    'deepseek', '\\bima\\b', 'continue', 'cline', '\\broo\\b', 'aider', '\\bzed\\b', 'vllm', 'text-generation',
    'localai', 'flowise', 'langflow', 'ragflow', 'maxkb', 'fastgpt', 'coze', '\\bpoe\\b', 'perplexity',
    'grok', 'mistral', 'gigachat', 'yiyan', '文心', '通义', '智谱', 'chatglm',
    // The agent-tool family: these are the apps that most often ship without a
    // desktop shortcut, and they are exactly what this user is looking for.
    'workbuddy', 'codebuddy', 'jobster', 'codearts', 'qoder', 'loomy', 'raccoon', 'minimax',
    'zcode', 'muse ?spark', 'mimo', 'lobster', '\\bagent\\b', '智能体', '大模型',
    'cc ?switch', 'hermes',
  ] },
  { id: 'dev', label: '开发工具', patterns: [
    'visual ?studio', 'vscode', '\\bcode\\b', 'idea', 'pycharm', 'webstorm', 'goland', 'clion',
    'rider', 'datagrip', 'android ?studio', 'eclipse', 'notepad\\+\\+', 'sublime', 'atom',
    'git', 'github', 'gitlab', 'gitee', 'sourcetree', 'fork', 'tortoise', 'bcompare', 'beyond ?compare',
    'docker', 'podman', 'wsl', 'putty', 'mobaxterm', 'xshell', 'xftp', 'finalshell', 'winscp',
    'securecrt', 'termius', 'tabby', 'windows ?terminal', 'powershell', 'cmd', 'node', 'npm',
    'python', 'java', 'jdk', 'maven', 'gradle', 'go\\b', 'rust', 'cargo', 'dotnet', 'visual ?studio ?code',
    'postman', 'apifox', 'apipost', 'insomnia', 'soapui', 'jmeter', 'fiddler', 'charles', 'wireshark',
    'burp', 'hopper', 'ida', 'ghidra', 'x64dbg', 'ollydbg',
  ] },
  { id: 'db', label: '数据库', patterns: [
    'dbeaver', 'navicat', 'datagrip', 'redis', 'mysql', 'postgres', 'pgadmin', 'mongodb', 'compass',
    'sqlite', 'sql ?server', 'ssms', 'oracle', 'plsql', 'toad', 'dbx', 'pdmaner', 'pdman', 'chiner',
    'heidisql', 'sqlyog', 'workbench', 'influxdb', 'clickhouse', 'neo4j', 'elasticsearch', 'kibana',
  ] },
  { id: 'office', label: '办公与文档', patterns: [
    'word', 'excel', 'powerpoint', 'outlook', 'onenote', 'visio', 'wps', 'office', 'acrobat',
    'foxit', 'pdf', 'typora', 'obsidian', 'notion', 'xmind', 'mindmaster', 'processon', 'draw\\.io',
    'marktext', 'yuque', '语雀', 'feishu', 'lark', '飞书', 'dingtalk', '钉钉', 'wecom', '企业微信',
    'showdoc', 'onedrive', 'dropbox', '坚果云', 'nutstore',
  ] },
  { id: 'media', label: '影音与图像', patterns: [
    'photoshop', 'illustrator', 'premiere', 'after ?effects', 'lightroom', 'figma', 'sketch',
    'blender', 'mastergo', 'axure', 'mockplus', '墨刀', 'modao', 'snipaste', 'sharex', 'obs',
    'potplayer', 'vlc', 'mpc', 'kmplayer', 'foobar', '网易云', 'qq音乐', 'spotify', 'ev录屏',
    'bandicam', 'camtasia', 'gimp', 'inkscape', 'krita', 'paint',
  ] },
  { id: 'comm', label: '通讯与社交', patterns: [
    'wechat', '微信', 'qq', 'tim', 'telegram', 'discord', 'slack', 'zoom', 'tencent ?meeting',
    '腾讯会议', 'skype', 'whatsapp', 'line', 'teams',
  ] },
  { id: 'browser', label: '浏览器与网络', patterns: [
    'chrome', 'edge', 'firefox', 'brave', 'opera', 'safari', '360', 'quark', '夸克', 'clash',
    'v2ray', 'shadowsocks', 'trojan', 'singbox', 'sing-box', 'verge', 'nekoray', 'warp',
  ] },
  { id: 'system', label: '系统工具', patterns: [
    '7-?zip', 'winrar', 'bandizip', 'peazip', 'ccleaner', 'dism', 'rufus', 'ventoy', 'diskgenius',
    '分区', 'aomei', 'easybcd', 'everything', 'listary', 'wox', 'utools', 'powertoys', 'snip',
    'control ?panel', 'settings', 'task ?manager', 'regedit', 'services', 'event ?viewer',
    'device ?manager', 'disk ?management', 'system ?information', 'uninstall', 'recycle',
  ] },
]

/** Compile the rule table once into [id, label, RegExp] triples. */
export function compileRules(rules = DEFAULT_RULES) {
  return rules.map(rule => ({
    id: rule.id,
    label: rule.label,
    re: new RegExp(rule.patterns.join('|'), 'i'),
  }))
}

/**
 * Classify one name against the rule table.
 *
 * A category's own folder name is matched to that category first. Without this
 * a folder the organizer created (`AI 与大模型`) matches no English pattern,
 * falls into `other`, and gets filed into itself on the next run — the exact
 * bug that buried every category folder under `other/`.
 *
 * @returns the matching rule id, or `other` when nothing matches.
 */
export function classify(name, compiled) {
  const hay = String(name ?? '').trim()
  // Exact folder-name match wins, so a category folder is never re-filed.
  const byLabel = compiled.find(rule => rule.label.toLowerCase() === hay.toLowerCase())
  if (byLabel) return byLabel.id
  for (const rule of compiled) if (rule.re.test(hay)) return rule.id
  return 'other'
}

/** True when `name` is a folder this organizer itself creates. */
export function isCategoryFolderName(name, compiled) {
  const hay = String(name ?? '').trim().toLowerCase()
  return compiled.some(rule => rule.label.toLowerCase() === hay)
}

/**
 * List the items already filed inside this organizer's category folders.
 *
 * Used to answer "is this app already represented on the desktop?" honestly once
 * shortcuts have been filed away, instead of re-offering to create duplicates.
 *
 * Category folders are looked for both at the desktop root and one level down
 * inside `other/`, because a buggy earlier release misfiled them there. Checking
 * only the root reported every filed app as missing again.
 */
export function scanCategoryFolders(folders = knownFolders(), compiled = compileRules()) {
  const roots = [
    { dir: folders.desktop, scope: 'user' },
    { dir: folders.publicDesktop, scope: 'public' },
  ]
  const out = []
  for (const { dir, scope } of roots) {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // A category folder directly at the root, or `other/<category>`.
      const parents = []
      if (isCategoryFolderName(entry.name, compiled)) {
        parents.push({ dir: path.join(dir, entry.name), label: entry.name })
      } else if (entry.name.toLowerCase() === 'other') {
        const otherDir = path.join(dir, entry.name)
        let inner
        try { inner = fs.readdirSync(otherDir, { withFileTypes: true }) } catch { continue }
        for (const child of inner) {
          if (child.isDirectory() && isCategoryFolderName(child.name, compiled)) {
            parents.push({ dir: path.join(otherDir, child.name), label: child.name })
          }
        }
      }
      for (const parent of parents) {
        let children
        try { children = fs.readdirSync(parent.dir, { withFileTypes: true }) } catch { continue }
        for (const child of children) {
          const full = path.join(parent.dir, child.name)
          out.push({
            name: child.name,
            base: path.basename(child.name, path.extname(child.name)),
            ext: child.isDirectory() ? '' : path.extname(child.name).toLowerCase(),
            path: full,
            scope,
            isDir: child.isDirectory(),
            categoryFolder: parent.label,
          })
        }
      }
    }
  }
  return out
}

/**
 * Recover a category folder that was misfiled into `other/` by an earlier buggy
 * run. Moves `other/<CategoryLabel>` back to the desktop root.
 *
 * Only folders whose name exactly matches a known category label are touched, so
 * a user's own folder that happens to sit in `other/` is never moved.
 */
export function planRepair(report, options = {}) {
  const desktopDir = path.resolve(options.desktopDir ?? report.folders?.desktop ?? '')
  const compiled = report._compiled ?? compileRules()
  const otherDir = path.join(desktopDir, 'other')
  const moves = []
  let entries
  try { entries = fs.readdirSync(otherDir, { withFileTypes: true }) } catch { return moves }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!isCategoryFolderName(entry.name, compiled)) continue
    const from = path.join(otherDir, entry.name)
    const to = path.join(desktopDir, entry.name)
    if (fs.existsSync(to)) continue // already back; never merge folders
    moves.push({ name: entry.name, from, to, reason: '分类文件夹被误归入 other，恢复到桌面根目录' })
  }
  return moves
}

/**
 * Execute the repair plan: pull misfiled category folders out of `other/`.
 * Same safety rules as the main organizer — move only, never overwrite.
 */
export function applyRepair(moves, options = {}) {
  const store = options.store
  const repaired = []
  const failures = []
  if (moves.length === 0) return { repaired, failures }
  if (store) {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(
      path.join(store, 'undo-repair.json'),
      JSON.stringify({ at: new Date().toISOString(), items: moves.map(m => ({ from: m.from, to: m.to })) }, null, 2),
      'utf8',
    )
  }
  for (const m of moves) {
    try {
      if (!fs.existsSync(m.from)) { failures.push({ name: m.name, reason: '源文件夹已不存在' }); continue }
      if (fs.existsSync(m.to)) { failures.push({ name: m.name, reason: '目标已存在，跳过以免覆盖' }); continue }
      fs.renameSync(m.from, m.to)
      repaired.push({ name: m.name, from: m.from, to: m.to })
    } catch (error) {
      failures.push({ name: m.name, reason: String(error?.message ?? error) })
    }
  }
  return { repaired, failures }
}

/* ────────────────────────── the report ────────────────────────── */

/**
 * Build the full inventory: what is on the desktop, what the Start menu can
 * launch, which apps have no desktop shortcut, and which shortcuts are broken.
 */
export function buildReport(options = {}) {
  const folders = options.folders ?? knownFolders()
  const compiled = compileRules(options.rules ?? DEFAULT_RULES)
  const desktop = scanDesktop(folders)
  const startMenu = scanStartMenu(folders)
  const apps = options.skipAppsFolder ? [] : scanAppsFolder()

  // Resolve every shortcut target in one batch (desktop + start menu + filed).
  const allLnks = [
    ...desktop.filter(i => i.ext === '.lnk').map(i => i.path),
    ...startMenu.map(i => i.path),
    ...scanCategoryFolders(folders, compiled).filter(i => i.ext === '.lnk').map(i => i.path),
  ]
  const resolved = resolveShortcutTargets(allLnks)

  const desktopByBase = new Map()
  for (const item of desktop) desktopByBase.set(item.base.toLowerCase(), item)

  // Which app names are already represented on the desktop?
  //
  // This must look INSIDE the category folders too. Once the organizer has filed
  // a shortcut into `AI 与大模型/`, a top-level-only check reports that app as
  // "missing from desktop" again — so the list never shrinks and re-running the
  // tool offers to create duplicates of shortcuts that already exist.
  const desktopNames = new Set()
  const desktopTargets = new Set()
  const filedNames = new Set()
  for (const item of desktop) {
    const lower = item.base.toLowerCase()
    desktopNames.add(lower)
    if (item.ext !== '.lnk') continue
    const r = resolved.get(item.path)
    if (r?.target) desktopTargets.add(r.target.toLowerCase())
  }
  for (const sub of scanCategoryFolders(folders, compiled)) {
    filedNames.add(sub.base.toLowerCase())
    if (sub.ext === '.lnk') {
      const r = resolved.get(sub.path)
      if (r?.target) desktopTargets.add(r.target.toLowerCase())
    }
  }

  const broken = []
  for (const item of desktop) {
    if (item.ext !== '.lnk') continue
    const r = resolved.get(item.path)
    if (r && r.target && !r.targetExists) broken.push({ name: item.name, path: item.path, target: r.target })
  }
  for (const item of scanCategoryFolders(folders, compiled)) {
    if (item.ext !== '.lnk') continue
    const r = resolved.get(item.path)
    if (r && r.target && !r.targetExists) broken.push({ name: item.name, path: item.path, target: r.target })
  }

  // Apps known to the shell but absent from the desktop (including filed-away).
  const missing = []
  const seen = new Set()
  for (const app of apps) {
    const key = String(app.name ?? '').trim()
    if (key === '' || seen.has(key.toLowerCase())) continue
    seen.add(key.toLowerCase())
    const lower = key.toLowerCase()
    if (desktopNames.has(lower) || filedNames.has(lower)) continue
    // A Store app id is not a path; only real paths can be deduped by target.
    if (app.appId && app.appId.includes('\\') && desktopTargets.has(app.appId.toLowerCase())) continue
    missing.push({
      name: key,
      appId: app.appId ?? '',
      category: classify(key, compiled),
      // A launchable id the shortcut writer can target directly.
      launchable: String(app.appId ?? '') !== '',
    })
  }
  missing.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))

  // Group desktop items by category.
  //
  // Category folders themselves are containers, not content: they are excluded
  // here so a folder does not appear as an item inside its own category. The
  // "filed" view below shows what is inside them.
  const groups = new Map()
  for (const item of desktop) {
    if (item.isDir && isCategoryFolderName(item.name, compiled)) continue
    if (item.isDir && item.name.trim().toLowerCase() === 'other') continue
    const cat = classify(item.base, compiled)
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push({
      name: item.name, path: item.path, isDir: item.isDir,
      target: resolved.get(item.path)?.target ?? '',
      broken: broken.some(b => b.path === item.path),
    })
  }

  const labelOf = id => compiled.find(r => r.id === id)?.label ?? id
  const categories = [...groups.entries()]
    .map(([id, items]) => ({ id, label: labelOf(id), count: items.length, items }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  // Items already filed inside the organizer's own category folders, grouped the
  // same way, so the UI can show "already organized" instead of "missing".
  const filedByCategory = new Map()
  for (const item of scanCategoryFolders(folders, compiled)) {
    const cat = classify(item.categoryFolder, compiled)
    if (!filedByCategory.has(cat)) filedByCategory.set(cat, [])
    filedByCategory.get(cat).push({
      name: item.name, path: item.path, isDir: item.isDir,
      target: resolved.get(item.path)?.target ?? '',
      broken: broken.some(b => b.path === item.path),
    })
  }
  const filed = [...filedByCategory.entries()]
    .map(([id, items]) => ({ id, label: labelOf(id), count: items.length, items }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  return {
    generatedAt: new Date().toISOString(),
    folders,
    // Kept for planOrganization's category-folder guard.
    _compiled: compiled,
    summary: {
      desktopItems: desktop.length,
      desktopShortcuts: desktop.filter(i => i.ext === '.lnk').length,
      startMenuShortcuts: startMenu.length,
      launchableApps: apps.length,
      missingFromDesktop: missing.length,
      brokenShortcuts: broken.length,
      categories: categories.length,
      filedItems: filed.reduce((n, c) => n + c.count, 0),
    },
    categories,
    filed,
    missingFromDesktop: missing,
    brokenShortcuts: broken,
  }
}

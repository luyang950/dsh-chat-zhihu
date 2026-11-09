// lib/store.mjs — the plugin's only writable state, under $DSH_HOME/dsh-chat-zhihu/.
//
//   config.json    reading preferences (boss key, font, images, session title)
//   cookie.json    the Zhihu cookie the user pasted, if any (mode 0600)
//
// Writes are atomic (temp file + rename) and serialised per file.

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_DIR = 'dsh-chat-zhihu'

/** Resolved at call time so tests (and a moved DSH_HOME) see the current value. */
export function dataDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_DIR)
}

/* ── config schema ───────────────────────────────────────────────────────── */

const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Backquote|Period|Comma|Slash|Semicolon|Quote|BracketLeft|BracketRight|Backslash|Minus|Equal)$/

export const DEFAULT_SESSION_TITLE = '资料整理'

export const DEFAULT_CONFIG = Object.freeze({
  fontSize: 0, // 0 = follow the conversation's own font size
  lineHeight: 1.8,
  bossKey: 'Ctrl+Alt+KeyZ',
  showImages: false, // pictures give the game away; off by default
  keepSession: true, // run one empty turn so a card opened in New Session stays in the sidebar
  sessionTitle: '', // empty = DEFAULT_SESSION_TITLE
})

/**
 * Normalise a boss-key chord like `ctrl+alt+KeyZ` → `Ctrl+Alt+KeyZ`.
 * At least one modifier is required unless the key is a function key, so the
 * chord can never swallow ordinary typing in the composer.
 * @returns {string|null}
 */
export function normalizeChord(value) {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0 || parts.length > 5) return null
  const code = parts.pop()
  if (!KEY_CODE.test(code)) return null
  const order = ['Ctrl', 'Alt', 'Shift', 'Meta']
  const seen = new Set()
  for (const part of parts) {
    const canonical = order.find((name) => name.toLowerCase() === part.toLowerCase())
    if (!canonical || seen.has(canonical)) return null
    seen.add(canonical)
  }
  if (seen.size === 0 && !/^F\d+$/.test(code)) return null
  if (seen.size === 1 && seen.has('Shift') && !/^F\d+$/.test(code)) return null
  return [...order.filter((name) => seen.has(name)), code].join('+')
}

function clampNumber(value, min, max, integer) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  const clamped = Math.min(max, Math.max(min, number))
  return integer ? Math.round(clamped) : Math.round(clamped * 100) / 100
}

/**
 * Validate a partial config patch.
 * @returns {{ value: object, errors: string[] }} only the valid fields are kept
 */
export function validateConfigPatch(patch) {
  const value = {}
  const errors = []
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value, errors: ['配置必须是对象'] }

  for (const [key, raw] of Object.entries(patch)) {
    switch (key) {
      case 'fontSize': {
        const number = Number(raw) === 0 ? 0 : clampNumber(raw, 12, 28, true)
        if (number === null) errors.push('字号必须是数字')
        else value.fontSize = number
        break
      }
      case 'lineHeight': {
        const number = clampNumber(raw, 1.2, 2.6, false)
        if (number === null) errors.push('行距必须是数字')
        else value.lineHeight = number
        break
      }
      case 'bossKey': {
        const chord = normalizeChord(raw)
        if (!chord) errors.push('老板键必须是「修饰键 + 按键」，例如 Ctrl+Alt+KeyZ')
        else value.bossKey = chord
        break
      }
      case 'showImages':
      case 'keepSession': {
        if (typeof raw !== 'boolean') errors.push(`${key} 必须是 true 或 false`)
        else value[key] = raw
        break
      }
      case 'sessionTitle': {
        const text = typeof raw === 'string' ? raw.trim() : null
        if (text === null || text.length > 40 || /[\u0000-\u001f]/.test(text)) errors.push('会话标题最多 40 个字，且不能含控制字符')
        else value.sessionTitle = text
        break
      }
      default:
        errors.push(`未知配置项：${key}`)
    }
  }
  return { value, errors }
}

/* ── cookie ──────────────────────────────────────────────────────────────── */

export const COOKIE_MAX_LENGTH = 8192
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/
// RFC 6265 cookie-octets, plus space and comma which real Zhihu values never need
// but browsers accept; never `;`, `"`-quoting tricks or control characters.
const COOKIE_VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{0,4096}$/

/**
 * Parse a pasted cookie string (`a=1; b=2`, optionally prefixed with `Cookie:`).
 * @returns {{ pairs: [string, string][], errors: string[] }}
 */
export function parseCookie(input) {
  const errors = []
  const pairs = []
  if (typeof input !== 'string') return { pairs, errors: ['cookie 必须是字符串'] }
  const text = input.trim().replace(/^cookie\s*:\s*/i, '')
  if (text.length > COOKIE_MAX_LENGTH) return { pairs, errors: [`cookie 太长（上限 ${COOKIE_MAX_LENGTH} 字符）`] }
  const seen = new Set()
  for (const part of text.split(';')) {
    const piece = part.trim()
    if (!piece) continue
    const at = piece.indexOf('=')
    if (at <= 0) {
      errors.push(`无法解析「${piece.slice(0, 20)}」`)
      continue
    }
    const name = piece.slice(0, at).trim()
    let value = piece.slice(at + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (!COOKIE_NAME.test(name) || !COOKIE_VALUE.test(value)) {
      errors.push(`cookie「${name.slice(0, 20)}」含非法字符`)
      continue
    }
    if (seen.has(name)) continue
    seen.add(name)
    pairs.push([name, value])
  }
  if (pairs.length > 80) errors.push('cookie 条目过多')
  return { pairs, errors }
}

/** Whether the pairs carry Zhihu's login token. */
export function hasLoginToken(pairs) {
  return pairs.some(([name]) => name === 'z_c0')
}

/* ── json files ──────────────────────────────────────────────────────────── */

const queues = new Map()

async function readJson(name, fallback) {
  try {
    const parsed = JSON.parse(await readFile(join(dataDirectory(), name), 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Read-modify-write one file under a per-file queue; `mutate` returns the result. */
function update(name, fallback, mutate, mode = 0o644) {
  const previous = queues.get(name) ?? Promise.resolve()
  const next = previous.then(async () => {
    const current = await readJson(name, fallback())
    const result = await mutate(current)
    const directory = dataDirectory()
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, name)
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode })
    await chmod(temporary, mode)
    await rename(temporary, target)
    return result
  })
  queues.set(name, next.catch(() => {}))
  return next
}

/* ── config ──────────────────────────────────────────────────────────────── */

export async function readConfig() {
  const stored = await readJson('config.json', {})
  // Re-validate on read: a hand-edited file must not smuggle in a bad value.
  const { value } = validateConfigPatch(
    Object.fromEntries(Object.entries(stored).filter(([key]) => key in DEFAULT_CONFIG)),
  )
  return { ...DEFAULT_CONFIG, ...value }
}

export async function writeConfig(patch) {
  const { value, errors } = validateConfigPatch(patch)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.status = 400
    throw error
  }
  await update('config.json', () => ({}), (current) => {
    Object.assign(current, value)
  })
  return readConfig()
}

/** The stored cookie pairs (empty when none). */
export async function readCookie() {
  const stored = await readJson('cookie.json', {})
  const { pairs, errors } = parseCookie(typeof stored.cookie === 'string' ? stored.cookie : '')
  return errors.length > 0 ? [] : pairs
}

/** Replace the stored cookie; an empty string clears it. */
export async function writeCookie(input) {
  const { pairs, errors } = parseCookie(input)
  if (errors.length > 0) {
    const error = new Error(errors.join('；'))
    error.status = 400
    throw error
  }
  if (pairs.length > 0 && !hasLoginToken(pairs)) {
    const error = new Error('cookie 里没有 z_c0（知乎的登录凭证），请从已登录的浏览器里复制完整 cookie')
    error.status = 400
    throw error
  }
  const cookie = pairs.map(([name, value]) => `${name}=${value}`).join('; ')
  await update(
    'cookie.json',
    () => ({}),
    (current) => {
      current.cookie = cookie
      current.at = Date.now()
    },
    0o600,
  )
  return pairs
}

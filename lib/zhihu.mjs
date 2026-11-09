// lib/zhihu.mjs — what the host knows about Zhihu: link parsing and the hot list.
//
// The hot list is the one Zhihu endpoint that still answers without a login, so the
// host fetches it (and caches it briefly). Everything else — questions, answers,
// articles — needs the reader's own Zhihu session and is read by the browser half
// through a hidden desktop webview; the host never sees that text.

export const HOT_URL = 'https://api.zhihu.com/topstory/hot-lists/total?limit=50'
export const HOT_TTL_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
const ID = /^\d{1,24}$/

export class ZhihuError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Turn the `/zhihu` argument into one target.
 *
 *   (empty)                                → { kind: fallback } ('feed' unless configured)
 *   热榜 | hot                             → { kind: 'hot' }
 *   推荐 | feed                            → { kind: 'feed' } (the signed-in home feed)
 *   https://www.zhihu.com/question/1       → { kind: 'question', id: '1' }
 *   https://www.zhihu.com/question/1/answer/2 → { kind: 'question', id: '1', answer: '2' }
 *   https://www.zhihu.com/answer/2         → { kind: 'answer', id: '2' }
 *   https://zhuanlan.zhihu.com/p/3         → { kind: 'article', id: '3' }
 *   q1 / a2 / p3 / bare digits (question)  → the same, for quick typing
 *
 * @returns {{ kind: 'hot' } | { kind: 'question', id: string, answer?: string } | { kind: 'answer', id: string } | { kind: 'article', id: string }}
 */
export function parseTarget(argument, fallback = 'feed') {
  const text = String(argument ?? '').trim()
  if (!text) return { kind: fallback === 'hot' ? 'hot' : 'feed' }
  if (text === '热榜' || text.toLowerCase() === 'hot') return { kind: 'hot' }
  if (text === '推荐' || text.toLowerCase() === 'feed') return { kind: 'feed' }
  if (text.length > 512) throw new ZhihuError('参数过长')

  const short = /^([qap]?)(\d{1,24})$/i.exec(text)
  if (short) {
    const kind = { '': 'question', q: 'question', a: 'answer', p: 'article' }[short[1].toLowerCase()]
    return { kind, id: short[2] }
  }

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    throw new ZhihuError('用法：/zhihu（热榜）或 /zhihu <知乎问题 / 回答 / 专栏文章链接>')
  }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ZhihuError('只支持知乎链接')
  if (host !== 'zhihu.com' && !host.endsWith('.zhihu.com')) throw new ZhihuError('只支持 zhihu.com 的链接')
  const path = url.pathname.replace(/\/+$/, '')

  let match = /^\/question\/(\d{1,24})(?:\/answer\/(\d{1,24}))?$/.exec(path)
  if (match) return match[2] ? { kind: 'question', id: match[1], answer: match[2] } : { kind: 'question', id: match[1] }
  match = /^\/answer\/(\d{1,24})$/.exec(path)
  if (match) return { kind: 'answer', id: match[1] }
  match = /^\/p\/(\d{1,24})$/.exec(path)
  if (match && (host === 'zhuanlan.zhihu.com' || host === 'www.zhihu.com' || host === 'zhihu.com')) return { kind: 'article', id: match[1] }
  throw new ZhihuError('只认得知乎的问题、回答和专栏文章链接')
}

/** Validate a target that came back from the browser (or a stored node). */
export function isTarget(value) {
  if (!value || typeof value !== 'object') return false
  if (value.kind === 'hot' || value.kind === 'feed') return true
  if (!['question', 'answer', 'article'].includes(value.kind) || !ID.test(String(value.id ?? ''))) return false
  return value.answer === undefined || (value.kind === 'question' && ID.test(String(value.answer)))
}

/** The page the hidden webview opens for a target. */
export function targetUrl(target) {
  switch (target.kind) {
    case 'question':
      return target.answer
        ? `https://www.zhihu.com/question/${target.id}/answer/${target.answer}`
        : `https://www.zhihu.com/question/${target.id}`
    case 'answer':
      return `https://www.zhihu.com/answer/${target.id}`
    case 'article':
      return `https://zhuanlan.zhihu.com/p/${target.id}`
    case 'feed':
      return 'https://www.zhihu.com/'
    default:
      return 'https://www.zhihu.com/hot'
  }
}

/* ── hot list ────────────────────────────────────────────────────────────── */

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function count(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

/**
 * A question id as text. Zhihu ids are 19 digits — past 2^53 — so the numeric
 * `target.id` is already rounded by JSON.parse; the string fields keep it exact.
 */
function questionId(row) {
  const fromCard = /^Q_(\d{1,24})$/.exec(String(row?.card_id ?? ''))
  if (fromCard) return fromCard[1]
  const fromUrl = /\/questions?\/(\d{1,24})(?:$|[/?#])/.exec(String(row?.target?.url ?? ''))
  if (fromUrl) return fromUrl[1]
  const raw = row?.target?.id
  return typeof raw === 'string' || (typeof raw === 'number' && Number.isSafeInteger(raw)) ? String(raw) : ''
}

/** Reduce the raw hot-list payload to what the card shows. Unknown shapes are skipped. */
export function parseHotList(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const items = []
  for (const row of rows) {
    const target = row?.target
    if (!target || target.type !== 'question') continue
    const id = questionId(row)
    const title = text(target.title, 200)
    if (!ID.test(id) || !title) continue
    items.push({
      id,
      title,
      excerpt: text(target.excerpt, 300),
      heat: text(row.detail_text, 40),
      answers: count(target.answer_count),
      followers: count(target.follower_count),
    })
  }
  return items
}

let cache = null // { at, items }

export function clearHotCache() {
  cache = null
}

/**
 * The hot list, cached for HOT_TTL_MS. `fetchImpl` is injectable for tests.
 * @returns {Promise<{ items: object[], at: number, cached: boolean }>}
 */
export async function hotList({ refresh = false, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!refresh && cache && now() - cache.at < HOT_TTL_MS) return { items: cache.items, at: cache.at, cached: true }
  let response
  try {
    response = await fetchImpl(HOT_URL, {
      headers: {
        accept: 'application/json',
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    if (cache) return { items: cache.items, at: cache.at, cached: true }
    throw new ZhihuError(`连不上知乎：${error?.message ?? error}`, 502)
  }
  if (!response.ok) {
    if (cache) return { items: cache.items, at: cache.at, cached: true }
    throw new ZhihuError(`知乎热榜返回 HTTP ${response.status}`, 502)
  }
  const items = parseHotList(await response.json().catch(() => null))
  if (items.length === 0) {
    if (cache) return { items: cache.items, at: cache.at, cached: true }
    throw new ZhihuError('知乎热榜是空的（接口格式可能变了）', 502)
  }
  cache = { at: now(), items }
  return { items, at: cache.at, cached: false }
}

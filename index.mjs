// dsh-chat-zhihu — host half (cordis plugin).
//
// Two seams, nothing else:
//
//   * the `/zhihu` human command. Its handler parses the argument into one target
//     (the hot list, a question, an answer or an article) and settles with that
//     target as a tiny JSON result. `command/run` + `command/done` are log-only
//     session events: they never become model messages, so reading costs zero
//     tokens. The browser half folds that pair into one custom chat node — the card.
//
//     When the Session is still blank, the handler also lets the agent loop run one
//     empty turn so DSH keeps it in the sidebar — see lib/session.mjs. That turn
//     calls no model.
//
//   * a JSON API under /dsh-chat-zhihu/api/*: config, the pasted cookie, and the
//     hot list (the one Zhihu endpoint that needs no login). Question and answer
//     text is read by the browser half in a hidden desktop webview, never here.
//
// `webServer` is NOT in `inject`: it is published late and is absent in headless
// profiles, so it is attached with ctx.inject() and the plugin settles without it.

import { nameSession, onPreStep, sealBlankSession } from './lib/session.mjs'
import { DEFAULT_SESSION_TITLE, readConfig, readCookie, writeConfig, writeCookie } from './lib/store.mjs'
import { ZhihuError, hotList, parseTarget } from './lib/zhihu.mjs'

export const name = 'dsh-chat-zhihu'
export const inject = ['commands']

export const API_PREFIX = '/dsh-chat-zhihu/api'
const MAX_BODY_BYTES = 16 * 1024

/* ── helpers ─────────────────────────────────────────────────────────────── */

function httpError(message, status = 400) {
  return new ZhihuError(message, status)
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(payload))
}

async function readBody(req) {
  const type = String(req.headers?.['content-type'] ?? '')
  if (!type.includes('application/json')) throw httpError('请求体必须是 application/json', 415)
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError('请求体过大', 413)
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw httpError('请求体不是合法的 JSON 对象')
  }
}

/* ── /zhihu ──────────────────────────────────────────────────────────────── */

export const COMMAND = 'zhihu'

/**
 * @param {{ afterOpen?: (invocation: object, target: object) => void }} [hooks]
 *   `afterOpen` runs once the command has settled (after `command/done` is logged).
 */
export function zhihuCommand(hooks = {}) {
  return {
    name: COMMAND,
    description: '在会话里看知乎（热榜 / 问题 / 回答 / 专栏），内容不进模型上下文',
    input: { hint: '<留空看热榜，或贴知乎链接>' },
    recordInput: true,
    async handler(invocation) {
      const argument = String(invocation?.rawInput ?? '').replace(/^\/zhihu\b/, '').trim()
      try {
        const target = parseTarget(argument)
        if (typeof hooks.afterOpen === 'function') setImmediate(() => hooks.afterOpen(invocation, target))
        return { kind: 'success', text: JSON.stringify({ target }) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }
}

/* ── routes ──────────────────────────────────────────────────────────────── */

const routes = {
  /** GET → config (+ whether a cookie is stored); POST → partial update. */
  async config(req) {
    const config = req.method === 'POST' ? await writeConfig(await readBody(req)) : await readConfig()
    const cookie = await readCookie()
    return { config, cookieSet: cookie.length > 0 }
  },

  /**
   * GET → the stored cookie pairs, for the browser half to plant in its own webview.
   * POST {cookie} → replace it ('' clears). The response never echoes values back.
   */
  async cookie(req) {
    if (req.method === 'POST') {
      const body = await readBody(req)
      if (typeof body.cookie !== 'string') throw httpError('参数 cookie 必须是字符串')
      const pairs = await writeCookie(body.cookie)
      return { cookieSet: pairs.length > 0, names: pairs.map(([cookieName]) => cookieName) }
    }
    return { pairs: await readCookie() }
  },

  /** GET ?refresh=1 → the hot list (cached for a minute). */
  async hot(req, params) {
    const refresh = params.get('refresh') === '1'
    return hotList({ refresh })
  },
}

const POST_ROUTES = new Set(['config', 'cookie'])

/**
 * The single prefix handler: dispatch, method check, uniform error envelope.
 * Exported so the test suite can drive it without a web server.
 */
export async function handleApi(req, res) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) throw httpError('未知接口', 404)
    const route = url.pathname.slice(API_PREFIX.length + 1)
    if (!Object.hasOwn(routes, route)) throw httpError('未知接口', 404)
    const method = req.method ?? 'GET'
    if (method !== 'GET' && !(method === 'POST' && POST_ROUTES.has(route))) {
      res.setHeader?.('allow', POST_ROUTES.has(route) ? 'GET, POST' : 'GET')
      throw httpError('不支持的请求方法', 405)
    }
    const payload = await routes[route](req, url.searchParams)
    sendJson(res, 200, { ok: true, ...payload })
  } catch (error) {
    if (res.writableEnded) return
    const status = Number.isInteger(error?.status) ? error.status : 500
    const message = status === 500 ? `内部错误：${error?.message ?? error}` : error.message
    sendJson(res, status, { ok: false, error: message })
  }
}

/* ── plugin ──────────────────────────────────────────────────────────────── */

export function apply(ctx) {
  let titles = null
  ctx.inject(['sessionTitle'], (titleCtx) => {
    titles = titleCtx.sessionTitle
    titleCtx.effect(() => () => {
      titles = null
    }, 'dsh-chat-zhihu: session titles')
  })

  // Rejects only the empty turn started below; see lib/session.mjs.
  ctx.on('agent/pre-step', onPreStep, true)

  const afterOpen = async (invocation) => {
    const agent = invocation?.agent
    try {
      const config = await readConfig()
      if (!config.keepSession) return
      if (!sealBlankSession(agent)) return
      // A neutral title by default: the sidebar is in plain view.
      nameSession(titles, agent.session, config.sessionTitle || DEFAULT_SESSION_TITLE)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-chat-zhihu: keeping the session failed: ${error?.message ?? error}`)
    }
  }

  // `commands.register` is bound to this plugin's lifecycle and returns its disposer.
  ctx.commands.register(zhihuCommand({ afterOpen }))

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: handleApi }),
      'dsh-chat-zhihu: api',
    )
  })
}

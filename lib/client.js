/* global window, document, fetch, localStorage, setTimeout, clearTimeout, requestAnimationFrame, cancelAnimationFrame, console */
// dsh-chat-zhihu — browser half.
//
// Hand-written ModuleLoader bundle: no build step. The only hard dependency is `react`.
//
// How the card lives in the transcript:
//   `/zhihu [link]` logs the ordinary durable `command/run` + `command/done` pair
//   (log-only events — never model messages, so zero tokens). A custom Definition
//   folds that pair into one chat node of kind `dsh-chat-zhihu`; the node renders a
//   card that reads like an ordinary reply, exactly where the user typed the command.
//   The generic command row is suppressed by registering an empty `zhihu` commandview.
//
// Where the text comes from:
//   * the hot list — from the host (`/dsh-chat-zhihu/api/hot`), no login needed;
//   * questions, answers, articles — Zhihu shows them only to a signed-in browser, so
//     on DSH Desktop the card leases one hidden <webview> through `window.dshDesktop.browser`
//     (the bridge DSH's own sidebar browser uses), opens the page there, and reads
//     the page's own data (`js-initialData`) and DOM. Zhihu's HTML never touches this
//     document: it is converted to plain text blocks by a small parser below.
//
// Geometry: the card is sized from the CSS variables the conversation scroller
// publishes (`--dsh-conversation-viewport-height`, `--dsh-composer-height`), and the
// text scrolls inside the card, so the transcript above never reflows.

window.__ModuleLoader__.load({
  id: 'dsh-chat-zhihu',
  factory: (require) => {
    var module = { exports: {} }

    const React = require('react')
    const h = React.createElement

    const API = '/dsh-chat-zhihu/api'
    const KIND = 'dsh-chat-zhihu'
    const COMMAND = 'zhihu'
    const WORKSPACE_KEY = 'dsh-chat-zhihu' // storage identity for the leased webviews
    const GUEST_UA =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
    const LOGIN_URL = 'https://www.zhihu.com/signin?next=%2Fhot'
    const LOAD_MARGIN_PX = 1200 // fetch more answers when the viewport is this close to the end
    const PAGE_TIMEOUT_MS = 20000

    const DEFAULT_CONFIG = Object.freeze({
      fontSize: 0,
      lineHeight: 1.8,
      bossKey: 'Ctrl+Alt+KeyZ',
      showImages: false,
      defaultView: 'feed',
      keepSession: true,
      sessionTitle: '',
    })

    /* ── shared state (survives hot replacement via a fixed global slot) ──── */

    const SLOT = '__dshChatZhihu__'
    const shared = (globalThis[SLOT] = globalThis[SLOT] || {
      boss: readFlag('dsh-chat-zhihu:boss'),
      config: Object.assign({}, DEFAULT_CONFIG),
      cookieSet: false,
      cards: 0,
      listeners: new Set(),
      pages: new Map(), // target key → page state
      guest: null, // the hidden webview, see below
      planted: '', // partition the stored cookie was planted into
      login: 'unknown', // 'in' | 'out' | 'unknown' — what the hidden webview last saw
      version: 0, // bumps on every emit, for useSyncExternalStore
    })
    if (!shared.login) shared.login = 'unknown' // a slot left by an older bundle

    function readFlag(key) {
      try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1'
      } catch {
        return false
      }
    }

    function writeFlag(key, value) {
      try {
        if (typeof localStorage === 'undefined') return
        if (value) localStorage.setItem(key, '1')
        else localStorage.removeItem(key)
      } catch {
        // private mode / quota: keep the in-memory value only
      }
    }

    function readJsonItem(key) {
      try {
        const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
        return raw ? JSON.parse(raw) : null
      } catch {
        return null
      }
    }

    function writeJsonItem(key, value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // ignore
      }
    }

    function emit() {
      shared.version += 1
      for (const listener of Array.from(shared.listeners)) listener()
    }

    function subscribe(listener) {
      shared.listeners.add(listener)
      return () => shared.listeners.delete(listener)
    }

    function useShared(selector) {
      const read = () => selector(shared)
      return React.useSyncExternalStore(subscribe, read, read)
    }

    const selectBoss = (state) => state.boss
    const selectConfig = (state) => state.config
    const selectCookieSet = (state) => state.cookieSet

    function setBoss(value) {
      shared.boss = Boolean(value)
      writeFlag('dsh-chat-zhihu:boss', shared.boss)
      // Nothing of Zhihu stays alive while hidden: drop the hidden webview as well.
      if (shared.boss) destroyGuest()
      emit()
    }

    /* ── api ─────────────────────────────────────────────────────────────── */

    async function call(path, options) {
      const response = await fetch(API + path, options)
      const payload = await response.json().catch(() => null)
      if (!payload) throw new Error(`请求失败（HTTP ${response.status}）`)
      if (payload.ok !== true) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`)
      return payload
    }

    function post(path, body) {
      return call(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    async function refreshConfig() {
      const payload = await call('/config')
      shared.config = payload.config
      shared.cookieSet = Boolean(payload.cookieSet)
      emit()
      return payload.config
    }

    async function saveConfig(patch) {
      const payload = await post('/config', patch)
      shared.config = payload.config
      shared.cookieSet = Boolean(payload.cookieSet)
      emit()
      return payload.config
    }

    /* ── keyboard chords (boss key) ──────────────────────────────────────── */

    /** `KeyboardEvent` → canonical chord, e.g. `Ctrl+Alt+KeyZ`. Uses the physical `code`. */
    function chordOf(event) {
      const parts = []
      if (event.ctrlKey) parts.push('Ctrl')
      if (event.altKey) parts.push('Alt')
      if (event.shiftKey) parts.push('Shift')
      if (event.metaKey) parts.push('Meta')
      parts.push(event.code || '')
      return parts.join('+')
    }

    function isModifierCode(code) {
      return /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code || '')
    }

    /** Human label for a chord: `Ctrl+Alt+KeyZ` → `Ctrl + Alt + Z`. */
    function chordLabel(chord) {
      return String(chord || '')
        .split('+')
        .map((part) => part.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Backquote$/, '`'))
        .join(' + ')
    }

    /**
     * The one window-level listener this plugin owns. It only reacts to the
     * configured modifier chord, and only while a card exists (or the cards are
     * already hidden), so ordinary typing is never touched.
     */
    function onBossKey(event) {
      if (event.isComposing || event.keyCode === 229 || event.repeat || shared.capturing) return
      const chord = shared.config && shared.config.bossKey
      if (!chord || chordOf(event) !== chord) return
      if (shared.cards <= 0 && !shared.boss) return
      event.preventDefault()
      event.stopPropagation()
      setBoss(!shared.boss)
    }

    /* ── targets ─────────────────────────────────────────────────────────── */

    const ID = /^\d{1,24}$/

    function isTarget(value) {
      if (!value || typeof value !== 'object') return false
      if (value.kind === 'hot' || value.kind === 'feed') return true
      if (['question', 'answer', 'article'].indexOf(value.kind) < 0 || !ID.test(String(value.id || ''))) return false
      return value.answer === undefined || (value.kind === 'question' && ID.test(String(value.answer)))
    }

    /** Lists the card shows as an index (click an entry to open it). */
    function isList(target) {
      return Boolean(target) && (target.kind === 'hot' || target.kind === 'feed')
    }

    function keyOf(target) {
      if (!target || target.kind === 'hot') return 'hot'
      if (target.kind === 'feed') return 'feed'
      return target.answer ? `${target.kind}:${target.id}:${target.answer}` : `${target.kind}:${target.id}`
    }

    function targetUrl(target) {
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

    /* ── html → plain blocks ─────────────────────────────────────────────── */
    //
    // Zhihu's rich text is converted, never injected: a tiny tokenizer builds a tree,
    // and only text, image addresses and block structure come out of it. Script,
    // style and <noscript> (which duplicates lazy images) are dropped whole.

    const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
    const INLINE_TAGS = new Set(['a', 'b', 'strong', 'i', 'em', 'span', 'code', 'u', 'sup', 'sub', 'mark', 's', 'del', 'ins', 'font', 'small', 'big', 'abbr', 'cite', 'q', 'label'])
    const CLOSES_P = new Set(['p', 'div', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'figure', 'hr', 'section', 'dl'])
    const SKIP_TAGS = new Set(['script','style', 'noscript', 'template', 'svg', 'iframe', 'video', 'audio', 'button', 'textarea', 'select'])
    const NAMED_ENTITIES = {
      amp: '&',
      lt: '<',
      gt: '>',
      quot: '"',
      apos: "'",
      nbsp: ' ',
      hellip: '…',
      mdash: '—',
      ndash: '–',
      ldquo: '“',
      rdquo: '”',
      lsquo: '‘',
      rsquo: '’',
      middot: '·',
      times: '×',
      divide: '÷',
      deg: '°',
      copy: '©',
      reg: '®',
      trade: '™',
      laquo: '«',
      raquo: '»',
      bull: '•',
    }

    function decodeEntities(text) {
      return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body) => {
        if (body[0] === '#') {
          const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
        }
        const named = NAMED_ENTITIES[body.toLowerCase()]
        return named === undefined ? whole : named
      })
    }

    function parseAttributes(source) {
      const attrs = {}
      const pattern = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
      let match
      while ((match = pattern.exec(source || ''))) {
        const name = match[1].toLowerCase()
        if (attrs[name] !== undefined) continue
        const raw = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : ''
        attrs[name] = decodeEntities(raw)
      }
      return attrs
    }

    /** Parse an HTML fragment into `{ tag, attrs, children }` / `{ text }` nodes. */
    function parseHtml(html) {
      const root = { tag: '#root', attrs: {}, children: [] }
      const stack = [root]
      const pattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g
      const source = String(html || '')
      let match
      let skipDepth = 0
      while ((match = pattern.exec(source))) {
        const top = stack[stack.length - 1]
        if (match[1]) {
          const tag = match[1].toLowerCase()
          let at = stack.length - 1
          while (at > 0 && stack[at].tag !== tag) at -= 1
          if (at > 0) {
            for (let index = stack.length - 1; index >= at; index -= 1) {
              if (SKIP_TAGS.has(stack[index].tag)) skipDepth -= 1
            }
            stack.length = at
          }
        } else if (match[2]) {
          const tag = match[2].toLowerCase()
          const rest = match[3] || ''
          const selfClosing = /\/\s*$/.test(rest)
          const node = { tag, attrs: parseAttributes(rest.replace(/\/\s*$/, '')), children: [] }
          // A block opening inside an open <p> (or a new <li> inside an open <li>) closes
          // it first, as browsers do — through any inline elements left open in between.
          const closes = CLOSES_P.has(tag) ? 'p' : tag === 'li' ? 'li' : ''
          if (closes) {
            let at = stack.length - 1
            while (at > 0 && stack[at].tag !== closes && INLINE_TAGS.has(stack[at].tag)) at -= 1
            if (at > 0 && stack[at].tag === closes) stack.length = at
          }
          const parent = stack[stack.length - 1]
          if (skipDepth === 0) parent.children.push(node)
          if (!VOID_TAGS.has(tag) && !selfClosing) {
            stack.push(node)
            if (SKIP_TAGS.has(tag)) skipDepth += 1
          }
        } else if (match[4] !== undefined) {
          if (skipDepth === 0) top.children.push({ text: decodeEntities(match[4]) })
        } else if (match[0] === '<') {
          if (skipDepth === 0) top.children.push({ text: '<' })
        }
      }
      return root
    }

    const BLOCK_TAGS = new Set([
      'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li',
      'figure', 'figcaption', 'hr', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'dl', 'dt', 'dd',
    ])

    function hasClass(node, name) {
      return (' ' + String(node.attrs && node.attrs.class ? node.attrs.class : '') + ' ').indexOf(' ' + name + ' ') >= 0
    }

    /** A formula image (`eeimg`) reads as its TeX source. */
    function isMath(node) {
      return node.tag === 'img' && (node.attrs.eeimg !== undefined || hasClass(node, 'ztext-math') || /\/equation\?tex=/.test(node.attrs.src || ''))
    }

    function imageSource(node) {
      const attrs = node.attrs || {}
      const candidates = [attrs['data-original'], attrs['data-actualsrc'], attrs['data-default-watermark-src'], attrs.src]
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && /^https:\/\/[\w.-]+\.zhimg\.com\//i.test(candidate)) return candidate
      }
      return ''
    }

    function cleanText(text) {
      return text
        .replace(/[ \t\f\v\r ]*\n[ \t\f\v\r ]*/g, '\n')
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    /** Inline text of a node; images that are not formulas are collected into `images`. */
    function inlineText(node, images) {
      if (node.text !== undefined) return node.text.replace(/[ \t\r\n\f]+/g, ' ')
      if (SKIP_TAGS.has(node.tag)) return ''
      if (node.tag === 'br') return '\n'
      if (node.tag === 'img') {
        if (isMath(node)) {
          const tex = node.attrs.alt || ''
          return tex ? ` $${tex}$ ` : ''
        }
        const src = imageSource(node)
        if (src && images) images.push(src)
        return ''
      }
      if (node.tag === 'a' && hasClass(node, 'LinkCard') && node.attrs['data-text']) return node.attrs['data-text']
      let out = ''
      for (const child of node.children) {
        const piece = inlineText(child, images)
        out += BLOCK_TAGS.has(child.tag) && out && !out.endsWith('\n') ? '\n' + piece : piece
      }
      return out
    }

    function rawText(node) {
      if (node.text !== undefined) return node.text
      if (node.tag === 'br') return '\n'
      return node.children.map(rawText).join('')
    }

    /**
     * Convert Zhihu rich-text HTML into display blocks:
     *   { t: 'p' | 'h' | 'quote' | 'code' | 'li', text, marker? } · { t: 'img', src } · { t: 'hr' }
     */
    function htmlToBlocks(html) {
      const blocks = []
      let pending = ''
      let pendingImages = []

      function flush() {
        const text = cleanText(pending)
        if (text) blocks.push({ t: 'p', text })
        for (const src of pendingImages) blocks.push({ t: 'img', src })
        pending = ''
        pendingImages = []
      }

      function pushText(type, node, extra) {
        const images = []
        const text = cleanText(inlineText(node, images))
        if (text) blocks.push(Object.assign({ t: type, text }, extra || {}))
        for (const src of images) blocks.push({ t: 'img', src })
      }

      function list(node, ordered) {
        let number = Number(node.attrs.start) > 0 ? Number(node.attrs.start) : 1
        for (const child of node.children) {
          if (child.tag === 'li') {
            pushText('li', child, { marker: ordered ? `${number}.` : '•' })
            number += 1
          } else if (child.tag === 'ul' || child.tag === 'ol') {
            list(child, child.tag === 'ol')
          }
        }
      }

      function walk(node) {
        for (const child of node.children) {
          if (child.text !== undefined) {
            pending += child.text.replace(/[ \t\r\n\f]+/g, ' ')
            continue
          }
          const tag = child.tag
          if (SKIP_TAGS.has(tag)) continue
          if (!BLOCK_TAGS.has(tag)) {
            if (tag === 'img' && !isMath(child)) {
              const src = imageSource(child)
              if (src) {
                flush()
                blocks.push({ t: 'img', src })
              }
              continue
            }
            pending += inlineText(child, pendingImages)
            continue
          }
          flush()
          if (tag === 'p') pushText('p', child)
          else if (/^h[1-6]$/.test(tag)) pushText('h', child)
          else if (tag === 'blockquote') pushText('quote', child)
          else if (tag === 'pre') {
            const text = rawText(child).replace(/^\n+|\s+$/g, '')
            if (text) blocks.push({ t: 'code', text })
          } else if (tag === 'ul' || tag === 'ol') list(child, tag === 'ol')
          else if (tag === 'li') pushText('li', child, { marker: '•' })
          else if (tag === 'hr') blocks.push({ t: 'hr' })
          else if (tag === 'figcaption') pushText('p', child, { small: true })
          else if (tag === 'tr') {
            const cells = child.children.filter((cell) => cell.tag === 'td' || cell.tag === 'th')
            const text = cells.map((cell) => cleanText(inlineText(cell)).replace(/\n/g, ' ')).join(' ｜ ')
            if (text.replace(/[\s｜]/g, '')) blocks.push({ t: 'p', text })
          } else walk(child)
        }
        flush()
      }

      walk(parseHtml(html))
      return blocks
    }

    const blockCache = new Map()
    /** htmlToBlocks with a small cache: the same answer re-renders often while scrolling. */
    function blocksOf(html) {
      const key = String(html || '')
      let blocks = blockCache.get(key)
      if (!blocks) {
        blocks = htmlToBlocks(key)
        blockCache.set(key, blocks)
        if (blockCache.size > 400) blockCache.delete(blockCache.keys().next().value)
      }
      return blocks
    }

    /* ── the script that runs inside the Zhihu page ──────────────────────── */
    //
    // Serialised with Function#toString and run through <webview>.executeJavaScript,
    // so it must not reference anything outside its own body. It only reads the page
    // (and, for `more`, scrolls it and presses Zhihu's own "read more" buttons).

    function zhihuGuest(op) {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
      const path = location.pathname
      const onZhihu = /(^|\.)zhihu\.com$/.test(location.hostname)
      const blocked = onZhihu && /^\/(account\/unhuman|signin|signup|login)/.test(path)

      if (op.action === 'probe') {
        const ready =
          document.readyState !== 'loading' &&
          Boolean(document.getElementById('js-initialData') || document.querySelector('.ContentItem, .Post-RichText, .QuestionHeader-title, .Topstory'))
        return { url: location.href, blocked, ready, title: document.title }
      }

      if (op.action === 'cookie') {
        for (const pair of op.pairs || []) {
          document.cookie = `${pair[0]}=${pair[1]}; domain=.zhihu.com; path=/; max-age=31536000; secure; samesite=lax`
        }
        return { ok: true }
      }

      if (blocked) return { blocked: true, url: location.href }

      const number = (value) => {
        if (value === null || value === undefined || value === '') return null
        const parsed = Number(String(value).replace(/,/g, ''))
        return Number.isFinite(parsed) ? parsed : null
      }
      const textOf = (root, selector) => {
        const element = root.querySelector(selector)
        return element ? String(element.textContent || '').trim() : ''
      }
      const readState = () => {
        try {
          const element = document.getElementById('js-initialData')
          return element ? JSON.parse(element.textContent).initialState || {} : {}
        } catch (error) {
          return {}
        }
      }

      /** The home feed: one entry per recommended answer or article (ads, pins and videos skipped). */
      function extractFeed(url) {
        const items = []
        const seen = new Set()
        let cards = document.querySelectorAll('.TopstoryItem')
        if (cards.length === 0) cards = document.querySelectorAll('.Feed')
        for (const card of cards) {
          if (/(^|\s)TopstoryItem--advertCard(\s|$)/.test(card.className || '')) continue
          const content = card.querySelector('.ContentItem')
          const link = card.querySelector('.ContentItem-title a[href]')
          if (!content || !link) continue
          // Ids come from the link text, never from numbers: they pass 2^53.
          const href = link.getAttribute('href') || ''
          let target = null
          let match = /\/question\/(\d+)\/answer\/(\d+)/.exec(href)
          if (match) target = { kind: 'question', id: match[1], answer: match[2] }
          else if ((match = /\/question\/(\d+)/.exec(href))) target = { kind: 'question', id: match[1] }
          else if ((match = /zhuanlan\.zhihu\.com\/p\/(\d+)/.exec(href) || /^\/p\/(\d+)/.exec(href))) target = { kind: 'article', id: match[1] }
          if (!target) continue
          const key = `${target.kind}:${target.id}:${target.answer || ''}`
          if (seen.has(key)) continue
          seen.add(key)
          let zop = {}
          try {
            zop = JSON.parse(content.getAttribute('data-zop') || '{}') || {}
          } catch (error) {
            zop = {}
          }
          const upvote = content.querySelector('meta[itemprop="upvoteCount"]')
          const excerpt = textOf(content, '.RichContent-inner')
            .replace(/\s*阅读全文\s*$/, '')
            .replace(/\s+/g, ' ')
          items.push({
            target,
            title: String(link.textContent || '').trim() || String(zop.title || ''),
            author: String(zop.authorName || '') || textOf(content, '.AuthorInfo-name'),
            excerpt: excerpt.length > 160 ? excerpt.slice(0, 159) + '…' : excerpt,
            votes: number(upvote && upvote.getAttribute('content')),
          })
        }
        return { kind: 'feed', url, items, end: false }
      }

      const feedPage = onZhihu && location.hostname === 'www.zhihu.com' && (path === '/' || path === '/follow')

      function extract() {
        const state = readState()
        const entities = state.entities || {}
        const url = location.href
        if (feedPage) return extractFeed(url)

        const articleMatch = /^\/p\/(\d+)/.exec(path)
        if (location.hostname === 'zhuanlan.zhihu.com' || articleMatch) {
          const id = articleMatch ? articleMatch[1] : ''
          const entity = (entities.articles || {})[id] || {}
          const author = entity.author || {}
          const rich = document.querySelector('.Post-RichText') || document.querySelector('.RichText')
          return {
            kind: 'article',
            url,
            article: {
              id,
              title: entity.title || textOf(document, '.Post-Title'),
              author: author.name || textOf(document, '.AuthorInfo-name'),
              headline: author.headline || '',
              votes: number(entity.voteupCount),
              created: number(entity.created),
              html: entity.content || (rich ? rich.innerHTML : ''),
            },
          }
        }

        const questionMatch = /^\/question\/(\d+)/.exec(path)
        if (!questionMatch) return { kind: 'unknown', url, title: document.title }
        const qid = questionMatch[1]
        const entity = (entities.questions || {})[qid] || {}
        const header = textOf(document, '.List-headerText')
        const question = {
          id: qid,
          title: entity.title || textOf(document, '.QuestionHeader-title'),
          detail: entity.detail || '',
          answerCount: number(entity.answerCount) !== null ? number(entity.answerCount) : number((/([\d,]+)/.exec(header) || [])[1]),
          followers: number(entity.followerCount),
        }

        const answers = []
        const seen = new Set()
        for (const element of document.querySelectorAll('.ContentItem.AnswerItem')) {
          let zop = {}
          try {
            zop = JSON.parse(element.getAttribute('data-zop') || '{}') || {}
          } catch (error) {
            zop = {}
          }
          // Zhihu ids pass 2^53: the `name` attribute keeps the exact digits, while the
          // numeric `itemId` inside data-zop is already rounded by JSON.parse.
          const named = String(element.getAttribute('name') || '')
          const id = /^\d+$/.test(named) ? named : Number.isSafeInteger(zop.itemId) ? String(zop.itemId) : ''
          if (!/^\d+$/.test(id) || seen.has(id)) continue
          seen.add(id)
          const data = (entities.answers || {})[id] || {}
          const author = data.author || {}
          const rich = element.querySelector('.RichContent-inner .RichText') || element.querySelector('.RichText')
          const upvote = element.querySelector('meta[itemprop="upvoteCount"]')
          const collapsed = Boolean(element.querySelector('.RichContent.is-collapsed'))
          answers.push({
            id,
            author: author.name || zop.authorName || textOf(element, '.AuthorInfo-name'),
            headline: author.headline || textOf(element, '.AuthorInfo-badgeText'),
            votes: number(data.voteupCount) !== null ? number(data.voteupCount) : number(upvote && upvote.getAttribute('content')),
            comments: number(data.commentCount),
            created: number(data.createdTime),
            html: data.content || (rich ? rich.innerHTML : ''),
            truncated: collapsed && !data.content,
          })
        }
        // Server-rendered answers the DOM has not shown yet (hydration still running).
        for (const id of Object.keys(entities.answers || {})) {
          const data = entities.answers[id] || {}
          // Entity keys are exact strings; `question.id` is a rounded number, so compare as numbers.
          if (seen.has(id) || !data.content || !data.question || Number(data.question.id) !== Number(qid)) continue
          seen.add(id)
          const author = data.author || {}
          answers.push({
            id,
            author: author.name || '',
            headline: author.headline || '',
            votes: number(data.voteupCount),
            comments: number(data.commentCount),
            created: number(data.createdTime),
            html: data.content,
            truncated: false,
          })
        }
        const end = question.answerCount !== null && answers.length >= question.answerCount
        return { kind: 'question', url, question, answers, end }
      }

      return (async () => {
        const itemSelector = feedPage ? '.TopstoryItem' : '.ContentItem.AnswerItem'
        if (feedPage && op.action !== 'more') {
          // The feed renders after the page itself: give it a moment.
          const deadline = Date.now() + 6000
          while (Date.now() < deadline && !document.querySelector('.TopstoryItem .ContentItem, .Feed .ContentItem')) await sleep(250)
        }
        if (op.action === 'more') {
          const before = document.querySelectorAll(itemSelector).length
          for (let round = 0; round < 3; round += 1) {
            window.scrollTo(0, document.documentElement.scrollHeight)
            await sleep(350)
            window.scrollBy(0, -400)
            await sleep(150)
          }
          window.scrollTo(0, document.documentElement.scrollHeight)
          const deadline = Date.now() + 8000
          while (Date.now() < deadline && document.querySelectorAll(itemSelector).length <= before) await sleep(250)
        }
        if (feedPage) return extract()
        // Expand collapsed answers so the DOM carries their whole text.
        let pressed = 0
        for (const button of document.querySelectorAll('.RichContent.is-collapsed .ContentItem-expandButton, .RichContent.is-collapsed .ContentItem-more')) {
          try {
            button.click()
            pressed += 1
          } catch (error) {
            // ignore
          }
        }
        if (pressed > 0) await sleep(400)
        return extract()
      })()
    }

    const GUEST_SOURCE = zhihuGuest.toString()

    /* ── the hidden webview ──────────────────────────────────────────────── */
    //
    // One leased <webview> kept off-screen, shared by every card; tasks run one at a
    // time. The lease comes from DSH Desktop's own browser bridge, so the guest runs
    // in DSH's isolated, sandboxed browser partition — which lives as long as the app
    // process: a Zhihu sign-in made in it lasts until the app quits. A cookie pasted
    // in Settings is planted into the partition so it survives restarts.

    function desktopBridge() {
      const carrier = typeof window === 'undefined' ? undefined : window.dshDesktop
      const bridge = carrier && carrier.protocolVersion === 1 ? carrier.browser : undefined
      return bridge && typeof bridge.acquire === 'function' && typeof bridge.release === 'function' ? bridge : null
    }

    class NoDesktopError extends Error {}

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    /** Create a leased webview under `parent`; resolves once it may run scripts. */
    function createGuestElement(parent, reservation, className) {
      const element = document.createElement('webview')
      element.className = className
      element.setAttribute('name', reservation.lease)
      element.setAttribute('partition', reservation.partition)
      element.setAttribute('useragent', GUEST_UA)
      element.setAttribute('src', 'about:blank#' + reservation.lease)
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('内嵌网页没有启动')), 15000)
        element.addEventListener(
          'dom-ready',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
      parent.appendChild(element)
      return { element, ready }
    }

    function guestState() {
      if (!shared.guest) shared.guest = { element: null, lease: '', partition: '', container: null, starting: null, chain: Promise.resolve(), at: '' }
      return shared.guest
    }

    function destroyGuest() {
      const guest = guestState()
      const { element, lease, container } = guest
      guest.element = null
      guest.lease = ''
      guest.container = null
      guest.at = ''
      if (element) {
        try {
          element.remove()
        } catch {
          // ignore
        }
      }
      if (container) {
        try {
          container.remove()
        } catch {
          // ignore
        }
      }
      const bridge = desktopBridge()
      if (lease && bridge) Promise.resolve().then(() => bridge.release(lease)).catch(() => {})
    }

    async function startGuest() {
      const guest = guestState()
      if (guest.element) return guest
      if (guest.starting) return guest.starting
      const bridge = desktopBridge()
      if (!bridge) throw new NoDesktopError('正文需要 DSH 桌面版（网页版只能看热榜）')
      guest.starting = (async () => {
        const reservation = await bridge.acquire(WORKSPACE_KEY)
        const container = document.createElement('div')
        container.className = 'dczGuestHost'
        container.setAttribute('aria-hidden', 'true')
        document.body.appendChild(container)
        const made = createGuestElement(container, reservation, 'dczGuest')
        guest.element = made.element
        guest.lease = reservation.lease
        guest.partition = reservation.partition
        guest.container = container
        guest.at = ''
        try {
          await made.ready
        } catch (error) {
          destroyGuest()
          throw error
        }
        return guest
      })()
      try {
        return await guest.starting
      } finally {
        guest.starting = null
      }
    }

    function exec(op) {
      const element = guestState().element
      if (!element) return Promise.reject(new Error('内嵌网页已关闭'))
      return element.executeJavaScript(`(${GUEST_SOURCE})(${JSON.stringify(op)})`, false)
    }

    /** Load `url` and wait until the page is readable (or Zhihu asks for a login). */
    async function navigate(url) {
      const guest = guestState()
      guest.at = ''
      try {
        await guest.element.loadURL(url)
      } catch {
        // ERR_ABORTED on Zhihu's own redirects is fine: the probe below decides.
      }
      const deadline = Date.now() + PAGE_TIMEOUT_MS
      let probe = null
      while (Date.now() < deadline && guest.element) {
        probe = await exec({ action: 'probe' }).catch(() => null)
        if (probe && (probe.blocked || probe.ready)) break
        await sleep(300)
      }
      if (!probe || !(probe.blocked || probe.ready)) throw new Error('知乎页面打不开（超时）')
      return probe
    }

    /** Plant the cookie from Settings into the partition once. */
    async function plantCookie() {
      const guest = guestState()
      if (!shared.cookieSet || shared.planted === guest.partition) return
      const payload = await call('/cookie')
      const pairs = Array.isArray(payload.pairs) ? payload.pairs : []
      if (pairs.length === 0) return
      try {
        await guest.element.loadURL('https://www.zhihu.com/robots.txt')
      } catch {
        // the document is what matters, not the load result
      }
      await exec({ action: 'cookie', pairs })
      shared.planted = guest.partition
      guest.at = ''
    }

    /** Run `work` on the hidden webview after every earlier task has finished. */
    function task(work) {
      const guest = guestState()
      const run = guest.chain.then(async () => {
        await startGuest()
        await plantCookie().catch((error) => console.warn('dsh-chat-zhihu: planting the cookie failed:', error))
        return work(guestState())
      })
      guest.chain = run.catch(() => {})
      return run
    }

    function openInGuest(target) {
      return task(async (guest) => {
        const probe = await navigate(targetUrl(target))
        guest.at = probe.blocked ? '' : keyOf(target)
        if (probe.blocked) return { blocked: true }
        return exec({ action: 'extract' })
      })
    }

    function moreInGuest(target) {
      return task(async (guest) => {
        if (guest.at !== keyOf(target)) {
          const probe = await navigate(targetUrl(target))
          if (probe.blocked) return { blocked: true }
          guest.at = keyOf(target)
        }
        return exec({ action: 'more' })
      })
    }

    /* ── page state ──────────────────────────────────────────────────────── */

    const IDLE = Object.freeze({ status: 'idle' })

    function pageOf(key) {
      return shared.pages.get(key) || IDLE
    }

    function setPage(key, patch) {
      shared.pages.set(key, Object.assign({}, pageOf(key), patch))
      emit()
    }

    /** Merge answers by id, keeping first-seen order; a longer (expanded) copy wins. */
    function mergeAnswers(previous, next) {
      const order = []
      const byId = new Map()
      for (const answer of (previous || []).concat(next || [])) {
        if (!answer || !answer.id) continue
        const known = byId.get(answer.id)
        if (!known) {
          order.push(answer.id)
          byId.set(answer.id, answer)
        } else if (String(answer.html || '').length > String(known.html || '').length) {
          byId.set(answer.id, answer)
        }
      }
      return order.map((id) => byId.get(id))
    }

    function feedKey(item) {
      const target = item && item.target
      return target ? `${target.kind}:${target.id}:${target.answer || ''}` : ''
    }

    /** Merge feed entries, keeping first-seen order; entries without a valid target are dropped. */
    function mergeFeed(previous, next) {
      const seen = new Set()
      const out = []
      for (const item of (previous || []).concat(next || [])) {
        if (!item || !isTarget(item.target) || isList(item.target)) continue
        const key = feedKey(item)
        if (seen.has(key)) continue
        seen.add(key)
        out.push(item)
      }
      return out
    }

    /** Fold one guest result into a page. */
    function applyResult(key, result, append) {
      if (!result) throw new Error('页面没有返回内容')
      if (result.blocked) {
        shared.login = 'out'
        setPage(key, { status: 'login', loadingMore: false })
        return
      }
      if (result.kind === 'feed') {
        shared.login = 'in'
        const previous = append ? pageOf(key).feed || [] : []
        const feed = mergeFeed(previous, result.items)
        if (!append && feed.length === 0) throw new Error('推荐列表是空的（可能还没加载出来，点「刷新」再试）')
        setPage(key, {
          status: 'ready',
          feed,
          end: append && feed.length === previous.length,
          loadingMore: false,
          moreError: '',
          error: '',
        })
        return
      }
      if (result.kind === 'article' && result.article) {
        shared.login = 'in'
        setPage(key, { status: 'ready', article: result.article, error: '' })
        return
      }
      if (result.kind === 'question' && result.question) {
        shared.login = 'in'
        const previous = append ? pageOf(key).answers || [] : []
        const answers = mergeAnswers(previous, result.answers)
        const grew = answers.length > previous.length
        setPage(key, {
          status: 'ready',
          question: result.question,
          answers,
          end: Boolean(result.end) || (append && !grew),
          loadingMore: false,
          moreError: '',
          error: '',
        })
        return
      }
      throw new Error(`没认出这个页面：${result.url || ''}`)
    }

    async function loadPage(target, force) {
      const key = keyOf(target)
      const page = pageOf(key)
      if (!force && page.status !== 'idle') return
      setPage(key, { status: 'loading', error: '' })
      try {
        if (target.kind === 'hot') {
          const payload = await call(force ? '/hot?refresh=1' : '/hot')
          setPage(key, { status: 'ready', hot: payload.items || [], at: payload.at })
          return
        }
        if (!desktopBridge()) {
          setPage(key, { status: 'nodesk' })
          return
        }
        // A refreshed feed is a new set of recommendations, not more of the old one.
        if (force && target.kind === 'feed') setPage(key, { feed: [], end: false })
        applyResult(key, await openInGuest(target), false)
      } catch (error) {
        // The boss key closes the webview under a running load: just load again later.
        if (shared.boss) setPage(key, IDLE)
        else setPage(key, { status: 'error', error: error && error.message ? error.message : String(error) })
      }
    }

    async function loadMore(target) {
      const key = keyOf(target)
      const page = pageOf(key)
      if (page.status !== 'ready' || page.loadingMore || page.end || shared.boss) return
      setPage(key, { loadingMore: true, moreError: '' })
      try {
        applyResult(key, await moreInGuest(target), true)
      } catch (error) {
        setPage(key, { loadingMore: false, moreError: error && error.message ? error.message : String(error) })
      }
    }

    /** After a sign-in: every page that asked for one loads again. */
    function afterLogin() {
      shared.login = 'in'
      guestState().at = ''
      for (const [key, page] of shared.pages) {
        if (page.status === 'login' || page.status === 'error') shared.pages.set(key, IDLE)
      }
      emit()
    }

    /* ── formatting ──────────────────────────────────────────────────────── */

    function compactCount(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number < 0) return ''
      if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)} 万`
      return String(Math.floor(number))
    }

    function clip(text, max) {
      const value = String(text || '')
      return value.length > max ? value.slice(0, max - 1) + '…' : value
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value))
    }

    /** Index of the last offset at or above `line` (offsets ascending). */
    function lastAtOrAbove(offsets, line) {
      let low = 0
      let high = offsets.length - 1
      let found = 0
      while (low <= high) {
        const mid = (low + high) >> 1
        if (offsets[mid] <= line) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return found
    }

    /* ── styles ──────────────────────────────────────────────────────────── */

    const CSS = `
.dczCard{position:relative;margin:2px 0;color:var(--dsw-alias-label-primary);font-size:var(--dcz-font,var(--dsh-content-font-size,15px));line-height:var(--dcz-lh,1.8);border-radius:10px;border:1px solid transparent;outline:none;transition:border-color .18s ease}
.dczCard[data-state="open"]{display:flex;flex-direction:column;overflow:hidden;contain:layout paint;height:max(180px, calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px) - var(--dcz-gutter,44px)))}
.dczCard[data-state="open"]:hover{border-color:var(--dsw-alias-border-l1)}
.dczCard:focus-visible{border-color:var(--dsw-alias-border-l2)}
.dczStream{position:relative;flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;overflow-anchor:none;overscroll-behavior:contain;padding:12px 6px 72px;word-break:break-word;scrollbar-width:thin;scrollbar-color:transparent transparent}
.dczCard:hover .dczStream{scrollbar-color:var(--dsh-scrollbar-thumb,var(--dsw-alias-border-l2)) transparent}
.dczStream p{margin:0 0 .85em;white-space:pre-wrap}
.dczStream .dczH{font-weight:600}
.dczStream .dczTitle{font-weight:600;font-size:1.06em;margin-bottom:.7em}
.dczStream .dczQuote{padding-left:.9em;border-left:3px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.dczStream pre{margin:0 0 .85em;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-family:var(--dsh-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.86em;line-height:1.6;white-space:pre-wrap;overflow-x:auto}
.dczStream .dczLi{display:flex;gap:.5em}
.dczStream .dczLi>span:first-child{flex:none;color:var(--dsw-alias-label-secondary);min-width:1em}
.dczStream .dczSmall{font-size:.86em;color:var(--dsw-alias-label-secondary)}
.dczStream hr{border:0;border-top:1px solid var(--dsw-alias-border-l1);margin:1.3em 0}
.dczStream img{display:block;max-width:100%;max-height:70vh;border-radius:6px;margin:0 0 .85em}
.dczImg{color:var(--dsw-alias-label-tertiary);font-size:.86em}
.dczMeta{color:var(--dsw-alias-label-secondary);font-size:.9em}
.dczHot{display:block;margin:0 0 .5em;cursor:pointer;border-radius:6px}
.dczHot:hover .dczHotTitle{text-decoration:underline;text-underline-offset:3px}
.dczHotHeat{color:var(--dsw-alias-label-tertiary);font-size:.86em;white-space:nowrap}
.dczFeed{margin-bottom:.9em}
.dczStream .dczFeed>p{margin:0}
.dczStream .dczFeed>p.dczFeedSub{margin-top:.15em;font-size:.88em;line-height:1.6;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dczNote{color:var(--dsw-alias-label-secondary);padding:2px 0}
.dczError{color:var(--dsw-alias-state-error-primary,#e5484d);white-space:pre-wrap;padding:2px 6px;font-size:13px;line-height:1.7}
.dczChrome{position:absolute;left:0;right:0;z-index:2;display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);opacity:0;pointer-events:none;transition:opacity .16s ease,transform .16s ease}
.dczHead{top:0;border-bottom:1px solid var(--dsw-alias-border-l1);border-radius:10px 10px 0 0;transform:translateY(-3px)}
.dczBar{bottom:0;border-top:1px solid var(--dsw-alias-border-l1);border-radius:0 0 10px 10px;flex-wrap:wrap;transform:translateY(3px)}
.dczCard:hover>.dczChrome{opacity:1;pointer-events:auto;transform:none}
@media (hover:none){.dczChrome{opacity:1;pointer-events:auto;transform:none}}
.dczHeadTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-weight:600}
.dczPos{white-space:nowrap;font-variant-numeric:tabular-nums}
.dczBtn{padding:2px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dczBtn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
.dczBtn:disabled{opacity:.4;cursor:default}
.dczHint{flex:1;min-width:120px;text-align:right;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dczFold{display:block;padding:0 6px;color:var(--dsw-alias-label-tertiary);letter-spacing:3px;line-height:1.6;user-select:none;cursor:default;outline:none;border-radius:6px}
.dczFold[data-closed="true"]{cursor:pointer;letter-spacing:normal;font-size:12.5px}
.dczFold:focus-visible{box-shadow:0 0 0 1px var(--dsw-alias-border-l2)}
.dczLogin{display:flex;flex-direction:column;flex:1;min-height:0}
.dczLoginBar{display:flex;align-items:center;gap:8px;padding:6px 8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);border-bottom:1px solid var(--dsw-alias-border-l1)}
.dczLoginBar>span{flex:1;min-width:0}
.dczLoginHost{position:relative;flex:1;min-height:0;display:flex}
.dczLoginView{display:flex;flex:auto;width:100%;height:100%;border:0;background:#fff}
.dczGuestHost{position:fixed;left:-30000px;top:0;width:1100px;height:1600px;overflow:hidden;pointer-events:none;opacity:0;z-index:-1}
.dczGuest{display:flex;width:1100px;height:1600px;border:0}
.dczSet{display:flex;flex-direction:column;gap:18px;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dczSetRow{display:grid;grid-template-columns:110px 1fr;gap:12px;align-items:center}
.dczSetRow>label{color:var(--dsw-alias-label-secondary)}
.dczSetCtl{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.dczSetCtl input[type="text"],.dczSetCtl input[type="password"]{flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;outline:none}
.dczSetCtl input:focus{border-color:var(--dsw-alias-brand-primary)}
.dczSetCtl input[type="range"]{flex:1;accent-color:var(--dsw-alias-brand-primary)}
.dczSetCheck{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer}
.dczSetCheck input{accent-color:var(--dsw-alias-brand-primary)}
.dczSetVal{min-width:64px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dczSetMsg{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dczSetMsg[data-error="true"]{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dczSelect{max-width:170px;padding:2px 6px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}
.dczKeyBox{min-width:150px;padding:5px 10px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}
.dczKeyBox[data-capturing="true"]{border-color:var(--dsw-alias-brand-primary);border-style:solid}
`

    function installStyles() {
      if (typeof document === 'undefined' || !document.head) return () => {}
      const element = document.createElement('style')
      element.dataset.plugin = KIND
      element.textContent = CSS
      document.head.append(element)
      return () => element.remove()
    }

    /* ── rendering text ──────────────────────────────────────────────────── */

    function renderBlocks(blocks, showImages, keyPrefix) {
      return blocks.map((block, at) => {
        const key = `${keyPrefix}-${at}`
        switch (block.t) {
          case 'h':
            return h('p', { key, className: 'dczH' }, block.text)
          case 'quote':
            return h('p', { key, className: 'dczQuote' }, block.text)
          case 'code':
            return h('pre', { key }, block.text)
          case 'li':
            return h('p', { key, className: 'dczLi' }, h('span', null, block.marker), h('span', null, block.text))
          case 'hr':
            return h('hr', { key })
          case 'img':
            return showImages
              ? h('img', { key, src: block.src, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', draggable: false })
              : h('p', { key, className: 'dczImg' }, '［图］')
          default:
            return h('p', { key, className: block.small ? 'dczSmall' : undefined }, block.text)
        }
      })
    }

    function answerMeta(answer) {
      const parts = []
      const who = answer.author || '匿名用户'
      parts.push(answer.headline ? `${who}，${clip(answer.headline, 30)}` : who)
      if (answer.votes !== null && answer.votes !== undefined) parts.push(`${compactCount(answer.votes)} 赞同`)
      if (answer.comments) parts.push(`${compactCount(answer.comments)} 评论`)
      return parts.join(' · ')
    }

    /* ── in-card sign-in ─────────────────────────────────────────────────── */

    function isSignedInUrl(url) {
      try {
        const parsed = new URL(url)
        if (!/(^|\.)zhihu\.com$/.test(parsed.hostname)) return false
        return !/^\/(signin|signup|login|account)/.test(parsed.pathname)
      } catch {
        return false
      }
    }

    /**
     * A visible webview inside the card, on Zhihu's own sign-in page. It shares the
     * hidden webview's partition, so a sign-in here is seen there. Leaves on its own
     * once Zhihu navigates away from the sign-in pages.
     */
    function LoginPane({ onDone, onCancel }) {
      const hostRef = React.useRef(null)
      const [error, setError] = React.useState('')
      const doneRef = React.useRef(onDone)
      doneRef.current = onDone

      React.useEffect(() => {
        const bridge = desktopBridge()
        if (!bridge) {
          setError('需要 DSH 桌面版')
          return undefined
        }
        let element = null
        let lease = ''
        let dead = false
        let finished = false
        const check = (event) => {
          if (finished || !event || !isSignedInUrl(event.url)) return
          finished = true
          doneRef.current()
        }
        void (async () => {
          try {
            const reservation = await bridge.acquire(WORKSPACE_KEY)
            lease = reservation.lease
            if (dead || !hostRef.current) {
              bridge.release(lease).catch(() => {})
              lease = ''
              return
            }
            const made = createGuestElement(hostRef.current, reservation, 'dczLoginView')
            element = made.element
            element.addEventListener('did-navigate', check)
            element.addEventListener('did-navigate-in-page', check)
            await made.ready
            if (dead) return
            try {
              await element.loadURL(LOGIN_URL)
            } catch {
              // redirects abort the first load; navigation events decide
            }
          } catch (failure) {
            if (!dead) setError(failure && failure.message ? failure.message : String(failure))
          }
        })()
        return () => {
          dead = true
          if (element) {
            try {
              element.remove()
            } catch {
              // ignore
            }
          }
          if (lease) Promise.resolve().then(() => bridge.release(lease)).catch(() => {})
        }
      }, [])

      return h(
        'div',
        { className: 'dczLogin' },
        h(
          'div',
          { className: 'dczLoginBar' },
          h('span', null, error || '在下面登录知乎（扫码或密码）。登录后自动回来；App 重启后要重新登录，想免登录可在 设置 → 知乎 填 cookie。'),
          h('button', { type: 'button', className: 'dczBtn', onClick: () => doneRef.current() }, '已登录'),
          h('button', { type: 'button', className: 'dczBtn', onClick: onCancel }, '取消'),
        ),
        h('div', { className: 'dczLoginHost', ref: hostRef }),
      )
    }

    /* ── the card ────────────────────────────────────────────────────────── */

    function closedKey(nodeKey) {
      return `dsh-chat-zhihu:closed:${nodeKey}`
    }

    function navKey(nodeKey) {
      return `dsh-chat-zhihu:nav:${nodeKey}`
    }

    const MAX_STACK = 12

    /** Restore a card's navigation stack; anything malformed falls back to the command's target. */
    function readNav(nodeKey, initial) {
      const stored = readJsonItem(navKey(nodeKey))
      const stack = stored && Array.isArray(stored.stack) ? stored.stack.filter((entry) => entry && isTarget(entry.target)) : []
      if (stack.length === 0) return [{ target: initial, scroll: 0 }]
      return stack.slice(-MAX_STACK).map((entry) => ({ target: entry.target, scroll: Math.max(0, Number(entry.scroll) || 0) }))
    }

    function ZhihuCard({ node }) {
      const data = (node && node.data) || {}
      const nodeKey = node && node.key !== undefined ? String(node.key) : ''
      const initial = data.target && isTarget(data.target) ? data.target : null

      const boss = useShared(selectBoss)
      const config = useShared(selectConfig)
      useShared((state) => state.version)

      const [closed, setClosed] = React.useState(() => readFlag(closedKey(nodeKey)))
      const [stack, setStack] = React.useState(() => (initial ? readNav(nodeKey, initial) : []))
      const [login, setLogin] = React.useState(false)
      const [position, setPosition] = React.useState(0) // index of the answer at the top

      const streamRef = React.useRef(null)
      const restoreRef = React.useRef(stack.length ? stack[stack.length - 1].scroll : 0)
      const frameRef = React.useRef(0)
      const saveRef = React.useRef(0)
      const stackRef = React.useRef(stack)
      stackRef.current = stack

      const current = stack.length ? stack[stack.length - 1] : null
      const target = current ? current.target : null
      const key = target ? keyOf(target) : ''
      const page = key ? pageOf(key) : IDLE

      React.useEffect(() => {
        shared.cards += 1
        return () => {
          shared.cards -= 1
        }
      }, [])

      // The card usually mounts while `/zhihu` is still pending; start the stack once
      // the command's target arrives.
      const initialKey = initial ? keyOf(initial) : ''
      React.useEffect(() => {
        if (stack.length > 0 || !initial) return
        const restored = readNav(nodeKey, initial)
        restoreRef.current = restored[restored.length - 1].scroll
        setStack(restored)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [initialKey])

      // Load what the top of the stack shows.
      React.useEffect(() => {
        if (!target || boss || closed) return
        if (pageOf(key).status === 'idle') void loadPage(target, false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [key, page.status, boss, closed])

      React.useEffect(() => () => {
        cancelAnimationFrame(frameRef.current)
        clearTimeout(saveRef.current)
      }, [])

      // Put the saved scroll position back once the view has its content.
      React.useLayoutEffect(() => {
        const element = streamRef.current
        if (!element || restoreRef.current === null || page.status !== 'ready') return
        element.scrollTop = restoreRef.current
        restoreRef.current = null
      })

      function persist(nextStack) {
        writeJsonItem(navKey(nodeKey), { stack: nextStack })
      }

      function rememberScroll() {
        const element = streamRef.current
        const list = stackRef.current
        if (!element || list.length === 0) return list
        const next = list.slice()
        next[next.length - 1] = Object.assign({}, next[next.length - 1], { scroll: Math.round(element.scrollTop) })
        return next
      }

      function push(nextTarget) {
        const next = rememberScroll().concat([{ target: nextTarget, scroll: 0 }]).slice(-MAX_STACK)
        restoreRef.current = 0
        setPosition(0)
        setStack(next)
        persist(next)
      }

      function back() {
        const list = stackRef.current
        if (list.length <= 1) return
        const next = list.slice(0, -1)
        restoreRef.current = next[next.length - 1].scroll
        setPosition(0)
        setStack(next)
        persist(next)
      }

      /** Switch to the hot list or the feed (from a list, replace it; from an answer, go on top). */
      function goList(kind) {
        if (!target || target.kind === kind) return
        if (isList(target)) {
          const next = stackRef.current.slice(0, -1).concat([{ target: { kind }, scroll: 0 }])
          restoreRef.current = 0
          setPosition(0)
          setStack(next)
          persist(next)
          return
        }
        push({ kind })
      }

      function refresh() {
        if (!target) return
        restoreRef.current = 0
        if (streamRef.current) streamRef.current.scrollTop = 0
        void loadPage(target, true)
      }

      function close() {
        writeFlag(closedKey(nodeKey), true)
        setClosed(true)
      }

      function reopen() {
        writeFlag(closedKey(nodeKey), false)
        setClosed(false)
      }

      function answerElements() {
        const element = streamRef.current
        return element ? Array.prototype.slice.call(element.querySelectorAll('[data-answer]')) : []
      }

      function measure() {
        const element = streamRef.current
        if (!element) return
        const answers = answerElements()
        if (answers.length > 0) {
          const offsets = answers.map((answer) => answer.offsetTop)
          const top = element.scrollTop < offsets[0] ? 0 : lastAtOrAbove(offsets, element.scrollTop + 24)
          if (top !== position) setPosition(top)
        }
        const below = element.scrollHeight - element.scrollTop - element.clientHeight
        if (below < LOAD_MARGIN_PX && target && target.kind !== 'hot' && target.kind !== 'article') void loadMore(target) // feed + answers
        clearTimeout(saveRef.current)
        saveRef.current = setTimeout(() => {
          const next = rememberScroll()
          stackRef.current = next
          persist(next)
        }, 600)
      }

      function onScroll() {
        if (frameRef.current) return
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = 0
          measure()
        })
      }

      // A short page may not fill the card: ask for more right away.
      React.useEffect(() => {
        if (page.status === 'ready' && !boss && !closed) measure()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [page.status, page.answers ? page.answers.length : 0, boss, closed])

      function jumpAnswer(direction) {
        const element = streamRef.current
        const answers = answerElements()
        if (!element || answers.length === 0) return
        const next = clamp(position + direction, 0, answers.length - 1)
        element.scrollTop = Math.max(0, answers[next].offsetTop - 8)
        setPosition(next)
      }

      function lineHeightPx() {
        const element = streamRef.current
        if (!element || typeof window.getComputedStyle !== 'function') return 26
        const value = parseFloat(window.getComputedStyle(element).lineHeight)
        return Number.isFinite(value) && value > 0 ? value : 26
      }

      function scrollBy(delta) {
        const element = streamRef.current
        if (element) element.scrollTop += delta
      }

      function pageBy(direction) {
        const element = streamRef.current
        if (element) scrollBy(direction * Math.max(lineHeightPx(), element.clientHeight - 72 - lineHeightPx()))
      }

      /** Keys belong to the card only while it has focus: the composer keeps its keys. */
      function onKeyDown(event) {
        const eventTarget = event.target
        const tag = eventTarget && eventTarget.tagName ? String(eventTarget.tagName).toLowerCase() : ''
        const inField = tag === 'input' || tag === 'textarea' || tag === 'select' || (eventTarget && eventTarget.isContentEditable)
        const modified = event.altKey || event.ctrlKey || event.metaKey
        const keyName = event.key
        let handled = true
        if (modified || inField || login) {
          handled = false
        } else if (keyName === 'Escape' && !event.shiftKey) {
          close()
        } else if (keyName === ' ' || keyName === 'Spacebar') {
          if (tag === 'button') handled = false
          else pageBy(event.shiftKey ? -1 : 1)
        } else if (event.shiftKey) {
          handled = false
        } else if (keyName === 'ArrowDown') {
          scrollBy(lineHeightPx())
        } else if (keyName === 'ArrowUp') {
          scrollBy(-lineHeightPx())
        } else if (keyName === 'ArrowRight' || keyName === 'PageDown') {
          pageBy(1)
        } else if (keyName === 'ArrowLeft' || keyName === 'PageUp') {
          pageBy(-1)
        } else if (keyName === 'j' || keyName === 'J') {
          jumpAnswer(1)
        } else if (keyName === 'k' || keyName === 'K') {
          jumpAnswer(-1)
        } else if (keyName === 'Backspace') {
          back()
        } else {
          handled = false
        }
        if (handled) {
          event.preventDefault()
          event.stopPropagation()
        }
      }

      /* — render — */

      if (data.status === 'error') {
        return h('div', { className: 'dczCard', 'data-state': 'error' }, h('div', { className: 'dczError' }, `/zhihu：${data.error || '打开失败'}`))
      }

      // Boss key: the whole card collapses to one inert line. The text is unmounted,
      // not hidden, and the hidden webview is released as well.
      if (boss) {
        return h('div', { className: 'dczCard', 'data-state': 'boss' }, h('div', { className: 'dczFold', 'aria-hidden': 'true' }, '···'))
      }

      if (closed) {
        return h(
          'div',
          { className: 'dczCard', 'data-state': 'closed' },
          h(
            'div',
            {
              className: 'dczFold',
              'data-closed': 'true',
              role: 'button',
              tabIndex: 0,
              title: '点击展开',
              onClick: reopen,
              onKeyDown: (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  reopen()
                }
              },
            },
            '··· 已合上，点击展开',
          ),
        )
      }

      if (data.status !== 'ready' || !target) {
        return h('div', { className: 'dczCard', 'data-state': 'pending' }, h('p', { className: 'dczNote' }, '…'))
      }

      const style = { '--dcz-lh': String(config.lineHeight || 1.8) }
      if (config.fontSize > 0) style['--dcz-font'] = `${config.fontSize}px`

      if (login) {
        return h(
          'div',
          { className: 'dczCard', 'data-state': 'open', style },
          h(LoginPane, {
            onDone: () => {
              setLogin(false)
              afterLogin()
            },
            onCancel: () => setLogin(false),
          }),
        )
      }

      const body = []
      let headTitle = ''
      let pos = ''

      if (page.status === 'loading' || page.status === 'idle') {
        body.push(h('p', { key: 'loading', className: 'dczNote' }, '…'))
      } else if (page.status === 'error') {
        body.push(h('p', { key: 'error', className: 'dczError' }, page.error || '加载失败'))
        body.push(h('p', { key: 'retry' }, h('button', { type: 'button', className: 'dczBtn', onClick: refresh }, '重试')))
      } else if (page.status === 'nodesk') {
        body.push(h('p', { key: 'nodesk', className: 'dczNote' }, '这部分内容需要在 DSH 桌面版里打开（网页版只能看热榜）。'))
      } else if (page.status === 'login') {
        body.push(h('p', { key: 'login', className: 'dczNote' }, '知乎要求登录后才能看这部分内容。'))
        body.push(
          h(
            'p',
            { key: 'login-actions' },
            h('button', { type: 'button', className: 'dczBtn', onClick: () => setLogin(true) }, '在这里登录'),
            ' ',
            h('button', { type: 'button', className: 'dczBtn', onClick: refresh }, '重试'),
          ),
        )
      } else if (target.kind === 'hot') {
        headTitle = '热榜'
        const items = page.hot || []
        items.forEach((item, at) => {
          body.push(
            h(
              'p',
              {
                key: item.id,
                className: 'dczHot',
                role: 'link',
                onClick: () => push({ kind: 'question', id: item.id }),
              },
              `${at + 1}. `,
              h('span', { className: 'dczHotTitle' }, item.title),
              item.heat ? h('span', { className: 'dczHotHeat' }, `  ${item.heat}`) : null,
            ),
          )
        })
        if (items.length === 0) body.push(h('p', { key: 'empty', className: 'dczNote' }, '热榜是空的'))
      } else if (target.kind === 'feed') {
        headTitle = '推荐'
        const items = page.feed || []
        items.forEach((item, at) => {
          const by = [item.author, item.votes ? `${compactCount(item.votes)} 赞同` : ''].filter(Boolean).join(' · ')
          body.push(
            h(
              'div',
              {
                key: feedKey(item),
                className: 'dczHot dczFeed',
                role: 'link',
                onClick: () => push(item.target),
              },
              h('p', null, `${at + 1}. `, h('span', { className: 'dczHotTitle' }, item.title || '（无标题）')),
              by || item.excerpt ? h('p', { className: 'dczFeedSub' }, by && item.excerpt ? `${by}：${item.excerpt}` : by || item.excerpt) : null,
            ),
          )
        })
        if (page.loadingMore) body.push(h('p', { key: 'more', className: 'dczNote' }, '…'))
        else if (page.moreError)
          body.push(
            h(
              'p',
              { key: 'more-error', className: 'dczNote' },
              page.moreError,
              ' ',
              h('button', { type: 'button', className: 'dczBtn', onClick: () => loadMore(target) }, '重试'),
            ),
          )
        else if (page.end)
          body.push(
            h(
              'p',
              { key: 'end', className: 'dczNote' },
              '（暂时没有更多推荐）',
              h(
                'button',
                {
                  type: 'button',
                  className: 'dczBtn',
                  style: { marginLeft: '8px' },
                  onClick: () => {
                    setPage(key, { end: false })
                    void loadMore(target)
                  },
                },
                '再试一次',
              ),
            ),
          )
      } else if (page.article) {
        const article = page.article
        headTitle = article.title
        body.push(h('p', { key: 'title', className: 'dczTitle' }, article.title))
        body.push(h('p', { key: 'meta', className: 'dczMeta' }, answerMeta(article)))
        body.push.apply(body, renderBlocks(blocksOf(article.html), config.showImages, 'article'))
      } else if (page.question) {
        const question = page.question
        const answers = page.answers || []
        headTitle = question.title
        const total = question.answerCount !== null && question.answerCount !== undefined ? question.answerCount : answers.length
        pos = answers.length ? `${Math.min(position + 1, answers.length)}/${total}` : ''
        body.push(h('p', { key: 'title', className: 'dczTitle' }, question.title))
        if (question.detail) body.push.apply(body, renderBlocks(blocksOf(question.detail), config.showImages, 'detail'))
        answers.forEach((answer, at) => {
          body.push(
            h(
              'div',
              { key: answer.id, 'data-answer': String(at) },
              at > 0 || question.detail ? h('hr') : null,
              h('p', { className: 'dczMeta' }, answerMeta(answer)),
              renderBlocks(blocksOf(answer.html), config.showImages, answer.id),
              answer.truncated ? h('p', { className: 'dczSmall' }, '（这条回答没有展开完整）') : null,
            ),
          )
        })
        if (answers.length === 0) body.push(h('p', { key: 'none', className: 'dczNote' }, '还没有回答'))
        if (page.loadingMore) body.push(h('p', { key: 'more', className: 'dczNote' }, '…'))
        else if (page.moreError)
          body.push(
            h(
              'p',
              { key: 'more-error', className: 'dczNote' },
              page.moreError,
              ' ',
              h('button', { type: 'button', className: 'dczBtn', onClick: () => loadMore(target) }, '重试'),
            ),
          )
        else if (page.end && answers.length > 0)
          body.push(
            h(
              'p',
              { key: 'end', className: 'dczNote' },
              answers.length < total ? `（已加载 ${answers.length} 条，后面的没加载出来）` : '（没有更多了）',
              answers.length < total
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dczBtn',
                      style: { marginLeft: '8px' },
                      onClick: () => {
                        setPage(key, { end: false })
                        void loadMore(target)
                      },
                    },
                    '再试一次',
                  )
                : null,
            ),
          )
      }

      const canBack = stack.length > 1
      const isQuestion = page.status === 'ready' && Boolean(page.question)

      return h(
        'div',
        { className: 'dczCard', 'data-state': 'open', tabIndex: 0, style, onKeyDown },
        h('div', { className: 'dczStream', key, ref: streamRef, onScroll }, body),
        h(
          'div',
          { className: 'dczChrome dczHead' },
          h('span', { className: 'dczHeadTitle', title: headTitle }, headTitle || ' '),
          pos ? h('span', { className: 'dczPos' }, pos) : null,
        ),
        h(
          'div',
          { className: 'dczChrome dczBar' },
          h('button', { type: 'button', className: 'dczBtn', disabled: !canBack, onClick: back }, '返回'),
          h('button', { type: 'button', className: 'dczBtn', disabled: target.kind === 'feed', onClick: () => goList('feed') }, '推荐'),
          h('button', { type: 'button', className: 'dczBtn', disabled: target.kind === 'hot', onClick: () => goList('hot') }, '热榜'),
          isQuestion ? h('button', { type: 'button', className: 'dczBtn', disabled: position <= 0, onClick: () => jumpAnswer(-1) }, '上一个') : null,
          isQuestion
            ? h('button', { type: 'button', className: 'dczBtn', disabled: position + 1 >= (page.answers || []).length, onClick: () => jumpAnswer(1) }, '下一个')
            : null,
          h('button', { type: 'button', className: 'dczBtn', onClick: refresh }, '刷新'),
          // Only when Zhihu has turned us away; a signed-in card has nothing to sign in to.
          desktopBridge() && shared.login === 'out' ? h('button', { type: 'button', className: 'dczBtn', onClick: () => setLogin(true) }, '登录') : null,
          h('button', { type: 'button', className: 'dczBtn', onClick: close }, '合上'),
          h('span', { className: 'dczHint' }, `点卡片后：空格 翻页 · J/K 回答 · ⌫ 返回 · Esc 合上 · ${chordLabel(config.bossKey)} 老板键`),
        ),
      )
    }

    /** The generic command row would show `/zhihu` and its JSON result; the card replaces it. */
    function HiddenCommandRow() {
      return null
    }

    /* ── the chat node definition ────────────────────────────────────────── */

    /**
     * Fold `/zhihu`'s durable lifecycle into one chat node.
     *
     * `command/run` (name === 'zhihu') starts the context; the built-in command node for
     * the same run renders through the `zhihu` commandview slot, which is empty.
     * `command/done` carries no name, so every one is offered as an update; the
     * assembler only applies it to a context whose start it has seen — i.e. ours.
     */
    const cardDefinition = {
      kind: KIND,
      target: 'chat',
      match(event) {
        if (!event || !event.data) return null
        if (event.type === 'command/run' && event.data.name === COMMAND) {
          // Not `exclusive`: the built-in command Definition must still see this run so
          // its node resolves to our empty commandview below.
          return { id: String(event.data.commandId), role: 'start' }
        }
        if (event.type === 'command/done') return { id: String(event.data.commandId), role: 'update' }
        return null
      },
      start(context, match) {
        const event = match && match.event ? match.event : {}
        return { status: 'pending', target: null, error: '', time: event.time === undefined ? null : event.time }
      },
      update(context, match) {
        const data = match.event.data || {}
        const time = context.state ? context.state.time : null
        if (data.kind !== 'success') return { status: 'error', target: null, error: String(data.text || '命令没有成功'), time }
        try {
          const parsed = JSON.parse(String(data.text))
          if (!parsed || !isTarget(parsed.target)) throw new Error('missing target')
          const target = { kind: parsed.target.kind }
          if (parsed.target.id !== undefined) target.id = String(parsed.target.id)
          if (parsed.target.answer !== undefined) target.answer = String(parsed.target.answer)
          return { status: 'ready', target, error: '', time }
        } catch {
          return { status: 'error', target: null, error: '无法解析 /zhihu 的返回值', time }
        }
      },
      buildViewNode(context) {
        if (context.start === undefined || !context.state) return null
        const state = context.state
        return {
          key: context.key,
          kind: KIND,
          id: context.id,
          target: 'chat',
          anchorSeq: context.start.event.seq,
          location: context.start.location,
          visibility: 'visible',
          data: { status: state.status, target: state.target, error: state.error, time: state.time },
        }
      },
    }

    /* ── settings section ────────────────────────────────────────────────── */

    function Settings() {
      const config = useShared(selectConfig)
      const cookieSet = useShared(selectCookieSet)
      const [title, setTitle] = React.useState(config.sessionTitle || '')
      const typedTitle = React.useRef(false)
      const [cookie, setCookie] = React.useState('')
      const [message, setMessage] = React.useState({ text: '', error: false })
      const [capturing, setCapturing] = React.useState(false)

      function say(text, error) {
        setMessage({ text: text || '', error: Boolean(error) })
      }

      React.useEffect(() => {
        refreshConfig()
          .then((loaded) => {
            if (!typedTitle.current) setTitle(loaded.sessionTitle || '')
          })
          .catch((error) => say(error.message, true))
      }, [])

      async function persist(patch, okText) {
        try {
          await saveConfig(patch)
          say(okText || '已保存', false)
          return true
        } catch (error) {
          say(error.message, true)
          return false
        }
      }

      async function saveCookie(value) {
        try {
          const payload = await post('/cookie', { cookie: value })
          shared.cookieSet = Boolean(payload.cookieSet)
          shared.planted = ''
          destroyGuest()
          afterLogin()
          setCookie('')
          say(payload.cookieSet ? `已保存 cookie（${payload.names.length} 项），下次打开知乎内容时生效` : '已清除 cookie', false)
        } catch (error) {
          say(error.message, true)
        }
      }

      const pending = React.useRef(null)
      function applySoon(patch) {
        shared.config = Object.assign({}, shared.config, patch)
        emit()
        clearTimeout(pending.current)
        pending.current = setTimeout(() => void persist(patch), 350)
      }

      React.useEffect(() => {
        if (!capturing) return undefined
        shared.capturing = true
        const onKey = (event) => {
          if (event.isComposing || event.keyCode === 229) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
            setCapturing(false)
            say('已取消', false)
            return
          }
          if (isModifierCode(event.code)) return
          const chord = chordOf(event)
          setCapturing(false)
          void persist({ bossKey: chord }, `老板键已设为 ${chordLabel(chord)}`)
        }
        window.addEventListener('keydown', onKey, true)
        return () => {
          shared.capturing = false
          window.removeEventListener('keydown', onKey, true)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [capturing])

      const row = (label, control) => h('div', { className: 'dczSetRow' }, h('label', null, label), h('div', { className: 'dczSetCtl' }, control))
      const fontOptions = [0, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 28]
      const check = (checked, onChange, text) =>
        h('label', { className: 'dczSetCheck' }, h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }), h('span', { className: 'dczSetMsg' }, text))

      return h(
        'div',
        { className: 'dczSet' },
        row(
          '知乎 cookie',
          h(
            React.Fragment,
            null,
            h('input', {
              type: 'password',
              value: cookie,
              spellCheck: false,
              autoComplete: 'off',
              placeholder: cookieSet ? '已保存（粘贴新的可替换）' : '粘贴浏览器里 zhihu.com 的完整 Cookie（需含 z_c0）',
              onChange: (event) => setCookie(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter' && cookie.trim()) void saveCookie(cookie)
              },
            }),
            h('button', { type: 'button', className: 'dczBtn', disabled: !cookie.trim(), onClick: () => void saveCookie(cookie) }, '保存'),
            cookieSet ? h('button', { type: 'button', className: 'dczBtn', onClick: () => void saveCookie('') }, '清除') : null,
          ),
        ),
        h(
          'div',
          { className: 'dczSetMsg' },
          '不填也能用：在知乎卡片里点「登录」扫码即可，但 App 重启后要重新登录。cookie 只保存在本机 $DSH_HOME/dsh-chat-zhihu/cookie.json（权限 600），只用于这个插件的内嵌网页。',
        ),
        row(
          '字号',
          h(
            'select',
            { className: 'dczSelect', value: String(config.fontSize), onChange: (event) => void persist({ fontSize: Number(event.target.value) }) },
            fontOptions.map((size) => h('option', { key: size, value: String(size) }, size === 0 ? '跟随会话字号' : `${size} px`)),
          ),
        ),
        row(
          '行距',
          h(
            React.Fragment,
            null,
            h('input', {
              type: 'range',
              min: '1.2',
              max: '2.6',
              step: '0.1',
              value: String(config.lineHeight),
              onChange: (event) => applySoon({ lineHeight: Number(event.target.value) }),
            }),
            h('span', { className: 'dczSetVal' }, Number(config.lineHeight).toFixed(1)),
          ),
        ),
        row(
          '/zhihu 默认',
          h(
            React.Fragment,
            null,
            h(
              'select',
              { className: 'dczSelect', value: config.defaultView === 'hot' ? 'hot' : 'feed', onChange: (event) => void persist({ defaultView: event.target.value }) },
              h('option', { value: 'feed' }, '推荐'),
              h('option', { value: 'hot' }, '热榜'),
            ),
            h('span', { className: 'dczSetMsg' }, '不带参数输入 /zhihu 时打开哪个；也可以直接输入 /zhihu 推荐 或 /zhihu 热榜'),
          ),
        ),
        row('显示图片', check(config.showImages === true, (value) => void persist({ showImages: value }), '默认关闭：图片最容易露馅，关闭时只显示一个小小的［图］')),
        row(
          '老板键',
          h(
            React.Fragment,
            null,
            h(
              'button',
              {
                type: 'button',
                className: 'dczKeyBox',
                'data-capturing': capturing ? 'true' : 'false',
                onClick: () => {
                  say('请按下新的组合键（需含 Ctrl / Alt / Meta 之一），Esc 取消', false)
                  setCapturing(true)
                },
              },
              capturing ? '请按组合键…' : chordLabel(config.bossKey),
            ),
            h('span', { className: 'dczSetMsg' }, '按一次全部折叠为 ···（内容从页面移除，后台网页也关掉），再按恢复'),
          ),
        ),
        row(
          '常驻侧边栏',
          check(config.keepSession !== false, (value) => void persist({ keepSession: value }), '在新会话里 /zhihu 后，让这个会话留在侧边栏（不调用模型，不消耗 token）'),
        ),
        row(
          '会话标题',
          h(
            React.Fragment,
            null,
            h('input', {
              type: 'text',
              value: title,
              maxLength: 40,
              spellCheck: false,
              placeholder: '留空则用「资料整理」',
              disabled: config.keepSession === false,
              onChange: (event) => {
                typedTitle.current = true
                setTitle(event.target.value)
              },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void persist({ sessionTitle: title })
              },
            }),
            h('button', { type: 'button', className: 'dczBtn', disabled: config.keepSession === false, onClick: () => void persist({ sessionTitle: title }) }, '保存'),
          ),
        ),
        message.text ? h('div', { className: 'dczSetMsg', 'data-error': message.error ? 'true' : 'false' }, message.text) : null,
      )
    }

    /* ── plugin ──────────────────────────────────────────────────────────── */

    const name = KIND
    const inject = ['slots', 'uiConversation']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-chat-zhihu: styles')

      // Config first, so the boss key and the card's font are right on first paint.
      ctx.effect(() => {
        refreshConfig().catch(() => {})
        return () => {}
      }, 'dsh-chat-zhihu: config')

      ctx.effect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => {}
        window.addEventListener('keydown', onBossKey, true)
        return () => window.removeEventListener('keydown', onBossKey, true)
      }, 'dsh-chat-zhihu: boss key')

      // The hidden webview belongs to this plugin's lifetime.
      ctx.effect(() => () => destroyGuest(), 'dsh-chat-zhihu: hidden webview')

      ctx.effect(() => ctx.uiConversation.events.register(cardDefinition), 'dsh-chat-zhihu: chat node')

      ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: KIND }, ZhihuCard))
      ctx.slots.inject('conversation.chat.commandview', () =>
        ctx.slots.register({ name: 'conversation.chat.commandview', key: COMMAND }, HiddenCommandRow),
      )
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: KIND, order: 23, label: '知乎' }, Settings))
    }

    // Extra keys are for the test suite; the loader reads name / inject / apply.
    module.exports = {
      name,
      inject,
      apply,
      cardDefinition,
      htmlToBlocks,
      parseHtml,
      decodeEntities,
      mergeAnswers,
      mergeFeed,
      isList,
      applyResult,
      pageOf,
      keyOf,
      isTarget,
      targetUrl,
      isSignedInUrl,
      compactCount,
      answerMeta,
      chordOf,
      chordLabel,
      onBossKey,
      lastAtOrAbove,
      readNav,
      zhihuGuest,
      shared,
      setBoss,
    }
    return module.exports
  },
})

// The browser bundle's loader contract: one ModuleLoader registration, only `react`
// required, the declared services are the only ones touched, the `/zhihu` lifecycle
// folds into one card node, Zhihu HTML becomes plain blocks, and the guest script
// reads Zhihu's page data on its own.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

const REACT_STUB = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  memo: (component) => component,
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (reducer, initial) => [initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useRef: (initial) => ({ current: initial }),
  useSyncExternalStore: (subscribe, get) => get(),
}

function makeWindow() {
  const listeners = []
  return {
    listeners,
    addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
    removeEventListener: (type, fn) => {
      const at = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (at >= 0) listeners.splice(at, 1)
    },
  }
}

function loadBundle({ fetch, storage } = {}) {
  const registrations = []
  const window = makeWindow()
  window.__ModuleLoader__ = { load: (registration) => registrations.push(registration) }
  const required = []
  const items = new Map(Object.entries(storage || {}))
  const sandbox = {
    window,
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: fetch || (() => Promise.reject(new Error('network disabled in tests'))),
    localStorage: {
      getItem: (key) => (items.has(key) ? items.get(key) : null),
      setItem: (key, value) => items.set(key, String(value)),
      removeItem: (key) => items.delete(key),
    },
    setTimeout,
    clearTimeout,
    console,
    URL,
  }
  sandbox.globalThis = sandbox
  runInNewContext(SOURCE, sandbox, { filename: 'lib/client.js' })
  assert.equal(registrations.length, 1)
  const plugin = registrations[0].factory((id) => {
    required.push(id)
    return REACT_STUB
  })
  return { registration: registrations[0], plugin, required, window, sandbox, items }
}

function mount(options) {
  const loaded = loadBundle(options)
  const effects = []
  const definitions = []
  const slots = []
  const ctx = {
    effect: (run, label) => effects.push({ run, label }),
    uiConversation: { events: { register: (definition) => (definitions.push(definition), () => {}) } },
    slots: {
      inject: (key, run) => run(),
      register: (options, component) => (slots.push({ options, component }), () => {}),
    },
  }
  loaded.plugin.apply(ctx)
  const disposers = effects.map((effect) => effect.run())
  return Object.assign(loaded, { effects, definitions, slots, disposers })
}

/** Replay a command lifecycle the way the conversation assembler does. */
function fold(definition, run, done) {
  const startMatch = definition.match({ type: 'command/run', seq: 11, time: run.time, data: run })
  if (startMatch === null) return { startMatch, node: null }
  const startEvent = { type: 'command/run', seq: 11, time: run.time, data: run }
  const start = { event: startEvent, role: 'start', location: { turn: 2, step: 0 } }
  let context = { key: `${definition.kind}:${startMatch.id}`, id: startMatch.id, start, state: undefined }
  context.state = definition.start(context, start)
  if (done) {
    const updateMatch = definition.match({ type: 'command/done', seq: 12, data: done })
    if (updateMatch && updateMatch.id === startMatch.id) {
      context = Object.assign({}, context, { state: definition.update(context, { event: { type: 'command/done', seq: 12, data: done } }) })
    }
  }
  return { startMatch, node: definition.buildViewNode(context) }
}

/** Strip vm-realm prototypes so deepEqual compares structure only. */
const plain = (value) => JSON.parse(JSON.stringify(value))

/* ── loader contract ─────────────────────────────────────────────────────── */

test('one ModuleLoader registration under the package id; only react is required', () => {
  const { registration, plugin, required } = loadBundle()
  assert.equal(registration.id, 'dsh-chat-zhihu')
  assert.deepEqual([...new Set(required)], ['react'])
  assert.equal(plugin.name, 'dsh-chat-zhihu')
})

test('every ctx.<service> the bundle touches is declared in inject', () => {
  const { plugin } = loadBundle()
  assert.deepEqual([...plugin.inject].sort(), ['slots', 'uiConversation'])
  const builtins = new Set(['effect', 'inject', 'get', 'on', 'off', 'logger'])
  for (const [, service] of SOURCE.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) {
    if (builtins.has(service)) continue
    assert.ok(plugin.inject.includes(service), `ctx.${service} used but not injected`)
  }
})

test('apply registers the card node, the empty commandview, settings and one capture keydown listener', () => {
  const { slots, definitions, window, disposers } = mount()
  assert.equal(definitions.length, 1)
  const names = slots.map((slot) => `${slot.options.name}:${slot.options.key || slot.options.id}`).sort()
  assert.deepEqual(names, ['conversation.chat.commandview:zhihu', 'conversation.chat.node:dsh-chat-zhihu', 'settings.section:dsh-chat-zhihu'])
  const commandview = slots.find((slot) => slot.options.name === 'conversation.chat.commandview')
  assert.equal(commandview.component(), null)
  assert.deepEqual(
    window.listeners.map((entry) => [entry.type, entry.capture]),
    [['keydown', true]],
  )
  for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  assert.equal(window.listeners.length, 0)
})

/* ── the chat node ───────────────────────────────────────────────────────── */

test('/zhihu run + done fold into one card node carrying the target', () => {
  const { plugin } = loadBundle()
  const definition = plugin.cardDefinition
  const { node } = fold(
    definition,
    { name: 'zhihu', commandId: 'c1', time: 5 },
    { commandId: 'c1', kind: 'success', text: JSON.stringify({ target: { kind: 'question', id: '9', answer: '10' } }) },
  )
  assert.equal(node.kind, 'dsh-chat-zhihu')
  assert.equal(node.anchorSeq, 11)
  assert.deepEqual(plain(node.data), { status: 'ready', target: { kind: 'question', id: '9', answer: '10' }, error: '', time: 5 })
})

test('other commands are ignored; failures and malformed results become error cards', () => {
  const { plugin } = loadBundle()
  const definition = plugin.cardDefinition
  assert.equal(fold(definition, { name: 'read', commandId: 'c2' }).startMatch, null)
  const failed = fold(definition, { name: 'zhihu', commandId: 'c3' }, { commandId: 'c3', kind: 'error', text: '只支持 zhihu.com 的链接' })
  assert.equal(failed.node.data.status, 'error')
  assert.equal(failed.node.data.error, '只支持 zhihu.com 的链接')
  const malformed = fold(definition, { name: 'zhihu', commandId: 'c4' }, { commandId: 'c4', kind: 'success', text: '{"target":{"kind":"people","id":"x"}}' })
  assert.equal(malformed.node.data.status, 'error')
  const pending = fold(definition, { name: 'zhihu', commandId: 'c5' })
  assert.equal(pending.node.data.status, 'pending')
})

/* ── html → blocks ───────────────────────────────────────────────────────── */

test('Zhihu rich text becomes plain blocks; scripts, noscript and foreign images are dropped', () => {
  const { plugin } = loadBundle()
  const html = [
    '<p data-pid="a">第一段 <b>加粗</b> &amp; 实体&#x4E00;<br/>换行</p>',
    '<h2>小标题</h2>',
    '<figure data-size="normal"><noscript><img src="https://pic1.zhimg.com/dup.jpg"/></noscript>',
    '<img src="data:image/svg+xml;utf8,&lt;svg&gt;" data-actualsrc="https://pic1.zhimg.com/v2-a_b.jpg" class="lazy"/>',
    '<figcaption>图注</figcaption></figure>',
    '<blockquote>引用<br>两行</blockquote>',
    '<ul><li>甲</li><li>乙</li></ul>',
    '<ol start="3"><li>丙<li>丁</ol>',
    '<div class="highlight"><pre><code class="language-js">const a = 1 &lt; 2\n  return a</code></pre></div>',
    '<p>公式 <img eeimg="1" src="https://www.zhihu.com/equation?tex=x%5E2" alt="x^2"/> 结束</p>',
    '<p><img src="https://evil.example.com/x.png"></p>',
    '<script>alert(1)</script><style>p{}</style>',
    '<hr/>',
    '<p><a class="LinkCard" data-text="链接卡片标题" href="https://example.com">x</a></p>',
    '<table><tr><th>名</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>',
    '裸文字',
  ].join('')
  assert.deepEqual(plain(plugin.htmlToBlocks(html)), [
    { t: 'p', text: '第一段 加粗 & 实体一\n换行' },
    { t: 'h', text: '小标题' },
    { t: 'img', src: 'https://pic1.zhimg.com/v2-a_b.jpg' },
    { t: 'p', text: '图注', small: true },
    { t: 'quote', text: '引用\n两行' },
    { t: 'li', text: '甲', marker: '•' },
    { t: 'li', text: '乙', marker: '•' },
    { t: 'li', text: '丙', marker: '3.' },
    { t: 'li', text: '丁', marker: '4.' },
    { t: 'code', text: 'const a = 1 < 2\n  return a' },
    { t: 'p', text: '公式 $x^2$ 结束' },
    { t: 'hr' },
    { t: 'p', text: '链接卡片标题' },
    { t: 'p', text: '名 ｜ 值' },
    { t: 'p', text: 'a ｜ 1' },
    { t: 'p', text: '裸文字' },
  ])
})

test('the parser survives broken markup', () => {
  const { plugin } = loadBundle()
  assert.deepEqual(plain(plugin.htmlToBlocks('<p>未闭合 <b>粗<p>下一段</div></span>')), [
    { t: 'p', text: '未闭合 粗' },
    { t: 'p', text: '下一段' },
  ])
  assert.deepEqual(plain(plugin.htmlToBlocks('a < b <p title="x>y">c')), [
    { t: 'p', text: 'a < b' },
    { t: 'p', text: 'c' },
  ])
  assert.deepEqual(plain(plugin.htmlToBlocks('')), [])
  assert.equal(plugin.decodeEntities('&#0;&#x110000;&bogus;&lt;'), '&bogus;<')
})

/* ── page state ──────────────────────────────────────────────────────────── */

test('answers merge by id, keep order, and prefer the longer copy', () => {
  const { plugin } = loadBundle()
  const merged = plugin.mergeAnswers(
    [
      { id: '1', html: 'short' },
      { id: '2', html: 'b' },
    ],
    [
      { id: '1', html: 'much longer' },
      { id: '3', html: 'c' },
      { id: '', html: 'no id' },
    ],
  )
  assert.deepEqual(plain(merged), [
    { id: '1', html: 'much longer' },
    { id: '2', html: 'b' },
    { id: '3', html: 'c' },
  ])
})

test('applyResult: a login wall, a question that stops growing, an article', () => {
  const { plugin } = loadBundle()
  assert.equal(plugin.shared.login, 'unknown', 'no login button before Zhihu has said anything')
  plugin.applyResult('question:1', { blocked: true }, false)
  assert.equal(plugin.pageOf('question:1').status, 'login')
  assert.equal(plugin.shared.login, 'out')

  const question = { id: '1', title: 'Q', answerCount: 10 }
  plugin.applyResult('question:1', { kind: 'question', question, answers: [{ id: 'a', html: 'x' }], end: false }, false)
  assert.equal(plugin.pageOf('question:1').status, 'ready')
  assert.equal(plugin.shared.login, 'in', 'a page that loads means the sign-in worked')
  assert.equal(plugin.pageOf('question:1').end, false)
  plugin.applyResult('question:1', { kind: 'question', question, answers: [{ id: 'a', html: 'x' }], end: false }, true)
  assert.equal(plugin.pageOf('question:1').end, true, 'a load that adds nothing ends the list')

  plugin.applyResult('article:2', { kind: 'article', article: { id: '2', title: 'T', html: '<p>x</p>' } }, false)
  assert.equal(plugin.pageOf('article:2').article.title, 'T')
  assert.throws(() => plugin.applyResult('x', { kind: 'unknown', url: 'https://www.zhihu.com/people/a' }, false), /没认出/)
})

test('formatting helpers', () => {
  const { plugin } = loadBundle()
  assert.equal(plugin.compactCount(999), '999')
  assert.equal(plugin.compactCount(12345), '1.2 万')
  assert.equal(plugin.compactCount(1234567), '123 万')
  assert.equal(plugin.answerMeta({ author: '甲', headline: '乙', votes: 20000, comments: 3 }), '甲，乙 · 2.0 万 赞同 · 3 评论')
  assert.equal(plugin.answerMeta({ author: '', votes: null }), '匿名用户')
  assert.equal(plugin.lastAtOrAbove([0, 100, 200], 150), 1)
  assert.ok(plugin.isSignedInUrl('https://www.zhihu.com/hot'))
  assert.ok(!plugin.isSignedInUrl('https://www.zhihu.com/signin?next=%2Fhot'))
  assert.ok(!plugin.isSignedInUrl('https://www.zhihu.com/account/unhuman?type=x'))
  assert.ok(!plugin.isSignedInUrl('https://evil.com/'))
  assert.ok(!plugin.isSignedInUrl('about:blank#lease'))
})

test('a stored navigation stack is restored, and junk falls back to the command target', () => {
  const stack = { stack: [{ target: { kind: 'hot' }, scroll: 120 }, { target: { kind: 'question', id: '5' }, scroll: 'x' }, { target: { kind: 'evil' } }] }
  const { plugin } = loadBundle({ storage: { 'dsh-chat-zhihu:nav:n1': JSON.stringify(stack), 'dsh-chat-zhihu:nav:n2': '{oops' } })
  assert.deepEqual(plain(plugin.readNav('n1', { kind: 'hot' })), [
    { target: { kind: 'hot' }, scroll: 120 },
    { target: { kind: 'question', id: '5' }, scroll: 0 },
  ])
  assert.deepEqual(plain(plugin.readNav('n2', { kind: 'article', id: '1' })), [{ target: { kind: 'article', id: '1' }, scroll: 0 }])
})

/* ── the card ────────────────────────────────────────────────────────────── */

/** Every element in a REACT_STUB tree, depth first. */
function walkTree(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) walkTree(child, out)
  } else if (node && typeof node === 'object' && 'type' in node) {
    out.push(node)
    walkTree(node.children, out)
  }
  return out
}

test('the card keeps the top of the text clear: one small pill in the corner, no header bar', () => {
  const loaded = mount()
  const { plugin } = loaded
  const card = loaded.slots.find((slot) => slot.options.name === 'conversation.chat.node').component
  plugin.shared.boss = false
  plugin.shared.pages.set('hot', { status: 'ready', hot: [{ id: '1', title: '第一条', heat: '1 万热度' }] })
  const tree = walkTree(card({ node: { key: 'n1', data: { status: 'ready', target: { kind: 'hot' } } } }))
  const classes = tree.map((node) => (node.props && node.props.className) || '')
  assert.ok(!classes.some((name) => /dczHead|dczChrome|dczBar/.test(name)), 'no bar over the text')
  const stream = tree.find((node) => node.props && node.props.className === 'dczStream')
  assert.equal(walkTree(stream.children)[0].props.className, 'dczHot', 'the first entry is the first thing in the stream')
  const pill = tree.find((node) => node.props && node.props.className === 'dczPill')
  assert.ok(pill, 'the pill exists')
  assert.match(pill.props.title, /老板键/, 'the key hints moved into the tooltip')
  const labels = walkTree(pill.children)
    .filter((node) => node.type === 'button')
    .map((node) => node.children.join(''))
  assert.deepEqual(labels, ['推荐', '刷新', '合上'], 'only buttons that do something: no 返回 at the root, no 热榜 on the hot list')
})

test('a question card shows its position in the pill', () => {
  const loaded = mount()
  const { plugin } = loaded
  const card = loaded.slots.find((slot) => slot.options.name === 'conversation.chat.node').component
  plugin.shared.boss = false
  plugin.shared.pages.set('question:5', {
    status: 'ready',
    question: { id: '5', title: 'Q', answerCount: 311 },
    answers: [
      { id: '1', author: '甲', html: '<p>一</p>' },
      { id: '2', author: '乙', html: '<p>二</p>' },
    ],
  })
  const tree = walkTree(card({ node: { key: 'n2', data: { status: 'ready', target: { kind: 'question', id: '5' } } } }))
  const pill = tree.find((node) => node.props && node.props.className === 'dczPill')
  const parts = walkTree(pill.children)
  assert.equal(parts.find((node) => node.props && node.props.className === 'dczPos').children.join(''), '1/311')
  const labels = parts.filter((node) => node.type === 'button').map((node) => node.children.join(''))
  assert.deepEqual(labels, ['推荐', '热榜', '下一个', '刷新', '合上'])
})

/* ── boss key ────────────────────────────────────────────────────────────── */

test('the boss key toggles only with a card on screen, and only on the exact chord', () => {
  const { plugin } = loadBundle()
  const press = (overrides) => {
    let prevented = false
    const event = Object.assign(
      { ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: 'KeyZ', preventDefault: () => (prevented = true), stopPropagation() {} },
      overrides,
    )
    plugin.onBossKey(event)
    return prevented
  }
  assert.equal(press(), false, 'no card mounted: the chord passes through')
  plugin.shared.cards = 1
  assert.equal(press({ code: 'KeyB' }), false)
  assert.equal(press({ shiftKey: true }), false)
  assert.equal(press({ isComposing: true }), false)
  assert.equal(press(), true)
  assert.equal(plugin.shared.boss, true)
  plugin.shared.cards = 0
  assert.equal(press(), true, 'hidden cards can always be brought back')
  assert.equal(plugin.shared.boss, false)
})

/* ── the guest script ────────────────────────────────────────────────────── */

/** A tiny element stand-in: `find` maps a selector to a child element (or null). */
function element({ className = '', attrs = {}, text = '', find = {} } = {}) {
  return {
    className,
    textContent: text,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: (selector) => find[selector] || null,
  }
}

/** A home-feed card the way Zhihu renders one. */
function feedCard({ href, title, zop, votes, excerpt, className = 'Card TopstoryItem' }) {
  const content = element({
    attrs: { 'data-zop': JSON.stringify(zop) },
    find: {
      'meta[itemprop="upvoteCount"]': votes === undefined ? null : element({ attrs: { content: String(votes) } }),
      '.RichContent-inner': element({ text: excerpt }),
    },
  })
  const link = element({ attrs: { href }, text: title })
  return element({ className, find: { '.ContentItem': content, '.ContentItem-title a[href]': link } })
}

function runGuest(plugin, op, { pathname, hostname = 'www.zhihu.com', state, readyState = 'complete', cards = [], main = null }) {
  const cookies = []
  const document = {
    readyState,
    title: 't',
    visibilityState: 'visible',
    body: main,
    getElementById: (id) => (id === 'js-initialData' && state ? { textContent: JSON.stringify({ initialState: state }) } : null),
    querySelector: (selector) => {
      if (cards.length > 0 && /TopstoryItem|Feed/.test(selector)) return cards[0]
      if (main && /main/.test(selector)) return main
      if (main && /answer/.test(selector)) return main
      return null
    },
    querySelectorAll: (selector) => (selector === '.TopstoryItem' ? cards : []),
    documentElement: { scrollHeight: 0 },
    set cookie(value) {
      cookies.push(value)
    },
  }
  const sandbox = {
    location: { pathname, hostname, href: `https://${hostname}${pathname}` },
    document,
    window: { scrollTo() {}, scrollBy() {} },
    setTimeout,
    JSON,
    Number,
    String,
    Boolean,
    Object,
    Date,
    Promise,
    Set,
    RegExp,
  }
  const result = runInNewContext(`(${plugin.zhihuGuest.toString()})(${JSON.stringify(op)})`, sandbox)
  return { result, cookies }
}

test('guest script: probe sees the login wall and readiness', () => {
  const { plugin } = loadBundle()
  assert.equal(runGuest(plugin, { action: 'probe' }, { pathname: '/account/unhuman' }).result.blocked, true)
  const ready = runGuest(plugin, { action: 'probe' }, { pathname: '/question/1', state: {} }).result
  assert.equal(ready.blocked, false)
  assert.equal(ready.ready, true)
  assert.equal(runGuest(plugin, { action: 'probe' }, { pathname: '/question/1', state: {}, readyState: 'loading' }).result.ready, false)
})

test('guest script: reads a question from the page data alone', async () => {
  const { plugin } = loadBundle()
  const state = {
    entities: {
      questions: { 1: { title: '问题标题', detail: '<p>描述</p>', answerCount: 2, followerCount: 9 } },
      answers: {
        11: { content: '<p>回答一</p>', voteupCount: 5, author: { name: '甲', headline: 'h' }, question: { id: 1 } },
        12: { content: '<p>回答二</p>', voteupCount: 1, author: { name: '乙' }, question: { id: 1 } },
        99: { content: '<p>别的问题</p>', question: { id: 2 } },
      },
    },
  }
  const { result } = runGuest(plugin, { action: 'extract' }, { pathname: '/question/1', state })
  const data = plain(await result)
  assert.equal(data.kind, 'question')
  assert.deepEqual(data.question, { id: '1', title: '问题标题', detail: '<p>描述</p>', answerCount: 2, followers: 9 })
  assert.deepEqual(
    data.answers.map((answer) => [answer.id, answer.author, answer.votes]),
    [
      ['11', '甲', 5],
      ['12', '乙', 1],
    ],
  )
  assert.equal(data.end, true)
})

test('guest script: reads the home feed with exact ids, skipping ads and cards without a link', async () => {
  const { plugin } = loadBundle()
  const cards = [
    feedCard({
      href: '//www.zhihu.com/question/2102992165089579738/answer/2103000000000000001',
      title: '  如何评价这场比赛？ ',
      zop: { authorName: '甲', itemId: 2103000000000000001, type: 'answer' },
      votes: 1234,
      excerpt: '甲：这场比赛 非常\n精彩…  阅读全文 ',
    }),
    feedCard({ href: 'https://zhuanlan.zhihu.com/p/42', title: '一篇文章', zop: { authorName: '乙' }, excerpt: 'x'.repeat(300) }),
    feedCard({ href: '//www.zhihu.com/question/7', title: '广告', zop: {}, excerpt: '', className: 'Card TopstoryItem TopstoryItem--advertCard' }),
    feedCard({ href: '//www.zhihu.com/pin/9', title: '想法', zop: {}, excerpt: '' }),
    feedCard({
      href: '//www.zhihu.com/question/2102992165089579738/answer/2103000000000000001',
      title: '重复',
      zop: {},
      excerpt: '',
    }),
  ]
  const data = plain(await runGuest(plugin, { action: 'extract' }, { pathname: '/', cards }).result)
  assert.equal(data.kind, 'feed')
  assert.equal(data.items.length, 2)
  assert.deepEqual(data.items[0], {
    target: { kind: 'question', id: '2102992165089579738', answer: '2103000000000000001' },
    title: '如何评价这场比赛？',
    author: '甲',
    excerpt: '这场比赛 非常 精彩…',
    votes: 1234,
  })
  assert.deepEqual(data.items[1].target, { kind: 'article', id: '42' })
  assert.equal(data.items[1].excerpt.length, 160)
  assert.equal(data.items[1].votes, null)
})

test('guest script: with unfamiliar card markup the feed falls back to links in the main column', async () => {
  const { plugin } = loadBundle()
  const link = (href, text, boxText) =>
    Object.assign(element({ attrs: { href }, text }), {
      closest: () => (boxText ? element({ text: boxText }) : null),
      parentElement: null,
    })
  const links = [
    link('/question/2102992165089579738/answer/2103000000000000001', '一个问题的标题', '一个问题的标题 甲：这是摘要… 阅读全文'),
    link('https://zhuanlan.zhihu.com/p/42', '一篇专栏', null),
    link('/question/5', '短', null),
    link('/people/someone', '某人的主页', null),
  ]
  const main = { querySelectorAll: () => links }
  const data = plain(await runGuest(plugin, { action: 'extract' }, { pathname: '/', main }).result)
  assert.deepEqual(
    data.items.map((item) => [item.target, item.title, item.excerpt]),
    [
      [{ kind: 'question', id: '2102992165089579738', answer: '2103000000000000001' }, '一个问题的标题', '甲：这是摘要…'],
      [{ kind: 'article', id: '42' }, '一篇专栏', ''],
    ],
  )
  assert.equal(data.debug.path, '/')
  assert.equal(data.debug.topstoryItem, 0)
})

test('an empty feed explains what the page looked like', () => {
  const { plugin } = loadBundle()
  assert.throws(
    () => plugin.applyResult('feed', { kind: 'feed', items: [], debug: { path: '/', topstoryItem: 0, visibility: 'hidden' } }, false),
    /诊断：path=\/ · topstoryItem=0 · visibility=hidden/,
  )
})

test('feed entries merge without duplicates; a refreshed empty feed is an error, a stalled one ends', () => {
  const { plugin } = loadBundle()
  const a = { target: { kind: 'question', id: '1', answer: '2' }, title: 'A' }
  const b = { target: { kind: 'article', id: '3' }, title: 'B' }
  const merged = plugin.mergeFeed([a], [a, b, { target: { kind: 'hot' } }, { target: { kind: 'people', id: 'x' } }])
  assert.deepEqual(plain(merged).map((item) => item.title), ['A', 'B'])

  assert.throws(() => plugin.applyResult('feed', { kind: 'feed', items: [] }, false), /空的/)
  plugin.applyResult('feed', { kind: 'feed', items: [a] }, false)
  assert.equal(plugin.pageOf('feed').status, 'ready')
  assert.equal(plugin.pageOf('feed').end, false)
  plugin.applyResult('feed', { kind: 'feed', items: [a, b] }, true)
  assert.equal(plugin.pageOf('feed').feed.length, 2)
  assert.equal(plugin.pageOf('feed').end, false)
  plugin.applyResult('feed', { kind: 'feed', items: [a, b] }, true)
  assert.equal(plugin.pageOf('feed').end, true)
  assert.ok(plugin.isList({ kind: 'feed' }) && plugin.isList({ kind: 'hot' }) && !plugin.isList({ kind: 'article', id: '1' }))
})

/* ── the API script ──────────────────────────────────────────────────────── */

/** Run zhihuApi with a fake fetch. `routes` maps a URL prefix to [status, body]. */
function runApi(plugin, op, routes) {
  const calls = []
  const fetch = async (url) => {
    calls.push(url)
    const hit = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    const [status, body] = hit ? routes[hit] : [404, { error: { message: 'not found' } }]
    return { status, ok: status >= 200 && status < 300, json: async () => body }
  }
  const sandbox = { fetch, encodeURIComponent, Number, String, JSON, Promise }
  return runInNewContext(`(${plugin.zhihuApi.toString()})(${JSON.stringify(op)})`, sandbox).then((result) => ({ result: plain(result), calls }))
}

const ANSWER = (id, qid, extra = {}) => ({
  id,
  type: 'answer',
  content: `<p>正文 ${id}</p>`,
  voteup_count: 12,
  comment_count: 3,
  created_time: 100,
  excerpt: '摘<b>要</b>&amp;更多​',
  author: { name: '甲', headline: '签名' },
  question: { id: qid, title: '问题标题' },
  ...extra,
})

test('API script: the feed keeps answers and articles with exact ids and full text', async () => {
  const { plugin } = loadBundle()
  const body = {
    data: [
      { target: ANSWER('2103070774898717119', '2102992165089579738') },
      { target: { id: '707405801', type: 'article', title: '文章', content: '<p>文</p>', excerpt: 'e', voteup_count: 5, author: { name: '乙' } } },
      { target: { id: '1', type: 'zvideo', title: '视频' } },
      { target: { id: 'x', type: 'answer' } },
      { type: 'feed_advert' },
    ],
    paging: { is_end: false, next: 'https://www.zhihu.com/api/v3/feed/topstory/recommend?page_number=2' },
  }
  const { result, calls } = await runApi(plugin, { kind: 'feed' }, { '/api/v3/feed/topstory/recommend': [200, body] })
  assert.match(calls[0], /^\/api\/v3\/feed\/topstory\/recommend\?desktop=true/)
  assert.equal(result.items.length, 2)
  assert.deepEqual(result.items[0].target, { kind: 'question', id: '2102992165089579738', answer: '2103070774898717119' })
  assert.equal(result.items[0].excerpt, '摘要&更多')
  assert.equal(result.items[0].answer.html, '<p>正文 2103070774898717119</p>')
  assert.deepEqual(result.items[1].target, { kind: 'article', id: '707405801' })
  assert.equal(result.items[1].article.author, '乙')
  assert.equal(result.next, 'https://www.zhihu.com/api/v3/feed/topstory/recommend?page_number=2')
  assert.equal(result.end, false)
})

test('API script: paging only follows Zhihu API links; 401 is a login wall; other errors surface', async () => {
  const { plugin } = loadBundle()
  const evil = { data: [], paging: { is_end: false, next: 'https://evil.example.com/steal' } }
  const { result } = await runApi(plugin, { kind: 'feed' }, { '/api/v3/': [200, evil] })
  assert.equal(result.next, '')
  assert.equal(result.end, true)
  assert.deepEqual((await runApi(plugin, { kind: 'feed' }, { '/api/v3/': [401, { error: { message: 'x' } }] })).result, { blocked: true })
  assert.deepEqual((await runApi(plugin, { kind: 'answer', id: '1' }, { '/api/v4/': [403, { error: { need_login: true } }] })).result, { blocked: true })
  assert.deepEqual((await runApi(plugin, { kind: 'answers', id: '1' }, { '/api/v4/': [403, { error: { message: '请求参数异常' } }] })).result, {
    error: '请求参数异常',
  })
  assert.deepEqual((await runApi(plugin, { kind: 'answers', id: '1/../x' }, {})).result, { error: '问题 id 不对' })
})

test("API script: a question's answers and a single answer", async () => {
  const { plugin } = loadBundle()
  const list = {
    data: [ANSWER('11', '5'), ANSWER('12', '5')],
    paging: { is_end: false, totals: 311, next: 'https://www.zhihu.com/api/v4/questions/5/answers?offset=10' },
  }
  const { result, calls } = await runApi(plugin, { kind: 'answers', id: '5' }, { '/api/v4/questions/5/answers': [200, list] })
  assert.match(calls[0], /include=data%5B\*%5D\.content/)
  assert.deepEqual(result.question, { id: '5', title: '问题标题', answerCount: 311 })
  assert.deepEqual(
    result.answers.map((answer) => [answer.id, answer.author, answer.votes]),
    [
      ['11', '甲', 12],
      ['12', '甲', 12],
    ],
  )
  const next = await runApi(plugin, { kind: 'answers', id: '5', next: list.paging.next }, { 'https://www.zhihu.com/api/v4/questions/5': [200, { data: [], paging: { is_end: true } }] })
  assert.equal(next.calls[0], list.paging.next)
  assert.equal(next.result.end, true)

  const single = await runApi(plugin, { kind: 'answer', id: '11' }, { '/api/v4/answers/11': [200, ANSWER('11', '5')] })
  assert.deepEqual(single.result.question, { id: '5', title: '问题标题', answerCount: null })
  assert.equal(single.result.answer.html, '<p>正文 11</p>')
})

test('feed results seed their answer and article pages, so opening one needs no request', () => {
  const { plugin } = loadBundle()
  const answer = { id: '2', author: '甲', html: '<p>x</p>' }
  const article = { id: '9', title: 'T', html: '<p>y</p>' }
  plugin.applyResult(
    'feed',
    {
      kind: 'feed',
      next: 'https://www.zhihu.com/api/v3/next',
      end: false,
      items: [
        { target: { kind: 'question', id: '1', answer: '2' }, title: 'Q', author: '甲', excerpt: 'e', votes: 1, question: { id: '1', title: 'Q' }, answer },
        { target: { kind: 'article', id: '9' }, title: 'T', author: '乙', excerpt: 'f', votes: 2, article },
      ],
    },
    false,
  )
  const feed = plugin.pageOf('feed')
  assert.equal(feed.next, 'https://www.zhihu.com/api/v3/next')
  assert.equal(feed.feed[0].answer, undefined, 'the list keeps no copy of the text')
  const seeded = plugin.pageOf('question:1:2')
  assert.equal(seeded.status, 'ready')
  assert.equal(seeded.question.title, 'Q')
  assert.equal(seeded.answers[0].html, '<p>x</p>')
  assert.equal(seeded.listed, false)
  assert.equal(plugin.pageOf('article:9').article.title, 'T')

  // Scrolling past the seeded answer lists the question, keeping that answer first.
  assert.deepEqual(plain(plugin.moreRequest({ kind: 'question', id: '1', answer: '2' }, seeded)), { kind: 'answers', id: '1' })
  plugin.applyResult(
    'question:1:2',
    { kind: 'answers', question: { id: '1', title: '', answerCount: 3 }, answers: [{ id: '3', html: 'a' }, { id: '2', html: 'b' }], next: 'https://www.zhihu.com/api/v4/n', end: false },
    true,
  )
  const listed = plugin.pageOf('question:1:2')
  assert.deepEqual(plain(listed.answers.map((item) => item.id)), ['2', '3'])
  assert.equal(listed.question.title, 'Q', 'the known title is kept')
  assert.equal(listed.question.answerCount, 3)
  assert.deepEqual(plain(plugin.moreRequest({ kind: 'question', id: '1', answer: '2' }, listed)), { kind: 'answers', id: '1', next: 'https://www.zhihu.com/api/v4/n' })
})

test('which request starts and continues each page, and when to read the page instead', () => {
  const { plugin } = loadBundle()
  assert.deepEqual(plain(plugin.firstRequest({ kind: 'feed' })), { kind: 'feed' })
  assert.deepEqual(plain(plugin.firstRequest({ kind: 'question', id: '1' })), { kind: 'answers', id: '1' })
  assert.deepEqual(plain(plugin.firstRequest({ kind: 'question', id: '1', answer: '2' })), { kind: 'answer', id: '2' })
  assert.deepEqual(plain(plugin.firstRequest({ kind: 'answer', id: '2' })), { kind: 'answer', id: '2' })
  assert.equal(plugin.firstRequest({ kind: 'article', id: '3' }), null, 'articles come from their page')

  assert.equal(plugin.moreRequest({ kind: 'feed' }, { next: '' }), null)
  assert.deepEqual(plain(plugin.moreRequest({ kind: 'question', id: '1' }, { source: 'page' })), { page: true })
  assert.equal(plugin.moreRequest({ kind: 'question', id: '1' }, { listed: true, next: '', question: { id: '1' } }), null)

  assert.equal(plugin.wantsPage({ error: '请求参数异常' }), true)
  assert.equal(plugin.wantsPage({ blocked: true }), false, 'a login wall is shown, not worked around')
  assert.equal(plugin.wantsPage({ kind: 'answers', answers: [], question: { title: '' } }), true, 'no answers, no title: read the page')
  assert.equal(plugin.wantsPage({ kind: 'answers', answers: [{ id: '1' }], question: { title: 'Q' } }), false)
  assert.throws(() => plugin.applyResult('x', { error: '知乎返回 HTTP 500' }, false), /HTTP 500/)
})

test('guest script: reads an article, refuses unknown pages, plants cookies', async () => {
  const { plugin } = loadBundle()
  const state = { entities: { articles: { 7: { title: '文章', content: '<p>正文</p>', voteupCount: 3, author: { name: '丙' } } } } }
  const article = plain(await runGuest(plugin, { action: 'extract' }, { pathname: '/p/7', hostname: 'zhuanlan.zhihu.com', state }).result)
  assert.equal(article.kind, 'article')
  assert.equal(article.article.title, '文章')
  assert.equal(article.article.author, '丙')
  const unknown = plain(await runGuest(plugin, { action: 'extract' }, { pathname: '/people/x', state: {} }).result)
  assert.equal(unknown.kind, 'unknown')
  const { cookies } = runGuest(plugin, { action: 'cookie', pairs: [['z_c0', 'v']] }, { pathname: '/robots.txt' })
  assert.deepEqual(cookies, ['z_c0=v; domain=.zhihu.com; path=/; max-age=31536000; secure; samesite=lax'])
})

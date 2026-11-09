// Host half: link parsing, config and cookie persistence, the hot list, route
// validation, and the /zhihu command result (a target only — never Zhihu text).

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import test, { before } from 'node:test'

import { API_PREFIX, apply, handleApi, inject, zhihuCommand } from '../index.mjs'
import { dataDirectory, normalizeChord, parseCookie, readConfig, readCookie, validateConfigPatch, writeCookie } from '../lib/store.mjs'
import { clearHotCache, hotList, isTarget, parseHotList, parseTarget, targetUrl } from '../lib/zhihu.mjs'
import { fakeRequest, fakeResponse, tempDir } from './helpers.mjs'

let home

before(async () => {
  home = await tempDir('dcz-home-')
  process.env.DSH_HOME = home
})

async function api(method, path, body) {
  const res = fakeResponse()
  await handleApi(fakeRequest(method, `${API_PREFIX}${path}`, body), res)
  return { status: res.status, body: res.json, headers: res.headers }
}

const HOT_PAYLOAD = {
  data: [
    {
      // The numeric id is already rounded past 2^53; card_id keeps the real one.
      card_id: 'Q_2102992165089579738',
      detail_text: '5607 万热度',
      target: { id: 2102992165089579738, type: 'question', title: '  如何评价\n这场比赛？ ', excerpt: '', answer_count: 1640, follower_count: 2045 },
    },
    { detail_text: 'x', target: { id: 'abc', type: 'question', title: '坏 id' } },
    { detail_text: 'x', target: { id: 1, type: 'article', title: '不是问题' } },
    { target: { id: 42, type: 'question', title: '第二条', answer_count: '12' } },
    { target: { id: 2102992165089579738, type: 'question', title: '只有被截断的数字 id' } },
    { target: { id: 9, url: 'https://api.zhihu.com/questions/2100000000000000001', type: 'question', title: '从 url 取 id' } },
  ],
}

/* ── links ───────────────────────────────────────────────────────────────── */

test('parseTarget understands Zhihu links and short forms', () => {
  assert.deepEqual(parseTarget(''), { kind: 'hot' })
  assert.deepEqual(parseTarget('热榜'), { kind: 'hot' })
  assert.deepEqual(parseTarget('https://www.zhihu.com/question/123'), { kind: 'question', id: '123' })
  assert.deepEqual(parseTarget('https://www.zhihu.com/question/123/'), { kind: 'question', id: '123' })
  assert.deepEqual(parseTarget('www.zhihu.com/question/123/answer/456?utm_psn=1'), { kind: 'question', id: '123', answer: '456' })
  assert.deepEqual(parseTarget('https://www.zhihu.com/answer/456'), { kind: 'answer', id: '456' })
  assert.deepEqual(parseTarget('https://zhuanlan.zhihu.com/p/789'), { kind: 'article', id: '789' })
  assert.deepEqual(parseTarget('123'), { kind: 'question', id: '123' })
  assert.deepEqual(parseTarget('a456'), { kind: 'answer', id: '456' })
  assert.deepEqual(parseTarget('P789'), { kind: 'article', id: '789' })
})

test('parseTarget refuses everything that is not a Zhihu question, answer or article', () => {
  for (const bad of [
    'https://example.com/question/1',
    'https://zhihu.com.evil.com/question/1',
    'https://www.zhihu.com/people/someone',
    'javascript:alert(1)',
    'https://www.zhihu.com/question/1/../../x',
    'x'.repeat(600),
  ]) {
    assert.throws(() => parseTarget(bad), undefined, bad)
  }
})

test('isTarget and targetUrl agree on the shapes', () => {
  assert.ok(isTarget({ kind: 'hot' }))
  assert.ok(isTarget({ kind: 'question', id: '1', answer: '2' }))
  assert.ok(!isTarget({ kind: 'answer', id: '1', answer: '2' }))
  assert.ok(!isTarget({ kind: 'question', id: '1; drop' }))
  assert.ok(!isTarget({ kind: 'people', id: '1' }))
  assert.equal(targetUrl({ kind: 'question', id: '1', answer: '2' }), 'https://www.zhihu.com/question/1/answer/2')
  assert.equal(targetUrl({ kind: 'article', id: '3' }), 'https://zhuanlan.zhihu.com/p/3')
})

/* ── store ───────────────────────────────────────────────────────────────── */

test('config validation clamps numbers and refuses bad values', async () => {
  assert.deepEqual(validateConfigPatch({ fontSize: 99, lineHeight: 0.5 }).value, { fontSize: 28, lineHeight: 1.2 })
  assert.ok(validateConfigPatch({ libraryRoot: '/x' }).errors.length > 0)
  assert.ok(validateConfigPatch({ showImages: 'yes' }).errors.length > 0)
  assert.equal(normalizeChord('ctrl+alt+KeyZ'), 'Ctrl+Alt+KeyZ')
  assert.equal(normalizeChord('KeyZ'), null)
  assert.equal(normalizeChord('Shift+KeyZ'), null)
  const config = await readConfig()
  assert.equal(config.bossKey, 'Ctrl+Alt+KeyZ', 'default chord does not collide with dsh-chat-reader')
  assert.equal(config.showImages, false)
})

test('parseCookie keeps well-formed pairs and refuses injection attempts', () => {
  assert.deepEqual(parseCookie('Cookie: z_c0="2|1:0|abc"; d_c0=xyz; ;').pairs, [
    ['z_c0', '2|1:0|abc'],
    ['d_c0', 'xyz'],
  ])
  assert.ok(parseCookie('a=1\nb=2').errors.length > 0, 'newline is not a cookie octet')
  assert.ok(parseCookie('bad name=1').errors.length > 0)
  assert.ok(parseCookie('noequals').errors.length > 0)
  assert.ok(parseCookie('x'.repeat(9000)).errors.length > 0)
})

test('the cookie lives in a 0600 file and is never echoed back by POST', async () => {
  await assert.rejects(writeCookie('d_c0=xyz'), /z_c0/)
  const { status, body } = await api('POST', '/cookie', { cookie: 'z_c0=secret-token; d_c0=xyz' })
  assert.equal(status, 200)
  assert.deepEqual(body.names, ['z_c0', 'd_c0'])
  assert.ok(!JSON.stringify(body).includes('secret-token'))
  const file = join(dataDirectory(), 'cookie.json')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.match(await readFile(file, 'utf8'), /secret-token/)
  assert.deepEqual(await readCookie(), [
    ['z_c0', 'secret-token'],
    ['d_c0', 'xyz'],
  ])
  const config = await api('GET', '/config')
  assert.equal(config.body.cookieSet, true)
  assert.ok(!JSON.stringify(config.body).includes('secret-token'))

  const cleared = await api('POST', '/cookie', { cookie: '' })
  assert.equal(cleared.body.cookieSet, false)
  assert.deepEqual(await readCookie(), [])
})

/* ── hot list ────────────────────────────────────────────────────────────── */

test('parseHotList keeps questions with numeric ids and tidies text', () => {
  assert.deepEqual(parseHotList(HOT_PAYLOAD), [
    { id: '2102992165089579738', title: '如何评价 这场比赛？', excerpt: '', heat: '5607 万热度', answers: 1640, followers: 2045 },
    { id: '42', title: '第二条', excerpt: '', heat: '', answers: 12, followers: 0 },
    { id: '2100000000000000001', title: '从 url 取 id', excerpt: '', heat: '', answers: 0, followers: 0 },
  ])
  assert.deepEqual(parseHotList(null), [])
  assert.deepEqual(parseHotList({ data: 'nope' }), [])
})

test('hotList caches for a minute and falls back to the cache on failure', async () => {
  clearHotCache()
  let calls = 0
  let clock = 1_000_000
  const ok = async () => {
    calls += 1
    return { ok: true, status: 200, json: async () => HOT_PAYLOAD }
  }
  const first = await hotList({ fetchImpl: ok, now: () => clock })
  assert.equal(first.cached, false)
  assert.equal(first.items.length, 3)
  clock += 30_000
  assert.equal((await hotList({ fetchImpl: ok, now: () => clock })).cached, true)
  assert.equal(calls, 1)
  clock += 60_000
  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) })
  const fallback = await hotList({ fetchImpl: failing, now: () => clock })
  assert.equal(fallback.cached, true)
  assert.equal(fallback.items.length, 3)

  clearHotCache()
  await assert.rejects(hotList({ fetchImpl: failing }), /HTTP 403/)
  await assert.rejects(hotList({ fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) }), /空的/)
  clearHotCache()
})

/* ── routes ──────────────────────────────────────────────────────────────── */

test('routes: unknown paths, wrong methods and bad bodies get clean errors', async () => {
  assert.equal((await api('GET', '/nope')).status, 404)
  assert.equal((await api('GET', '/../config')).status, 404)
  const wrong = await api('POST', '/hot', {})
  assert.equal(wrong.status, 405)
  assert.equal(wrong.headers.allow, 'GET')
  const res = fakeResponse()
  await handleApi(fakeRequest('POST', `${API_PREFIX}/config`, 'x=1', { 'content-type': 'text/plain' }), res)
  assert.equal(res.status, 415)
  assert.equal((await api('POST', '/config', { fontSize: 'big' })).status, 400)
  assert.equal((await api('POST', '/cookie', { cookie: 42 })).status, 400)
  const saved = await api('POST', '/config', { showImages: true, sessionTitle: '周报整理' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.config.showImages, true)
  assert.equal(saved.body.config.sessionTitle, '周报整理')
})

/* ── /zhihu ──────────────────────────────────────────────────────────────── */

test('/zhihu settles with the target only', async () => {
  const opened = []
  const command = zhihuCommand({ afterOpen: (invocation, target) => opened.push(target) })
  assert.equal(command.name, 'zhihu')
  const result = await command.handler({ rawInput: '/zhihu https://www.zhihu.com/question/9/answer/10' })
  assert.equal(result.kind, 'success')
  assert.deepEqual(JSON.parse(result.text), { target: { kind: 'question', id: '9', answer: '10' } })
  const hot = await command.handler({ rawInput: '/zhihu' })
  assert.deepEqual(JSON.parse(hot.text), { target: { kind: 'hot' } })
  const bad = await command.handler({ rawInput: '/zhihu https://example.com' })
  assert.equal(bad.kind, 'error')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(opened.length, 2, 'afterOpen runs only for successful opens')
})

test('apply registers the command, the pre-step guard and the api', () => {
  assert.deepEqual(inject, ['commands'])
  const registered = []
  const injected = []
  const listeners = []
  const ctx = {
    commands: { register: (command) => registered.push(command.name) },
    on: (name, fn, prepend) => listeners.push({ name, prepend }),
    inject: (services, run) => {
      injected.push(services.join(','))
      if (services[0] === 'webServer') {
        const routes = []
        run({ webServer: { register: (route) => (routes.push(route), () => {}) }, effect: (fn) => fn() })
        assert.equal(routes[0].path, API_PREFIX)
      }
    },
  }
  apply(ctx)
  assert.deepEqual(registered, ['zhihu'])
  assert.deepEqual(listeners, [{ name: 'agent/pre-step', prepend: true }])
  assert.deepEqual(injected, ['sessionTitle', 'webServer'])
})

test('nothing is written outside $DSH_HOME/dsh-chat-zhihu', () => {
  assert.equal(dataDirectory(), join(home, 'dsh-chat-zhihu'))
})

// Shared test helpers: temp dirs and fake HTTP.

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

export async function tempDir(prefix = 'dcz-') {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A minimal IncomingMessage stand-in. */
export function fakeRequest(method, url, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(chunks)
  req.method = method
  req.url = url
  req.headers = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
  return req
}

/** A minimal ServerResponse stand-in that records status, headers and JSON body. */
export function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writableEnded: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value
    },
    writeHead(status, headers = {}) {
      this.status = status
      for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value
    },
    end(body = '') {
      this.body = String(body)
      this.writableEnded = true
    },
    get json() {
      return JSON.parse(this.body)
    },
  }
}

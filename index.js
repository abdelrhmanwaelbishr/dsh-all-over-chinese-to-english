import { appendFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'all-over-chinese-to-english'
export const inject = ['connection']

const API_PATH = '/api/all-over-chinese-to-english'
const CACHE_LIMIT = 4000
const MAX_TEXTS = 80
const MAX_CHARS = 800
const CONCURRENCY = 4
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

const cache = new Map()

function remember(text, translation) {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(text, translation)
}

async function mapLimit(items, limit, task) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await task(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function parseArray(raw, originals) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('empty model response')
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start < 0 || end <= start) throw new Error('model response was not a JSON array')
  let parsed
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    throw new Error('model response was not valid JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('model response was not an array')
  return originals.map((original, index) => {
    const value = parsed[index]
    return typeof value === 'string' && value.trim() ? value : original
  })
}

function statusPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'all-over-chinese-to-english-status.json')
}

function activityPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'all-over-chinese-to-english-client.log')
}

async function logActivity(line) {
  try {
    const path = activityPath()
    const info = await stat(path)
    if (info.size > 256 * 1024) return
  } catch {
    // First write.
  }
  appendFile(activityPath(), `${new Date().toISOString()} ${line}\n`, 'utf8').catch(() => {})
}

function createRuntime(ctx, settings) {
  const targetLanguage =
    typeof settings.targetLanguage === 'string' && settings.targetLanguage ? settings.targetLanguage : 'en'

  async function translateWithLlm(texts, signal) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') throw new Error('no LLM service available')
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? {}
    const provider = selection.provider
    const model = selection.model
    if (!provider || !model) throw new Error('no default model configured')

    const system = [
      'You are a translation engine.',
      'Translate each string in the input JSON array into English.',
      'Return ONLY a JSON array of translated strings in the same order and with the same length.',
      'Do not add commentary, numbering, or code fences.',
      'Keep placeholders such as {name}, %s and {{value}} unchanged.',
    ].join(' ')

    let output = ''
    let finishReason = ''
    const stream = llm.stream({
      provider,
      model,
      system,
      messages: [{ id: 'all-over-chinese-to-english', role: 'user', content: [{ type: 'text', text: JSON.stringify(texts) }] }],
      purpose: 'translate',
      signal,
    })
    for await (const chunk of stream) {
      if (!chunk) continue
      if (chunk.type === 'text-delta') output += chunk.text ?? ''
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !output) output = chunk.block.text ?? ''
      else if (chunk.type === 'finish') finishReason = chunk.reason ?? ''
    }
    if (finishReason === 'error' || finishReason === 'aborted') {
      throw new Error(`translation stream finished: ${finishReason}`)
    }
    return parseArray(output, texts)
  }

  async function translateWithService(translator, texts, signal) {
    return mapLimit(texts, CONCURRENCY, async (text) => {
      const spec = translator.resolve({ text, targetLanguage, sourceLanguage: 'zh' })
      return String(await translator.translate(spec, signal))
    })
  }

  async function translateBatch(texts, signal) {
    const unique = [...new Set(texts)]
    const missing = unique.filter((text) => !cache.has(text))
    let backend = 'cache'

    if (missing.length) {
      const translator = ctx.get('translator')
      if (translator && typeof translator.resolve === 'function' && typeof translator.translate === 'function') {
        backend = 'translator'
        try {
          const translated = await translateWithService(translator, missing, signal)
          missing.forEach((text, index) => remember(text, translated[index]))
        } catch (error) {
          if (signal?.aborted) throw error
          backend = 'llm'
        }
      } else {
        backend = 'llm'
      }

      const stillMissing = missing.filter((text) => !cache.has(text))
      if (stillMissing.length) {
        backend = 'llm'
        const translated = await translateWithLlm(stillMissing, signal)
        stillMissing.forEach((text, index) => remember(text, translated[index]))
      }
    }

    return {
      backend,
      translations: Object.fromEntries(unique.map((text) => [text, cache.get(text) ?? ''])),
    }
  }

  return { translateBatch }
}

function createHandler(ctx, settings, runtime) {
  return async function handle(request) {
    let payload
    try {
      payload = await request.json()
    } catch {
      return Response.json({ error: { message: 'invalid JSON body' } }, { status: 400 })
    }

    if (payload?.action === 'config') {
      logActivity('config')
      const translator = ctx.get('translator')
      return Response.json(
        {
          data: {
            enabled: settings.enabled !== false,
            targetLanguage: settings.targetLanguage || 'en',
            backend: translator ? 'translator' : 'llm',
          },
        },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    if (payload?.action !== 'translate') {
      return Response.json({ error: { message: 'unsupported action' } }, { status: 400 })
    }

    const texts = []
    for (const item of Array.isArray(payload.texts) ? payload.texts : []) {
      if (typeof item !== 'string') continue
      const text = item.trim()
      if (!text || text.length > MAX_CHARS || !CJK.test(text)) continue
      texts.push(text)
      if (texts.length >= MAX_TEXTS) break
    }

    if (texts.length === 0) {
      return Response.json(
        { data: { backend: 'none', translations: {} } },
        { headers: { 'Cache-Control': 'no-store' } },
      )
    }

    logActivity(`translate ${texts.length}`)

    try {
      const data = await runtime.translateBatch(texts, request.signal)
      return Response.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return Response.json({ error: { message } }, { status: 502 })
    }
  }
}

export async function apply(ctx, config = {}) {
  const settings = { enabled: true, targetLanguage: 'en', ...config }

  if (settings.enabled === false) {
    return
  }

  const runtime = createRuntime(ctx, settings)
  const disposeRoute = ctx.connection.fetch.register({
    path: API_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: createHandler(ctx, settings, runtime),
  })

  ctx.effect(() => () => {
    if (typeof disposeRoute === 'function') disposeRoute()
  }, 'all-over-chinese-to-english: route')

  // The translator row mounts during the same patch application; probing
  // immediately can still see it as absent. Give it a moment, then record.
  const probeTimer = setTimeout(() => {
    void writeProbe(ctx, settings)
  }, 2000)
  ctx.effect(() => () => clearTimeout(probeTimer), 'all-over-chinese-to-english: probe')
}

async function writeProbe(ctx, settings) {
  const probe = {
    plugin: 'dsh-all-over-chinese-to-english',
    translator: Boolean(ctx.get('translator')),
    llm: Boolean(ctx.get('llm')),
    connection: Boolean(ctx.connection),
    enabled: settings.enabled !== false,
    at: new Date().toISOString(),
  }

  const translator = ctx.get('translator')
  if (translator && typeof translator.resolve === 'function' && typeof translator.translate === 'function') {
    try {
      const spec = translator.resolve({ text: '插件设置', targetLanguage: 'en', sourceLanguage: 'zh' })
      probe.translatorTest = await translator.translate(spec)
    } catch (error) {
      probe.translatorTest = `error: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  try {
    await writeFile(statusPath(), `${JSON.stringify(probe, null, 2)}\n`, 'utf8')
  } catch {
    // Diagnostics only.
  }
}

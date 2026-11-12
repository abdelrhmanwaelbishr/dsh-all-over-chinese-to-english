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

// User interface and agent status text is short, imperative and repetitive.
// Generic machine translation renders the same label several ways ("verify",
// "validate", "measure"), so the most common ones get a fixed reading. Only
// whole segments are replaced: inside a longer sentence the translator still
// decides, which keeps the sentence grammatical.
const GLOSSARY = new Map([
  ['实时状态', 'Live status'],
  ['状态栏', 'Status bar'],
  ['状态', 'Status'],
  ['插件设置', 'Plugin settings'],
  ['设置', 'Settings'],
  ['插件', 'Plugin'],
  ['对话', 'Chat'],
  ['会话', 'Session'],
  ['模型', 'Model'],
  ['工具', 'Tools'],
  ['权限', 'Permissions'],
  ['工作区', 'Workspace'],
  ['翻译', 'Translation'],
  ['已启用', 'Enabled'],
  ['已禁用', 'Disabled'],
  ['启用', 'Enable'],
  ['禁用', 'Disable'],
  ['保存', 'Save'],
  ['取消', 'Cancel'],
  ['确认', 'Confirm'],
  ['删除', 'Delete'],
  ['复制', 'Copy'],
  ['重试', 'Retry'],
  ['刷新', 'Refresh'],
  ['关闭', 'Close'],
  ['打开', 'Open'],
  ['完成', 'Done'],
  ['失败', 'Failed'],
  ['成功', 'Done'],
  ['加载中', 'Loading'],
  ['正在加载', 'Loading'],
  ['暂停', 'Pause'],
  ['继续', 'Resume'],
  ['重命名', 'Rename'],
  ['验证', 'Verify'],
  ['应用', 'Apply'],
  ['定位', 'Locate'],
  ['排查', 'Investigate'],
  ['复测', 'Re-measure'],
  ['量化', 'Quantify'],
  ['确认', 'Confirm'],
  ['确认中', 'Confirming'],
  ['检查', 'Check'],
  ['修复', 'Fix'],
  ['调整', 'Adjust'],
  ['重建', 'Rebuild'],
  ['生成', 'Generate'],
  ['下载', 'Download'],
  ['上传', 'Upload'],
  ['导入', 'Import'],
  ['导出', 'Export'],
  ['安装', 'Install'],
  ['卸载', 'Uninstall'],
  ['更新', 'Update'],
  ['编辑', 'Edit'],
  ['搜索', 'Search'],
  ['过滤', 'Filter'],
  ['排序', 'Sort'],
  ['归档', 'Archive'],
  ['回收站', 'Trash'],
  ['历史记录', 'History'],
  ['主理鱼', 'Maintainer'],
])

// Characters that make a fragment a machine-reading artefact rather than UI
// text: JSON, markup, quotes, operators, and non-standard form fields.
const NON_TEXT = /["'`{}\[\]<>\\|=\uFFFC\uFFFD]/

// Sentence punctuation is kept as its own segment, so a translated paragraph is
// rebuilt with the punctuation the author wrote instead of a run-on sentence.
const SEPARATOR = /([，。；！？,;:：、]|\.\.\.|…)/

function isSeparator(part) {
  return SEPARATOR.test(part)
}

function splitSegments(text) {
  return text.split(SEPARATOR).filter((part) => part !== '')
}

function applyGlossary(text) {
  if (!text) return text
  let changed = false
  const mapped = splitSegments(text).map((part) => {
    if (isSeparator(part)) return part
    const trimmed = part.trim()
    if (!trimmed) return part
    const fixed = GLOSSARY.get(trimmed)
    if (fixed === undefined) return part
    changed = true
    return part.replace(trimmed, fixed)
  })
  if (!changed) return text
  return mapped.join('')
}

function normalizeTranslation(text, translated) {
  if (GLOSSARY.has(text)) return GLOSSARY.get(text)
  const glossary = applyGlossary(text)
  if (glossary !== text) return glossary
  return typeof translated === 'string' ? translated.trim() : ''
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

    // Expressions the glossary already settles never leave the process.
    const pending = []
    for (const text of unique) {
      if (cache.has(text)) continue
      const fixed = normalizeTranslation(text, '')
      if (fixed) remember(text, fixed)
      else pending.push(text)
    }

    const missing = []
    for (const text of pending) {
      const fragments = splitSegments(text)
      let settled = true
      for (const fragment of fragments) {
        if (isSeparator(fragment)) continue
        const trimmed = fragment.trim()
        if (!trimmed || GLOSSARY.has(trimmed)) continue
        settled = false
        if (!cache.has(trimmed)) missing.push(trimmed)
      }
      if (settled) remember(text, applyGlossary(text))
    }

    let backend = 'cache'

    if (missing.length) {
      const translator = ctx.get('translator')
      if (translator && typeof translator.resolve === 'function' && typeof translator.translate === 'function') {
        backend = 'translator'
        try {
          const translated = await translateWithService(translator, missing, signal)
          missing.forEach((text, index) => remember(text, normalizeTranslation(text, translated[index])))
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
        stillMissing.forEach((text, index) => remember(text, normalizeTranslation(text, translated[index])))
      }
    }

    // Rebuild every whole string from its segments: the punctuation the author
    // wrote is put back, and a glossary term keeps its fixed reading whatever the
    // backend answered for that fragment.
    for (const text of pending) {
      const rebuilt = splitSegments(text)
        .map((part) => {
          if (isSeparator(part)) return part
          const trimmed = part.trim()
          if (!trimmed) return part
          if (GLOSSARY.has(trimmed)) return part.replace(trimmed, GLOSSARY.get(trimmed))
          const translated = cache.get(trimmed)
          if (translated === undefined) return part
          return part.replace(trimmed, translated)
        })
        .join('')
      if (rebuilt && rebuilt !== text) remember(text, rebuilt)
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
      // Machine-reading artefacts (log lines, JSON, broken slices of a
      // generated file) are not interface text and must not be rebuilt.
      if (NON_TEXT.test(text)) continue
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

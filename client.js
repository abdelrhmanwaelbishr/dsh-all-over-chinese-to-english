// dsh-all-over-chinese-to-english client bundle
//
// Watches the DSH web UI for Chinese text that comes from installed plugins
// (plugin cards, settings pages, dialogs, menus, descriptions, plugin views and
// their tab labels) and replaces it with English via the plugin's host route.
// Only the chat transcript and the composer are excluded: chat messages, tool
// output and what the user types are user content, never plugin UI, and must
// not be sent to a translation backend.
window.__ModuleLoader__.load({
  id: 'dsh-all-over-chinese-to-english',
  factory(require) {
    const API_PATH = 'api/all-over-chinese-to-english'
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
    const SKIP_SELECTOR =
      'script,style,noscript,code,pre,textarea,input,svg,canvas,iframe,math,video,audio,[contenteditable=""],[contenteditable="true"],[translate="no"],[data-atz-ignore]'
    // Form fields keep their user content, but their display-only attributes
    // (placeholder/title/aria-label) are plugin UI and may be translated.
    const ATTRIBUTE_SKIP_SELECTOR =
      'script,style,noscript,code,pre,svg,canvas,iframe,math,video,audio,[contenteditable=""],[contenteditable="true"],[translate="no"],[data-atz-ignore]'
    const EXCLUDE_SELECTOR = [
      // Chat transcript and composer: user/model content, never plugin UI.
      '[data-slot="conversation.chat.flow"]',
      '[data-slot="conversation.chat.node"]',
      '[data-slot="conversation.composer"]',
      '[data-slot="conversation.input.dock"]',
    ].join(',')
    // Conversation Views (Chat, Trajectory, Context/Fleet) render user and
    // model content. A plugin-provided view (e.g. the session superagent page)
    // shares the same slot but none of these markers, so it can be translated.
    const VIEW_SELECTOR = '[data-slot="conversation.view"]'
    const CONVERSATION_CONTENT =
      '[data-slot="conversation.chat.flow"],[data-trajectory-scroll],[data-lc-surface],[data-conversation-scroll]'
    const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'label']
    const MAX_LENGTH = 400
    const MAX_BATCH = 60
    const MAX_CACHE = 3000
    const BATCH_DELAY = 80
    const DEBOUNCE = 220

    function resolveFetch() {
      const transport = window.__DSH_TRANSPORT__
      if (transport && typeof transport.fetch === 'function') return transport.fetch.bind(transport)
      return globalThis.fetch.bind(globalThis)
    }

    async function call(payload) {
      const response = await resolveFetch()(API_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (!response.ok) {
        const message = body && body.error && body.error.message ? body.error.message : `HTTP ${response.status}`
        throw new Error(message)
      }
      return body && body.data ? body.data : {}
    }

    function splitWhitespace(text) {
      const leading = text.length - text.replace(/^\s+/, '').length
      const trailing = text.replace(/\s+$/, '').length
      return { lead: text.slice(0, leading), core: text.slice(leading, trailing), trail: text.slice(trailing) }
    }

    function apply(ctx) {
      const previous = window.__DSH_ALL_OVER_C2E__
      if (previous && typeof previous.dispose === 'function') {
        try {
          previous.dispose()
        } catch {
          // Ignore a stale instance that already tore itself down.
        }
      }

      const state = { enabled: true, disposed: false, observer: null }
      // Plugin panels may render their whole UI inside a same-origin iframe
      // (dsh-mcp-connector does: <iframe src="/mcp-connector/ui/">). Those
      // documents are invisible to the top-document observer, so watch every
      // same-origin frame document as well.
      const frameObservers = new Map()
      const frameListeners = new WeakSet()
      const textApplied = new WeakMap()
      const attrApplied = new WeakMap()
      const timers = new WeakMap()
      const cache = new Map()
      const queue = new Map()
      let flushTimer = null
      let flushing = false

      function cacheSet(text, translated) {
        if (cache.size >= MAX_CACHE) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(text, translated)
      }

      function insideConversationView(element) {
        const view = element.closest(VIEW_SELECTOR)
        if (view === null) return false
        return view.querySelector(CONVERSATION_CONTENT) !== null
      }

      function isIgnored(element) {
        if (!element || element.nodeType !== 1) return true
        if (element.closest(SKIP_SELECTOR) !== null) return true
        if (element.closest(EXCLUDE_SELECTOR) !== null) return true
        return insideConversationView(element)
      }

      function isAttributeIgnored(element) {
        if (!element || element.nodeType !== 1) return true
        if (element.closest(ATTRIBUTE_SKIP_SELECTOR) !== null) return true
        if (element.closest(EXCLUDE_SELECTOR) !== null) return true
        return insideConversationView(element)
      }

      function applyText(node, original, translated) {
        const { lead, trail } = splitWhitespace(original)
        const next = lead + translated + trail
        textApplied.set(node, next)
        if (node.nodeValue !== next) node.nodeValue = next
      }

      function applyAttribute(element, name, original, translated) {
        const { lead, trail } = splitWhitespace(original)
        const next = lead + translated + trail
        let applied = attrApplied.get(element)
        if (!applied) {
          applied = Object.create(null)
          attrApplied.set(element, applied)
        }
        applied[name] = next
        if (element.getAttribute(name) !== next) element.setAttribute(name, next)
      }

      function enqueue(entry) {
        let entries = queue.get(entry.core)
        if (!entries) {
          entries = []
          queue.set(entry.core, entries)
        }
        entries.push(entry)
        if (!flushTimer) flushTimer = setTimeout(flush, BATCH_DELAY)
      }

      function runEntry(entry, translated) {
        if (!translated || translated === entry.core) return
        if (entry.kind === 'text') {
          const node = entry.node
          if (!node.isConnected || node.nodeValue !== entry.original) return
          applyText(node, entry.original, translated)
          return
        }
        const element = entry.element
        if (!element.isConnected || element.getAttribute(entry.name) !== entry.original) return
        applyAttribute(element, entry.name, entry.original, translated)
      }

      function scheduleText(node) {
        if (!state.enabled || state.disposed || !node.isConnected) return
        const value = node.nodeValue
        if (!value || value.length > MAX_LENGTH || !CJK.test(value)) return
        if (textApplied.get(node) === value) return
        if (isIgnored(node.parentElement)) return
        const { core } = splitWhitespace(value)
        if (!core || core.length > MAX_LENGTH) return
        const cached = cache.get(core)
        if (cached) {
          applyText(node, value, cached)
          return
        }
        const previousTimer = timers.get(node)
        if (previousTimer) clearTimeout(previousTimer)
        timers.set(
          node,
          setTimeout(() => {
            timers.delete(node)
            if (!state.enabled || state.disposed) return
            if (!node.isConnected || node.nodeValue !== value) return
            enqueue({ kind: 'text', node, original: value, core })
          }, DEBOUNCE),
        )
      }

      function scanAttributes(element) {
        if (!state.enabled || state.disposed) return
        if (!element || element.nodeType !== 1 || isAttributeIgnored(element)) return
        for (const name of ATTRIBUTES) {
          const value = element.getAttribute(name)
          if (!value || value.length > MAX_LENGTH || !CJK.test(value)) continue
          const applied = attrApplied.get(element)
          if (applied && applied[name] === value) continue
          const { core } = splitWhitespace(value)
          if (!core) continue
          const cached = cache.get(core)
          if (cached) {
            applyAttribute(element, name, value, cached)
            continue
          }
          enqueue({ kind: 'attribute', element, name, original: value, core })
        }
      }

      function scan(root) {
        if (!state.enabled || state.disposed || !root) return
        if (root.nodeType === 3) {
          scheduleText(root)
          return
        }
        if (root.nodeType !== 1) return
        if (root.nodeName === 'IFRAME') {
          watchFrame(root)
          return
        }
        if (root.nodeName === 'SCRIPT' || root.nodeName === 'STYLE') return
        if (isIgnored(root)) {
          if (root.matches && root.matches('input,textarea')) scanAttributes(root)
          return
        }

        scanAttributes(root)

        const ownerDocument = root.ownerDocument || document
        const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
        let node = walker.nextNode()
        while (node) {
          if (!isIgnored(node.parentElement)) scheduleText(node)
          node = walker.nextNode()
        }

        if (root.querySelectorAll) {
          const descendants = root.querySelectorAll('*')
          const limit = Math.min(descendants.length, 800)
          for (let index = 0; index < limit; index += 1) scanAttributes(descendants[index])
          const frames = root.querySelectorAll('iframe')
          for (const frame of frames) watchFrame(frame)
        }
      }

      function isAccessibleFrame(frame) {
        try {
          const doc = frame.contentDocument
          return doc && doc.documentElement ? doc : null
        } catch {
          // Cross-origin frame: nothing we may read or translate.
          return null
        }
      }

      function watchFrame(frame) {
        if (!frame || frame.nodeName !== 'IFRAME' || state.disposed) return
        const doc = isAccessibleFrame(frame)
        if (doc) watchDocument(doc)
        if (frameListeners.has(frame)) return
        frameListeners.add(frame)
        frame.addEventListener('load', () => {
          if (state.disposed) return
          const loaded = isAccessibleFrame(frame)
          if (loaded) watchDocument(loaded)
        })
      }

      function watchDocument(doc) {
        if (!doc || state.disposed || frameObservers.has(doc)) return
        if (!doc.documentElement) return
        const frameObserver = new MutationObserver(handleRecords)
        frameObservers.set(doc, frameObserver)
        frameObserver.observe(doc.documentElement, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ATTRIBUTES,
        })
        try {
          for (const frame of doc.querySelectorAll('iframe')) watchFrame(frame)
        } catch {
          // Unreadable document: skip it.
        }
        scan(doc.body || doc.documentElement)
      }

      async function flush() {
        flushTimer = null
        if (flushing || !state.enabled || state.disposed || queue.size === 0) return
        flushing = true
        const batch = []
        for (const [core, entries] of queue) {
          batch.push({ core, entries })
          queue.delete(core)
          if (batch.length >= MAX_BATCH) break
        }
        try {
          const data = await call({ action: 'translate', texts: batch.map((item) => item.core) })
          const translations = data && data.translations ? data.translations : {}
          for (const item of batch) {
            const translated = translations[item.core]
            if (!translated) continue
            cacheSet(item.core, translated)
            for (const entry of item.entries) runEntry(entry, translated)
          }
        } catch (error) {
          console.warn('[dsh-all-over-chinese-to-english]', error)
        } finally {
          flushing = false
          if (queue.size && !flushTimer && !state.disposed) flushTimer = setTimeout(flush, 120)
        }
      }

      function handleRecords(records) {
        if (!state.enabled || state.disposed) return
        for (const record of records) {
          if (record.type === 'characterData') {
            scheduleText(record.target)
          } else if (record.type === 'attributes') {
            scanAttributes(record.target)
          } else if (record.type === 'childList') {
            for (const node of record.addedNodes) scan(node)
          }
        }
      }

      function scanEverything() {
        if (!state.enabled || state.disposed) return
        if (document.body) scan(document.body)
        for (const doc of frameObservers.keys()) {
          if (doc !== document && doc.body) scan(doc.body)
        }
      }

      function dispose() {
        if (state.disposed) return
        state.disposed = true
        for (const frameObserver of frameObservers.values()) frameObserver.disconnect()
        frameObservers.clear()
        if (flushTimer) clearTimeout(flushTimer)
        flushTimer = null
        queue.clear()
        if (window.__DSH_ALL_OVER_C2E__ === controller) delete window.__DSH_ALL_OVER_C2E__
        if (window.__DSH_ALL_OVER_C2E_TOGGLE__) delete window.__DSH_ALL_OVER_C2E_TOGGLE__
      }

      const controller = { dispose }
      window.__DSH_ALL_OVER_C2E__ = controller

      call({ action: 'config' })
        .then((data) => {
          if (data && data.enabled === false) dispose()
        })
        .catch(() => {})

      if (document.documentElement) {
        watchDocument(document)
      } else {
        window.addEventListener('DOMContentLoaded', () => watchDocument(document), { once: true })
      }

      window.__DSH_ALL_OVER_C2E_TOGGLE__ = (value) => {
        state.enabled = typeof value === 'boolean' ? value : !state.enabled
        if (state.enabled && !state.disposed) scanEverything()
      }

      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => dispose(), 'all-over-chinese-to-english: observer')
      }
    }

    return { apply }
  },
})

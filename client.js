// dsh-all-over-chinese-to-english client bundle
//
// Watches the DSH web UI for Chinese text that comes from installed plugins
// (plugin cards, settings pages, dialogs, menus, descriptions, plugin views and
// their tab labels) and replaces it with English via the plugin's host route.
// The chat transcript is translated only for what the agent itself wrote: an
// assistant row, its thinking titles ("⏵ 验证图片是否已对齐") and its prose. A row
// the user authored (data-chat-flow-kind=user / steering, or a submission echo)
// and tool output are never sent to a translation backend; neither is the
// composer or anything the user types. The Trajectory and Context views show
// raw stored payloads, so they stay untranslated as a whole.
window.__ModuleLoader__.load({
  id: 'dsh-all-over-chinese-to-english',
  factory(require) {
    const API_PATH = 'api/all-over-chinese-to-english'
    const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
    // "⏵" and friends decorate a status line. They are not words: they are cut
    // off before a request and pasted back onto the answer.
    const MARKER = /^[\s⏵⏴▶►»→]*/
    const SKIP_SELECTOR =
      'script,style,noscript,code,pre,textarea,input,svg,canvas,iframe,math,video,audio,[contenteditable=""],[contenteditable="true"],[translate="no"],[data-atz-ignore]'
    // Form fields keep their user content, but their display-only attributes
    // (placeholder/title/aria-label) are plugin UI and may be translated.
    const ATTRIBUTE_SKIP_SELECTOR =
      'script,style,noscript,code,pre,svg,canvas,iframe,math,video,audio,[contenteditable=""],[contenteditable="true"],[translate="no"],[data-atz-ignore]'
    const EXCLUDE_SELECTOR = [
      // The composer and its dock: everything here is what the user is writing.
      '[data-slot="conversation.composer"]',
      '[data-slot="conversation.input.dock"]',
    ].join(',')
    // Chat flow rows the user authored, plus tool output, are user data and are
    // never sent to a translation backend. Assistant rows and their process
    // (thinking titles, step prose) are model output, so they are translated.
    const CHAT_FLOW_SELECTOR = '[data-slot="conversation.chat.flow"]'
    const CHAT_ROW_SELECTOR = '[data-chat-flow-key]'
    const CHAT_EXCLUDED_KINDS = new Set(['user', 'steering', 'tool-result'])
    // Conversation Views (Trajectory and the dsh-context dashes) render stored
    // payloads, including what the user typed and tool output. A plugin-provided
    // view (e.g. the session superagent page) shares the same slot but none of
    // these markers, so it can be translated.
    const VIEW_SELECTOR = '[data-slot="conversation.view"]'
    const CONVERSATION_CONTENT = '[data-trajectory-scroll],[data-lc-surface]'
    const FLOW_SELECTOR = '[data-slot="conversation.chat.flow"]'
    const ATTRIBUTES = ['placeholder', 'title', 'aria-label', 'alt', 'label']
    // The status line re-renders constantly: a fresh element every time the
    // status changes or scrolls into view. Its translation is kept with the
    // rest, so a respawn is filled in synchronously, without a flash of Chinese
    // and without a second request.
    // A paragraph the agent wrote is often longer than a plugin label, and the
    // host route translates up to 800 characters per string.
    const MAX_LENGTH = 800
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
      return { lead: text.slice(0, leading), trail: text.slice(trailing) }
    }

    // Walks a subtree by hand. The observer of a frame document belongs to the
    // top window, and its NodeFilter is handed to that window's TreeWalker,
    // which refuses to accept an object from another realm.
    function collectTexts(root, out) {
      if (!root) return out
      if (root.nodeType === 3) {
        out.push(root)
        return out
      }
      if (root.nodeType !== 1) return out
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node = walker.nextNode()
      while (node) {
        out.push(node)
        node = walker.nextNode()
      }
      return out
    }

    // "⏵ 应用图片与卡片修复" -> { marker: "⏵ ", lead: " ", trail: "" }.
    // The arrow is decoration, not words, and the whitespace around the words
    // is put back exactly as it was. The words themselves are read separately
    // by wordsOf, which also tells apart text that carries no words at all.
    function stripMarker(value) {
      const marker = MARKER.exec(value)[0]
      const { lead, trail } = splitWhitespace(value.slice(marker.length))
      return { marker, lead, trail }
    }

    // The translation unit of a display string: the words, without the arrow
    // and without the surrounding whitespace. Empty when there are none.
    function wordsOf(value) {
      const marker = MARKER.exec(value)[0]
      const rest = value.slice(marker.length)
      const { lead, trail } = splitWhitespace(rest)
      return rest.slice(lead.length, rest.length - trail.length)
    }

    function restoreMarker(value, translated) {
      const { marker, lead, trail } = stripMarker(value)
      return marker + lead + translated + trail
    }

    // Whether an element is the agent's live status line. It carries no marker
    // of its own, so it is recognised by where it sits: message rows are slotted
    // inside the chat flow, and the status line is the only thing mounted beside
    // that flow inside the transcript column. Slotted elements are plugin or
    // conversation renderers and are never treated as status.
    function isStatusLine(element) {
      if (!element || element.nodeType !== 1) return false
      if (element.hasAttribute('data-slot')) return false
      let next = element.parentElement
      for (let depth = 0; depth < 3 && next; depth += 1) {
        if (next === document.body || next === document.documentElement) return false
        if (next.matches(FLOW_SELECTOR) || next.querySelector(FLOW_SELECTOR) !== null) return true
        // Everything above the row's messages belongs to the conversation view,
        // which is excluded as a whole.
        if (isConversationView(next)) return false
        next = next.parentElement
      }
      return false
    }

    function isConversationView(element) {
      return element.matches(VIEW_SELECTOR) && element.querySelector(CONVERSATION_CONTENT) !== null
    }

    // True when the element only belongs to the agent's status line: the row
    // the conversation renders below its messages (or inside the view, in a
    // frame that mirrors it), outside the scrolling message list.
    function isStatusRow(element) {
      if (!element || element.nodeType !== 1) return false
      if (!isStatusLine(element)) return false
      const list = closestMatch(element, FLOW_SELECTOR)
      if (list !== null) return !list.contains(element)
      return closestMatch(element, VIEW_SELECTOR) !== null
    }

    function closestMatch(element, selector) {
      let node = element
      while (node && node.nodeType === 1) {
        if (node.matches(selector)) return node
        node = node.parentElement
      }
      return null
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

      const state = { enabled: true, disposed: false }
      // Plugin panels may render their whole UI inside a same-origin iframe
      // (dsh-mcp-connector does: <iframe src="/mcp-connector/ui/">). Those
      // documents are invisible to the top-document observer, so watch every
      // same-origin frame document as well.
      const frameObservers = new Map()
      const frameListeners = new WeakSet()
      // Markers back up the in-memory bookkeeping: nodes and elements outlive
      // nothing, but a plugin that re-renders can hand back the very same text,
      // and the marker says whether this plugin already wrote it.
      const textApplied = new WeakMap()
      const attrApplied = new WeakMap()
      const timers = new WeakMap()
      // Translations are remembered for the lifetime of the page, per document:
      // a remount or a re-scan walks the whole tree again, and the same words
      // must never be paid for twice.
      const cache = new Map()
      const queue = new Map()
      const pending = []
      let deferTimer = null
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
        const view = closestMatch(element, VIEW_SELECTOR)
        if (view === null) return false
        return view.querySelector(CONVERSATION_CONTENT) !== null
      }

      // null when the element is not in the chat flow at all; otherwise says
      // whether the row it belongs to must stay untranslated. User rows, steering
      // messages, the optimistic submission echo and tool output are user data.
      function chatRowExcluded(element) {
        if (closestMatch(element, CHAT_FLOW_SELECTOR) === null) return null
        const row = closestMatch(element, CHAT_ROW_SELECTOR)
        if (row === null) return true
        const kind = row.getAttribute('data-chat-flow-kind') || ''
        if (CHAT_EXCLUDED_KINDS.has(kind)) return true
        if (closestMatch(element, '[data-submission-echo]') !== null) return true
        return false
      }

      function isIgnored(element) {
        if (!element || element.nodeType !== 1) return true
        if (closestMatch(element, SKIP_SELECTOR) !== null) return true
        const chat = chatRowExcluded(element)
        if (chat !== null) return chat
        if (isStatusRow(element)) return false
        if (insideConversationView(element)) return true
        return closestMatch(element, EXCLUDE_SELECTOR) !== null
      }

      function isAttributeIgnored(element) {
        if (!element || element.nodeType !== 1) return true
        if (closestMatch(element, ATTRIBUTE_SKIP_SELECTOR) !== null) return true
        const chat = chatRowExcluded(element)
        if (chat !== null) return chat
        if (isStatusRow(element)) return false
        if (insideConversationView(element)) return true
        return closestMatch(element, EXCLUDE_SELECTOR) !== null
      }

      function textValue(node) {
        const value = node.nodeValue
        if (textApplied.get(node) === value) return ''
        const core = wordsOf(value)
        if (!core || core.length > MAX_LENGTH || !CJK.test(core)) return ''
        return core
      }

      function applyText(node, original, translated) {
        const next = restoreMarker(original, translated)
        textApplied.set(node, next)
        if (node.nodeValue !== next) node.nodeValue = next
      }

      function applyAttribute(element, name, original, translated) {
        const next = restoreMarker(original, translated)
        let applied = attrApplied.get(element)
        if (!applied) {
          applied = Object.create(null)
          attrApplied.set(element, applied)
        }
        applied[name] = next
        if (element.getAttribute(name) !== next) element.setAttribute(name, next)
      }

      function enqueue(entry) {
        let item = queue.get(entry.core)
        if (!item) {
          item = { entries: [] }
          queue.set(entry.core, item)
        }
        item.entries.push(entry)
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
        const core = textValue(node)
        if (!core) return
        if (isIgnored(node.parentElement)) return
        const cached = cache.get(core)
        if (cached) {
          applyText(node, node.nodeValue, cached)
          return
        }
        const previousTimer = timers.get(node)
        if (previousTimer) clearTimeout(previousTimer)
        timers.set(
          node,
          setTimeout(() => {
            timers.delete(node)
            if (!state.enabled || state.disposed) return
            // The status line rewrites its own words while the model streams an
            // update, so the node is read again here rather than trusted to
            // still hold what it held before the debounce.
            if (!node.isConnected || !textValue(node)) return
            const current = wordsOf(node.nodeValue)
            if (cache.has(current)) {
              scheduleText(node)
              return
            }
            enqueue({ kind: 'text', node, original: node.nodeValue, core: current })
          }, DEBOUNCE),
        )
      }

      function scanAttributes(element) {
        if (!state.enabled || state.disposed) return
        if (!element || element.nodeType !== 1 || isAttributeIgnored(element)) return
        let applied = attrApplied.get(element)
        for (const name of ATTRIBUTES) {
          const value = element.getAttribute(name)
          if (!value) continue
          if (applied && applied[name] === value) continue
          const core = wordsOf(value)
          if (!core || core.length > MAX_LENGTH || !CJK.test(core)) continue
          const cached = cache.get(core)
          if (cached) {
            applyAttribute(element, name, value, cached)
            applied = attrApplied.get(element)
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
        if (isIgnored(root)) return

        scanAttributes(root)

        for (const node of collectTexts(root, [])) {
          if (!isIgnored(node.parentElement)) scheduleText(node)
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

      // A same-document navigation (the iframe panel routes between pages)
      // replaces the document. The old one is dead, and keeping its entry would
      // make every later mount look already-watched.
      function watchReplacedDocument(frame) {
        try {
          if (!frame.isConnected) return
          const doc = isAccessibleFrame(frame)
          if (!doc) return
          const known = frameObservers.get(doc)
          if (known) return
          for (const [watched, observer] of frameObservers) {
            if (watched === doc) continue
            let same = false
            try {
              same = watched.defaultView === doc.defaultView
            } catch {
              same = false
            }
            if (!same) continue
            observer.disconnect()
            frameObservers.delete(watched)
          }
          watchDocument(doc)
        } catch {
          // Unreadable frame: nothing to watch.
        }
      }

      function watchFrame(frame) {
        if (!frame || frame.nodeName !== 'IFRAME' || state.disposed) return
        // Checked on every call, not only when the frame first appears: the
        // document may have been replaced since, by a route change inside it.
        watchReplacedDocument(frame)
        if (frameListeners.has(frame)) return
        frameListeners.add(frame)
        frame.addEventListener('load', () => {
          if (state.disposed) return
          watchReplacedDocument(frame)
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
        for (const [core, item] of queue) {
          batch.push({ core, entries: item.entries })
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

      // One timer for the whole plugin: a burst of mutations is handled once,
      // after the DOM has settled.
      function defer(task) {
        pending.push(task)
        if (deferTimer) return
        deferTimer = setTimeout(() => {
          deferTimer = null
          const tasks = pending.slice()
          pending.length = 0
          for (const item of tasks) item()
        }, 0)
      }

      function handleRecords(records) {
        if (!state.enabled || state.disposed) return
        // Every write lands in the queue first and is acted on once. Walking a
        // subtree or translating one text node makes the DOM change again, and
        // this plugin's own mutations must not send it round a second time:
        // reading what changed is fine, doing it twice is not.
        const touched = []
        for (const record of records) {
          if (record.type === 'characterData') {
            touched.push(record.target)
          } else if (record.type === 'attributes') {
            scanAttributes(record.target)
          } else if (record.type === 'childList') {
            for (const node of record.addedNodes) touched.push(node)
          }
        }
        if (touched.length === 0) return
        defer(() => {
          if (!state.enabled || state.disposed) return
          for (const node of touched) {
            if (!node.isConnected) continue
            if (node.nodeType === 1) scan(node)
            else if (node.nodeType === 3) scheduleText(node)
          }
        })
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

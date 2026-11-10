# All-Over Chinese to English

Translates Chinese text across the whole DSH interface into English — plugin pages, plugin settings,
dropdown menus, plugin View tabs, the top bar, and same-origin iframe panels such as the MCP Connector.

It ships as one installable bundle with two halves.

- **Host** (`index.js`) registers `POST /api/all-over-chinese-to-english`, a batch endpoint that translates short
  Chinese strings and caches the results in memory. Translation prefers the shipped anonymous `translator` service
  (Bing by default, Google as a fallback), which needs no account or API key. If that service is unavailable it falls
  back to the configured default model through the `llm` service.
- **Client** (`client.js`) observes the page for Chinese text nodes and translatable attributes, debounces edits, and
  replaces the text in place with the English translation. A `MutationObserver` re-checks content React re-renders, so
  translated strings stay translated after navigation and re-render.

## What gets translated

| Surface | Example |
|---|---|
| Plugin pages and detail panels | Plugin READMEs, capability lists |
| Plugin settings | Labels, hints, and dropdown menus (native `<select>` lists and custom popovers) |
| Sidebar plugin pages | Trash, Plugins, and other panels |
| Plugin Views and their top bar tabs | e.g. the `dsh-session-superagent` view and its tab label |
| Same-origin iframe panels | The whole MCP Connector page (`<iframe src="/mcp-connector/ui/">`) |
| Display-only attributes | `placeholder`, `title`, `aria-label`, `alt`, `label` |

## What is deliberately left alone

Chat and other conversation-content views are never scanned or translated: the chat transcript
(`conversation.chat.flow` / `conversation.chat.node`), the Trajectory table, the Context/Fleet dashboard, the composer,
and drafts all hold user content rather than plugin UI, and none of it is sent to a translation backend. A plugin View
is recognised by the absence of those conversation markers inside the same `conversation.view` slot.

Also skipped: `script`, `style`, `code`, `pre`, `svg`, `canvas`, `math`, `video`, `audio`, fields where the user types
(`input`, `textarea`, `contenteditable`), anything marked `translate="no"` or `data-atz-ignore`, and strings longer than
400 characters. Option *values* and form-field values stay untouched, so saved configuration keeps the original value.

## Configuration

Configured on the plugin row:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn automatic translation on or off. |
| `targetLanguage` | `en` | Target language passed to the translator service. |

The plugin's own switch lives on the **Plugins** page. Turning it off restores the original Chinese on the next render.

## Install

```sh
dsh plugin add abdelrhmanwaelbishr/dsh-all-over-chinese-to-english
```

Or, from a local checkout, add the package directory as a profile bundle. The bundle also mounts the
`@deepseek-ai/dsh-experimental-translator` service so the free translation route exists; you do not need to enable
`@deepseek-ai/dsh-experimental-cot-translation-bundle` yourself.

A status file is written to `~/.dsh/all-over-chinese-to-english-status.json` (`translator`, `llm`, `connection`,
`enabled`, and a live `translatorTest`), and an activity log to `~/.dsh/all-over-chinese-to-english-client.log`. The log
records request counts only, never translated text.

## License

MIT

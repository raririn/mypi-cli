# MyPi built-in web search

The isolated MyPi runtime registers two core read-only network tools:

- `web_search`: prefer a configured Brave Search API, then use bounded
  credential-free `curl` requests against DuckDuckGo, Mojeek, and Bing.
- `web_fetch`: fetch and extract readable Markdown from a public HTTP(S) page.

Web content is untrusted input. The tools do not execute page scripts, submit
forms, retain cookies, send request bodies, or permit private-network targets.

In Pi's TUI, result bodies are collapsed by default. The configured
`app.tools.expand` binding (Ctrl+O by default) expands or collapses all tool
output, and the extension reports `Tool output: visible` or `Tool output: hidden`
when that state changes. The GUI keeps its own timeline presentation.

These tools ship with pi-core and are not user-disableable extension-package
resources. Restricted MyPi Chat composes the same implementation explicitly.

## Brave API key

The runtime first reads `BRAVE_API_KEY`. If it is absent, it reads:

```text
~/.mypi/agent/brave-search.json
```

Use `mypi web-search configure [--country CC]` to read the key privately and create the file atomically with owner-only permissions. The command refuses API keys in argv, symlink/non-regular targets, and unsafe profile directories. `BRAVE_API_KEY` remains supported and takes precedence at runtime.

```json
{
  "version": 1,
  "apiKey": "YOUR_BRAVE_SEARCH_API_KEY",
  "defaultCountry": "US"
}
```

```bash
chmod 600 ~/.mypi/agent/brave-search.json
```

Never place the key in this repository. Without a key, search uses the
credential-free provider chain automatically. Remote runtimes need their own
key; MyPi does not copy credentials between local and remote environments.

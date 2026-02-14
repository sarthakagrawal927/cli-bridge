# cli-bridge

![AI Generated](https://ai-percentage-pin.vercel.app/api/ai-percentage?value=85)
![AI PRs Welcome](https://ai-percentage-pin.vercel.app/api/ai-prs?welcome=yes)

Lightweight HTTP-to-CLI bridge for AI tools. Spawns local CLI processes (Claude Code, Codex, Gemini CLI) and streams responses back via SSE. No API keys needed — uses your already-authenticated CLI tools.

## Quick Start

```bash
npm install
npm start        # → http://localhost:3456
```

## API

Routes are available at both `/chat` and `/api/chat` (same for `/health`).

### `POST /chat`

Stream a conversation through any supported CLI tool.

```json
{
  "provider": "claude",
  "model": "sonnet",
  "messages": [
    { "role": "user", "content": "Explain quicksort" }
  ],
  "systemPrompt": "You are a CS tutor."
}
```

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `provider` | `"claude"` \| `"codex"` \| `"gemini"` | no | `"claude"` |
| `tool` | string | no | Alias for `provider` |
| `model` | string | no | CLI default |
| `messages` | `{role, content}[]` | yes | — |
| `systemPrompt` | string | no | — |

**Response:** Server-Sent Events stream

```
data: {"text":"Quick"}
data: {"text":"sort is..."}
data: [DONE]
```

### `GET /health`

```json
{ "status": "ok", "providers": ["claude", "codex", "gemini"] }
```

## Provider Notes

| Provider | Streaming | System Prompt |
|----------|-----------|---------------|
| `claude` | JSON (`stream-json`) | `--system-prompt` flag |
| `codex` | JSON (`exec --json`) | Embedded in prompt text |
| `gemini` | Plain text | Embedded in prompt text |

## Adding a New Provider

Add an entry to `CLI_TOOLS` in `index.mjs`:

```js
myTool: {
  command: 'my-cli',
  buildArgs: (model, systemPrompt) => ['--flag', ...],
  inputMode: 'stdin',           // or 'arg'
  embedSystemPrompt: false,     // true = prepend system prompt to conversation
  parseStream: (jsonLine, emit) => {  // null = plain text mode
    const json = JSON.parse(jsonLine);
    if (json.text) emit(json.text);
  },
},
```

## Use as Git Submodule

```bash
git submodule add https://github.com/sarthakagrawal927/cli-bridge.git server
cd server && npm install
```

### Vite proxy (dev)
```js
// vite.config.js — routes work at both /chat and /api/chat
export default { server: { proxy: { '/api': 'http://localhost:3456' } } }
```

### Fetch from frontend
```js
const res = await fetch('/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'claude', messages: [{ role: 'user', content: 'Hello' }] }),
});
```

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | Server port |

## License

MIT
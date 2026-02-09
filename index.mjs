import express, { Router } from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

// ── CLI Tool Registry ─────────────────────────────────────────────
// Each entry describes how to talk to a specific CLI tool.
//   command        — the binary name
//   buildArgs      — fn(model, systemPrompt) → string[]
//   inputMode      — 'stdin' | 'arg'  (how the prompt is sent)
//   embedSystemPrompt — if true, system prompt is prepended to the prompt text
//   parseStream    — fn(jsonLine, emit) to extract text; null = plain text mode

const CLI_TOOLS = {
  claude: {
    command: 'claude',
    buildArgs: (model, systemPrompt) => {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (model) args.push('--model', model);
      if (systemPrompt) args.push('--system-prompt', systemPrompt);
      return args;
    },
    inputMode: 'stdin',
    embedSystemPrompt: false,
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) emit(block.text);
        }
        return;
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        emit(json.delta.text);
      }
    },
  },

  codex: {
    // codex exec --json outputs JSONL with item.completed events
    command: 'codex',
    buildArgs: (model) => {
      const args = ['exec', '--json'];
      if (model) args.push('--model', model);
      return args;
    },
    inputMode: 'stdin',
    embedSystemPrompt: true,
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'item.completed' && json.item?.type === 'agent_message' && json.item.text) {
        emit(json.item.text);
      }
    },
  },

  gemini: {
    // gemini CLI outputs plain text to stdout, no JSON streaming
    command: 'gemini',
    buildArgs: (model) => {
      const args = [];
      if (model) args.push('--model', model);
      return args;
    },
    inputMode: 'arg',
    embedSystemPrompt: true,
    parseStream: null, // plain text mode — no JSON parsing
  },
};

// ── Routes ────────────────────────────────────────────────────────

const api = Router();

api.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: Object.keys(CLI_TOOLS) });
});

// POST /chat — { provider|tool, model?, messages, systemPrompt? }
api.post('/chat', (req, res) => {
  const { provider, tool, model, messages, systemPrompt } = req.body;
  const providerName = provider || tool || 'claude';

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const cliTool = CLI_TOOLS[providerName];
  if (!cliTool) {
    return res.status(400).json({
      error: `Unknown provider: ${providerName}`,
      available: Object.keys(CLI_TOOLS),
    });
  }

  // Build prompt — embed system prompt for tools that don't have a dedicated flag
  let prompt = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  if (cliTool.embedSystemPrompt && systemPrompt) {
    prompt = `System instructions: ${systemPrompt}\n\n${prompt}`;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = cliTool.buildArgs(model, systemPrompt);
  if (cliTool.inputMode === 'arg') args.push('-p', prompt);

  const proc = spawn(cliTool.command, args, {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (cliTool.inputMode === 'stdin') {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  let buffer = '';
  let textSent = false;
  const isPlainText = !cliTool.parseStream;

  proc.stdout.on('data', (data) => {
    if (isPlainText) {
      // Plain text mode — forward stdout chunks directly
      const text = data.toString();
      if (text) {
        textSent = true;
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      return;
    }

    // JSON streaming mode
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        cliTool.parseStream(line, (text) => {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });
      } catch {
        // Non-JSON line — emit as plain text if it doesn't look like JSON
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text: trimmed + '\n' })}\n\n`);
        }
      }
    }
  });

  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[${providerName} stderr]`, msg);
  });

  proc.on('close', (code) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      if (isPlainText) {
        res.write(`data: ${JSON.stringify({ text: buffer.trim() })}\n\n`);
      } else {
        try {
          cliTool.parseStream(buffer, (text) => {
            textSent = true;
            res.write(`data: ${JSON.stringify({ text })}\n\n`);
          });
        } catch {
          if (!textSent) {
            res.write(`data: ${JSON.stringify({ text: buffer.trim() })}\n\n`);
          }
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
    if (code !== 0) console.error(`[${providerName}] exited with code ${code}`);
  });

  proc.on('error', (err) => {
    console.error(`[${providerName} spawn error]`, err.message);
    res.write(`data: ${JSON.stringify({ error: `Failed to start ${providerName} CLI. Is it installed?` })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  res.on('close', () => {
    if (!proc.killed) proc.kill('SIGTERM');
  });
});

// ── Server ────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Mount at both / and /api for flexibility
// Direct: POST /chat     Proxied: POST /api/chat
app.use('/', api);
app.use('/api', api);

const PORT = process.env.PORT || 3456;

app.listen(PORT, () => {
  console.log(`\n  cli-bridge running on http://localhost:${PORT}`);
  console.log(`  Providers: ${Object.keys(CLI_TOOLS).join(', ')}`);
  console.log(`  Health: http://localhost:${PORT}/health\n`);
});

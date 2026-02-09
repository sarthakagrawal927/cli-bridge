import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';

// ── CLI Tool Registry ─────────────────────────────────────────────
// Add new CLI tools here. Each entry needs:
//   command   — the binary name
//   buildArgs — fn(model, systemPrompt) → string[]
//   inputMode — 'stdin' | 'arg' (how to send the prompt)
//   parseStream — fn(jsonLine, emit) to extract text chunks

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
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      // assistant message contains the text content
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) emit(block.text);
        }
        return true; // marks that we got the main response
      }
      if (json.type === 'content_block_delta' && json.delta?.text) {
        emit(json.delta.text);
        return true;
      }
      // skip 'result' type — it duplicates the assistant text
      return false;
    },
  },

  codex: {
    command: 'codex',
    buildArgs: (model, systemPrompt) => {
      const args = ['exec', '--json'];
      if (model) args.push('--model', model);
      if (systemPrompt) args.push('--instructions', systemPrompt);
      return args;
    },
    inputMode: 'stdin',
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'message' && json.content) { emit(json.content); return true; }
      if (json.output_text) { emit(json.output_text); return true; }
      if (json.type === 'response.output_text.delta' && json.delta) { emit(json.delta); return true; }
      if (json.type === 'response.completed' && json.response?.output_text) {
        emit(json.response.output_text);
        return true;
      }
      return false;
    },
  },

  gemini: {
    command: 'gemini',
    buildArgs: (model, systemPrompt) => {
      const args = ['--output-format', 'stream-json'];
      if (model) args.push('--model', model);
      if (systemPrompt) args.push('--system-instruction', systemPrompt);
      return args;
    },
    inputMode: 'arg',
    parseStream: (line, emit) => {
      const json = JSON.parse(line);
      if (json.type === 'assistant' && json.message?.content) {
        for (const block of json.message.content) {
          if (block.type === 'text' && block.text) emit(block.text);
        }
        return true;
      }
      if (json.type === 'content_block_delta' && json.delta?.text) { emit(json.delta.text); return true; }
      if (json.partialText) { emit(json.partialText); return true; }
      if (json.text && !json.type) { emit(json.text); return true; }
      return false;
    },
  },
};

// ── Server ────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3456;

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', providers: Object.keys(CLI_TOOLS) });
});

// POST /chat — { provider, model?, messages: [{role,content}], systemPrompt? }
app.post('/chat', (req, res) => {
  const { provider = 'claude', model, messages, systemPrompt } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const tool = CLI_TOOLS[provider];
  if (!tool) {
    return res.status(400).json({
      error: `Unknown provider: ${provider}`,
      available: Object.keys(CLI_TOOLS),
    });
  }

  const prompt = messages
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const args = tool.buildArgs(model, systemPrompt);
  if (tool.inputMode === 'arg') args.push('-p', prompt);

  const proc = spawn(tool.command, args, {
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  if (tool.inputMode === 'stdin') {
    proc.stdin.write(prompt);
    proc.stdin.end();
  }

  let buffer = '';
  let textSent = false;

  proc.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        tool.parseStream(line, (text) => {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });
      } catch {
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
    if (msg) console.error(`[${provider} stderr]`, msg);
  });

  proc.on('close', (code) => {
    if (buffer.trim()) {
      try {
        tool.parseStream(buffer, (text) => {
          textSent = true;
          res.write(`data: ${JSON.stringify({ text })}\n\n`);
        });
      } catch {
        if (!textSent) {
          res.write(`data: ${JSON.stringify({ text: buffer.trim() })}\n\n`);
        }
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
    if (code !== 0) console.error(`[${provider}] exited with code ${code}`);
  });

  proc.on('error', (err) => {
    console.error(`[${provider} spawn error]`, err.message);
    res.write(`data: ${JSON.stringify({ error: `Failed to start ${provider} CLI. Is it installed?` })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // Kill subprocess only when the client disconnects (response stream closes)
  res.on('close', () => {
    if (!proc.killed) proc.kill('SIGTERM');
  });
});

app.listen(PORT, () => {
  console.log(`\n  cli-bridge running on http://localhost:${PORT}`);
  console.log(`  Providers: ${Object.keys(CLI_TOOLS).join(', ')}`);
  console.log(`  Health: http://localhost:${PORT}/health\n`);
});

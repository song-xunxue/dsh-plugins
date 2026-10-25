// dsh-peer-agents — talk to your other CLI agents as colleagues.
//
// A peer is just a command plus a working directory. Nothing here knows how to be an agent:
// it spawns the CLI you already trust (Claude Code backed by GLM, Codex, Gemini, a script of
// your own), feeds it a prompt, and hands the answer back to the agent that asked.
//
// Named exports only. Do not add `export default`: the dsh loader prefers it and drops inject / Config.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'peer-agents';
export const inject = ['tools'];
/** Other plugins can `inject: ['peerAgents']` and call `ctx.peerAgents.ask(...)`. */
export const provide = 'peerAgents';

const TEXT_OUT = {
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string', required: true } } },
    render: (_args, v) => [{ type: 'text', text: v.text }],
};

const DEFAULT_TIMEOUT_MS = 300000;

const Peer = Schema.object({
    id: Schema.string().required().description('Short id used by peer_ask, e.g. claude.'),
    label: Schema.string().description('Human-readable name shown in peer_list.'),
    command: Schema.string().default('claude').description('Executable to spawn: claude, codex, gemini, or any CLI on PATH.'),
    cwd: Schema.string().description('Working directory the peer works in. Relative paths resolve from this profile.'),
    args: Schema.array(String).default([]).description('Extra arguments always passed before the prompt.'),
    kind: Schema.union(['claude', 'generic']).default('claude')
        .description('claude: adds -p (print) and supports --continue/--model; generic: prompt is the last argument.'),
    promptVia: Schema.union(['stdin', 'arg']).default('stdin')
        .description('stdin: write the prompt to the child standard input; arg: append it as the last argument.'),
    timeoutMs: Schema.natural().default(DEFAULT_TIMEOUT_MS).description('Per-call deadline in milliseconds.'),
});

export const Config = Schema.object({
    peers: Schema.array(Peer).default([{ id: 'claude', label: 'Claude Code', command: 'claude' }])
        .description('The CLI agents this plugin can talk to.'),
    maxOutputChars: Schema.natural().default(12000).description('Per-stream output cap; longer answers are truncated.'),
});

const truncate = (text, limit) => (text.length > limit ? `${text.slice(0, limit)}\n…(${text.length - limit} more chars)` : text);

function killTree(child) {
    if (!child) return;
    try {
        child.kill();
    } catch {
        /* already gone */
    }
    if (process.platform === 'win32' && child.pid !== undefined) {
        try {
            spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        } catch {
            /* best effort */
        }
    }
}

/** Spawn one CLI, feed it a prompt, and collect what it printed. Never throws. */
function runCli({ command, args, cwd, input, timeoutMs, maxChars, signal }) {
    return new Promise((done) => {
        const started = Date.now();
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let settled = false;
        let timedOut = false;

        const finish = (code, spawnError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener?.('abort', onAbort);
            done({ code, stdout, stderr, ms: Date.now() - started, timedOut, truncated, spawnError });
        };

        const cap = (current, chunk) => {
            if (current.length >= maxChars) {
                truncated = true;
                return current;
            }
            const next = current + chunk;
            if (next.length > maxChars) {
                truncated = true;
                return next.slice(0, maxChars);
            }
            return next;
        };

        let child;
        try {
            child = spawn(command, args, {
                cwd,
                // Windows resolves .cmd/.ps1 shims (claude.CMD) only through the shell.
                shell: process.platform === 'win32',
                windowsHide: true,
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (error) {
            done({ code: null, stdout: '', stderr: '', ms: 0, timedOut: false, truncated: false, spawnError: String(error) });
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            killTree(child);
        }, Math.max(1000, timeoutMs));

        const onAbort = () => killTree(child);
        signal?.addEventListener?.('abort', onAbort);

        child.stdout?.on('data', (chunk) => {
            stdout = cap(stdout, chunk.toString('utf8'));
        });
        child.stderr?.on('data', (chunk) => {
            stderr = cap(stderr, chunk.toString('utf8'));
        });
        child.on('error', (error) => finish(null, String(error)));
        child.on('close', (code) => finish(code, undefined));

        if (input !== undefined && child.stdin) {
            child.stdin.on('error', () => {});
            child.stdin.write(input, 'utf8');
            child.stdin.end();
        } else child.stdin?.end?.();
    });
}

function buildCall(peer, { prompt, continuePrevious, model, permissionMode }) {
    const args = [...(peer.args ?? [])];
    const via = peer.promptVia ?? 'stdin';

    if ((peer.kind ?? 'claude') === 'claude') {
        args.push('-p');
        if (continuePrevious) args.push('-c');
        if (model) args.push('--model', model);
        if (permissionMode) args.push('--permission-mode', permissionMode);
    }
    if (via === 'arg') args.push(prompt);
    return { args, input: via === 'arg' ? undefined : prompt };
}

const formatResult = (peer, result, prompt) => {
    const where = peer.cwd ? ` @ ${peer.cwd}` : '';
    const status = result.spawnError
        ? `启动失败：${result.spawnError}`
        : `${result.timedOut ? '超时终止' : 'exit=' + String(result.code)} · ${(result.ms / 1000).toFixed(1)}s`;
    const body = (result.stdout ?? '').trim();
    const err = (result.stderr ?? '').trim();
    const lines = [
        `【${peer.label ?? peer.id}${where}】${status}`,
        body || (err ? '' : '(它什么都没说)'),
    ];
    if (err) lines.push(`--- stderr ---`, truncate(err, 2000));
    if (result.truncated) lines.push('（输出已按上限截断）');
    return { text: lines.filter((line) => line !== '').join('\n'), ...result, prompt };
};

export function apply(ctx, config) {
    const peers = () => {
        const list = Array.isArray(config?.peers) ? config.peers : [];
        return list.length > 0 ? list : [{ id: 'claude', label: 'Claude Code', command: 'claude' }];
    };
    const maxOutputChars = () => Number(config?.maxOutputChars) || 12000;

    const findPeer = (id) => {
        const list = peers();
        if (!id) return list[0];
        return list.find((peer) => peer.id === id || peer.label === id);
    };

    const ask = async (peer, options) => {
        const cwd = options.cwd ?? peer.cwd ?? process.cwd();
        const { args, input } = buildCall(peer, options);
        const result = await runCli({
            command: peer.command ?? 'claude',
            args,
            cwd,
            input,
            timeoutMs: options.timeoutMs ?? peer.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxChars: maxOutputChars(),
            signal: options.signal,
        });
        return formatResult({ ...peer, cwd }, result, options.prompt);
    };

    ctx.tools.register(
        defineTool({
            name: 'peer_list',
            description:
                'List the peer CLI agents (Claude Code / Codex / Gemini / any command) this Harness can talk to, with their command and working directory.',
            parameters: {},
            output: TEXT_OUT,
            isConcurrencySafe: () => true,
            async execute() {
                const rows = peers().map((peer) => {
                    const cwd = peer.cwd ?? '(profile cwd)';
                    const resolved = peer.cwd ? (isAbsolute(peer.cwd) ? peer.cwd : resolve(peer.cwd)) : undefined;
                    const ok = resolved === undefined ? '?' : existsSync(resolved) ? '存在' : '不存在';
                    return `· ${peer.id}${peer.label ? ` (${peer.label})` : ''}\n    命令: ${peer.command ?? 'claude'}   类型: ${peer.kind ?? 'claude'}\n    工作区: ${cwd}  [${ok}]`;
                });
                return {
                    text: rows.length ? `可以对话的同事（${rows.length} 个）:\n${rows.join('\n')}` : '还没有配置任何同事。在 profile 的 cordis.patch.yml 里给 peer-agents 加 peers。',
                };
            },
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'peer_ask',
            description:
                'Ask one peer CLI agent a question in its own workspace and return its answer. Use it to hand work to a colleague (for example Claude Code running on GLM), to ask what it is writing, or to get a second opinion. The peer runs non-interactively (claude -p) and its stdout is returned.',
            parameters: {
                prompt: { type: 'string', required: true, description: 'What to say to the peer. Write it as a message to a colleague.' },
                peer: { type: 'string', description: 'Peer id from peer_list. Defaults to the first one.' },
                cwd: { type: 'string', description: 'Override the working directory for this call.' },
                command: { type: 'string', description: 'Ad-hoc peer: run this command instead of a configured peer.' },
                continue: { type: 'boolean', description: 'claude kind only: continue its most recent conversation in that workspace (-c).' },
                model: { type: 'string', description: 'claude kind only: --model value.' },
                permissionMode: { type: 'string', description: 'claude kind only: --permission-mode value (e.g. plan, acceptEdits).' },
                timeoutMs: { type: 'integer', description: 'Deadline for this call. Defaults to the peer setting.' },
            },
            output: TEXT_OUT,
            timeoutMs: DEFAULT_TIMEOUT_MS + 30000,
            async execute(args, exec) {
                const peer = args.command
                    ? { id: args.command, label: args.command, command: args.command, kind: 'claude', promptVia: 'stdin' }
                    : findPeer(args.peer);
                if (!peer) throw new Error(`unknown peer "${args.peer}"; call peer_list first`);
                const result = await ask(peer, {
                    prompt: args.prompt,
                    cwd: args.cwd,
                    continuePrevious: args.continue === true,
                    model: args.model,
                    permissionMode: args.permissionMode,
                    timeoutMs: args.timeoutMs,
                    signal: exec?.signal,
                });
                return { text: result.text };
            },
        }),
    );

    ctx.tools.register(
        defineTool({
            name: 'peer_ask_all',
            description:
                'Ask every configured peer the same question at the same time and return all answers side by side. Use it to poll the team, to compare recommendations, or when you do not know which colleague is the right one.',
            parameters: {
                prompt: { type: 'string', required: true, description: 'The same message for every peer.' },
                peers: { type: 'string', description: 'Comma-separated peer ids. Default: all.' },
                cwd: { type: 'string', description: 'Override the working directory for every call.' },
                timeoutMs: { type: 'integer', description: 'Deadline per call.' },
            },
            output: TEXT_OUT,
            timeoutMs: DEFAULT_TIMEOUT_MS + 30000,
            async execute(args, exec) {
                const all = peers();
                const wanted = args.peers
                    ? String(args.peers)
                          .split(',')
                          .map((part) => part.trim())
                          .filter(Boolean)
                    : all.map((peer) => peer.id);
                const chosen = all.filter((peer) => wanted.includes(peer.id));
                if (chosen.length === 0) throw new Error(`no peer matched "${args.peers}"; call peer_list first`);
                const results = await Promise.all(
                    chosen.map((peer) =>
                        ask(peer, { prompt: args.prompt, cwd: args.cwd, timeoutMs: args.timeoutMs, signal: exec?.signal }),
                    ),
                );
                return { text: results.map((result) => result.text).join('\n\n') };
            },
        }),
    );
}

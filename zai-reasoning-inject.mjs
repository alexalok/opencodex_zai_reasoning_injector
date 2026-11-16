// OpenCodex plugin: synthetic first-turn reasoning for Z.AI Responses requests.
//
// The last input item with role "user" may carry <reasoning>TEXT</reasoning>. Every such block
// is removed from every user message before the request leaves the proxy. On the first turn
// (no assistant message and no model output item in input yet) the blocks of the last user
// message are appended as one reasoning item followed by user messages "<turn_interrupted/>" and
// "Continue". This supplies context; it does not guarantee continuation of that text.
//
// Upstream hooks can only change URL and headers, so Z.AI Responses sends are routed through a
// loopback relay in this process that rewrites the JSON body and forwards it over TLS. Create
// $OPENCODEX_HOME/zai-reasoning-inject.disabled to bypass the relay without a restart.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';

const HOST = 'api.z.ai';
const PATH = '/api/v1/responses';
const MAX = 64 * 1024 * 1024;
const TAG = /<reasoning>([\s\S]*?)<\/reasoning>/g;
const HOP = ['connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];

function forwardHeaders(source) {
  const headers = new Headers(source);
  for (const name of (headers.get('connection') ?? '').split(',')) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of HOP) headers.delete(name);
  return headers;
}
// Optional capture-relay contract: an active relay applies these byte transforms itself.
// No capture plugin is required or included.
export const TRANSFORMS = Symbol.for('opencodex.zai.requestTransforms');
export const CAPTURE_ACTIVE = Symbol.for('opencodex.zai.captureActive');

const userText = text => ({type: 'message', role: 'user', content: [{type: 'input_text', text}]});
const isUser = item => item && typeof item === 'object' && item.role === 'user';

/** Returns { content, blocks } with tags removed, or null when the content has no tag. */
function stripContent(content) {
  const blocks = [];
  const strip = text => text.replace(TAG, (_, inner) => { blocks.push(inner); return ''; });
  if (typeof content === 'string') {
    const text = strip(content);
    return blocks.length ? {content: text, empty: text.trim() === '', blocks} : null;
  }
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const part of content) {
    if (part && typeof part.text === 'string' && (part.type === 'input_text' || part.type === 'text')) {
      const before = blocks.length;
      const text = strip(part.text);
      // A part that held only the tag would reach Z.AI as an empty text part; drop it.
      if (blocks.length > before && text.trim() === '') continue;
      parts.push(text === part.text ? part : {...part, text});
    } else parts.push(part);
  }
  return blocks.length ? {content: parts, empty: parts.length === 0, blocks} : null;
}

/** Pure transform of a parsed Responses body. Returns a new body, or null when unchanged. */
export function transformResponsesBody(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.input)) return null;
  const input = body.input;
  let last = -1;
  for (let i = input.length - 1; i >= 0; i--) if (isUser(input[i])) { last = i; break; }
  if (last < 0) return null;
  const firstTurn = !input.some(item => item && typeof item === 'object'
    && (item.role === 'assistant' || (item.type !== undefined && item.type !== 'message')));
  let changed = false, injected = [];
  const next = [];
  input.forEach((item, i) => {
    const stripped = isUser(item) ? stripContent(item.content) : null;
    if (!stripped) { next.push(item); return; }
    changed = true;
    if (i === last) injected = stripped.blocks.map(text => text.trim()).filter(Boolean);
    if (!stripped.empty) next.push({...item, content: stripped.content});
  });
  if (!changed) return null;
  if (firstTurn && injected.length) {
    // Z.AI drops reasoning that follows the last user message. Placed before a user message it is
    // kept as a finished assistant turn, so frame it as an interrupted turn the user resumes.
    next.push(
      {type: 'reasoning', summary: [], content: [{type: 'reasoning_text', text: injected.join('\n\n')}], encrypted_content: null},
      userText('<turn_interrupted/>'),
      userText('Continue'),
    );
  }
  return {...body, input: next};
}

/** Byte-level transform registered for relays. Unparseable or unchanged bodies pass through. */
export function transformBytes(bytes, path) {
  if (path !== PATH || !bytes?.length) return bytes;
  try {
    const out = transformResponsesBody(JSON.parse(new TextDecoder().decode(bytes)));
    return out ? new TextEncoder().encode(JSON.stringify(out)) : bytes;
  } catch { return bytes; }
}

export function install(ctx, net = {fetch}) {
  const disabledFile = join(ctx.configDir, 'zai-reasoning-inject.disabled');
  const transform = (bytes, path) => existsSync(disabledFile) ? bytes : transformBytes(bytes, path);
  const transforms = globalThis[TRANSFORMS] ??= new Map();
  transforms.set('zai-reasoning-inject', transform);
  const permit = randomBytes(32).toString('hex');
  const prefix = '/' + permit;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, idleTimeout: 0, maxRequestBodySize: MAX,
    async fetch(req) {
      const url = new URL(req.url);
      if (!url.pathname.startsWith(prefix + '/') || req.method !== 'POST') return new Response(null, {status: 403});
      const path = url.pathname.slice(prefix.length);
      if (path !== PATH) return new Response(null, {status: 403});
      // Enforce the limit while reading, including chunked requests.
      let body;
      try {
        const chunks = [];
        let size = 0;
        const reader = req.body?.getReader();
        if (reader) {
          for (;;) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX) {
              await reader.cancel();
              return new Response(null, {status: 413});
            }
            chunks.push(value);
          }
        }
        body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
      } catch { return new Response(null, {status: 400}); }
      const headers = forwardHeaders(req.headers);
      headers.delete('host');
      headers.delete('content-length');
      headers.set('accept-encoding', 'identity');
      if (!req.headers.get('content-encoding')) body = transform(body, path);
      if (body.byteLength > MAX) return new Response(null, {status: 413});
      try {
        const res = await net.fetch('https://' + HOST + path + url.search, {method: 'POST', headers, body, redirect: 'manual', signal: req.signal, decompress: false});
        return new Response(res.body, {status: res.status, statusText: res.statusText, headers: forwardHeaders(res.headers)});
      } catch { return new Response(null, {status: 502}); }
    }});
  const unregister = ctx.registerUpstreamRewriter(t => {
    if (t.transport !== 'http') return;
    const u = new URL(t.url);
    if (u.protocol !== 'https:' || u.hostname !== HOST || u.port || u.username || u.password || u.hash || u.pathname !== PATH) return;
    if (globalThis[CAPTURE_ACTIVE]?.() || existsSync(disabledFile)) return;
    t.url = 'http://127.0.0.1:' + server.port + prefix + u.pathname + u.search;
  });
  ctx.onShutdown(() => {
    unregister?.();
    if (transforms.get('zai-reasoning-inject') === transform) transforms.delete('zai-reasoning-inject');
    server.stop(true);
  });
  return {port: server.port};
}

export default {name: 'zai-reasoning-inject', setup(ctx) { install(ctx); }};

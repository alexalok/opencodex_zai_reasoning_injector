import {install, transformResponsesBody as tx, transformBytes, TRANSFORMS, CAPTURE_ACTIVE} from '../zai-reasoning-inject.mjs';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';

const dev = t => ({type: 'message', role: 'developer', content: [{type: 'input_text', text: t}]});
const user = (...texts) => ({type: 'message', role: 'user', content: texts.map(text => ({type: 'input_text', text}))});
const R0 = text => ({type: 'reasoning', summary: [], content: [{type: 'reasoning_text', text}], encrypted_content: null});
const R = text => [R0(text), user('<turn_interrupted/>'), user('Continue')];

// First turn: tag stripped from last user message, reasoning appended at end even when a developer message follows.
let out = tx({model: 'glm-5.3', input: [dev('sys'), user('ctx'), user('Fix bug.\n<reasoning>\nUser wants X. Plan: Y.\n</reasoning>\nThanks', 'env'), dev('after')]});
assert.deepEqual(out.input, [dev('sys'), user('ctx'), user('Fix bug.\n\nThanks', 'env'), dev('after'), ...R('User wants X. Plan: Y.')]);
assert.equal(out.model, 'glm-5.3');
// No tag: untouched.
assert.equal(tx({input: [user('hi')]}), null);
// String content and a part that held only the tag is dropped; message emptied entirely is dropped.
assert.deepEqual(tx({input: [{role: 'user', content: 'a <reasoning>t</reasoning>'}]}).input, [{role: 'user', content: 'a '}, ...R('t')]);
assert.deepEqual(tx({input: [user('q', '<reasoning>t</reasoning>')]}).input, [user('q'), ...R('t')]);
assert.deepEqual(tx({input: [dev('s'), user('<reasoning>only</reasoning>')]}).input, [dev('s'), ...R('only')]);
// Multiple blocks joined; empty block injects nothing.
assert.deepEqual(tx({input: [user('<reasoning>a</reasoning>x<reasoning>b</reasoning>')]}).input, [user('x'), ...R('a\n\nb')]);
assert.deepEqual(tx({input: [user('x<reasoning> </reasoning>')]}).input, [user('x')]);
// Later step of the same turn (model output present, even without an assistant message): strip, no injection.
const fc = {type: 'function_call', call_id: 'c', name: 'exec', arguments: '{}'}, fco = {type: 'function_call_output', call_id: 'c', output: 'ok'};
assert.deepEqual(tx({input: [user('q<reasoning>t</reasoning>'), R0('real'), fc, fco]}).input, [user('q'), R0('real'), fc, fco]);
assert.deepEqual(tx({input: [user('q<reasoning>t</reasoning>'), fc, fco]}).input, [user('q'), fc, fco]);
// Later conversation turn: first-turn tag only stripped; later-turn tag becomes reasoning just before its message.
const asst = {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'done'}]};
assert.deepEqual(tx({input: [user('q<reasoning>t</reasoning>'), asst, user('next<reasoning>u</reasoning>')]}).input, [user('q'), asst, R0('u'), user('next')]);
// Not only the last user message: every later-turn tagged message, replayed on each request, keeps its injection.
assert.deepEqual(tx({input: [user('q'), asst, user('a<reasoning>u1</reasoning>'), R0('real'), fc, fco, asst, user('b<reasoning>u2</reasoning>'), dev('env')]}).input,
  [user('q'), asst, R0('u1'), user('a'), R0('real'), fc, fco, asst, R0('u2'), user('b'), dev('env')]);
// A model output item without an assistant message also starts a later turn.
assert.deepEqual(tx({input: [user('q'), fc, fco, user('<reasoning>u</reasoning>more')]}).input, [user('q'), fc, fco, R0('u'), user('more')]);
// Tag-only later message: message dropped, reasoning kept in its place. Empty block: strip only.
assert.deepEqual(tx({input: [user('q'), asst, user('<reasoning>only</reasoning>'), dev('d')]}).input, [user('q'), asst, R0('only'), dev('d')]);
assert.deepEqual(tx({input: [user('q'), asst, user('x<reasoning> </reasoning>')]}).input, [user('q'), asst, user('x')]);
// Multiple blocks in one later message are joined.
assert.deepEqual(tx({input: [user('q'), asst, user('<reasoning>a</reasoning>x<reasoning>b</reasoning>')]}).input, [user('q'), asst, R0('a\n\nb'), user('x')]);
// Tag in a developer message is not touched.
assert.equal(tx({input: [dev('<reasoning>t</reasoning>'), user('q')]}), null);

// Earlier users are stripped, but only the last user's blocks are injected.
assert.deepEqual(tx({input: [user('old<reasoning>old</reasoning>'), user('new')]}).input,
  [user('old'), user('new')]);
assert.deepEqual(tx({input: [user('old<reasoning>old</reasoning>'), user('new<reasoning>new</reasoning>')]}).input,
  [user('old'), user('new'), ...R('new')]);
// Multimodal content survives, and the input object is not mutated.
const image = {type: 'input_image', image_url: 'https://example.com/image.png'};
const original = {input: [{role: 'user', content: [{type: 'input_text', text: '<reasoning>t</reasoning>'}, image]}]};
const snapshot = JSON.stringify(original);
assert.deepEqual(tx(original).input, [{role: 'user', content: [image]}, ...R('t')]);
assert.equal(JSON.stringify(original), snapshot);
assert.equal(tx({input: 'plain string'}), null);
assert.equal(tx({input: [user('<Reasoning>x</Reasoning> <reasoning>unfinished')]}), null);

const configDir = mkdtempSync(tmpdir() + '/zai-inj-');
const priorTransforms = globalThis[TRANSFORMS], priorActive = globalThis[CAPTURE_ACTIVE];
globalThis[TRANSFORMS] = new Map();
let captureActive = false;
globalThis[CAPTURE_ACTIVE] = () => captureActive;
const dest = 'https://api.z.ai/api/v1/responses';
let seen = [], rewriters = [], stops = [];
let upstreamOverride;
const fakeFetch = async (url, init) => {
  if (upstreamOverride) return upstreamOverride(url, init);
  seen.push({url, auth: init.headers.get('authorization'), headers: init.headers, init, body: JSON.parse(new TextDecoder().decode(init.body))});
  return new Response('event: done\ndata: {"ok":"✓"}\n\n', {status: 200, headers: {'content-type': 'text/event-stream'}});
};
const ctx = {configDir, log: console.error, registerUpstreamRewriter: f => { rewriters.push(f); return () => { rewriters = rewriters.filter(x => x !== f); }; }, onShutdown: f => stops.push(f)};
const send = async (url, body) => {
  const t = {url, headers: new Headers({authorization: 'Bearer test-only', 'content-type': 'application/json'}), transport: 'http'};
  for (const f of rewriters) f(t);
  if (!t.url.startsWith('http://127.0.0.1:')) return {direct: true, url: t.url};
  const r = await fetch(t.url, {method: 'POST', headers: t.headers, body: JSON.stringify(body)});
  return {status: r.status, text: await r.text(), url: t.url};
};
const req = {model: 'glm-5.3', stream: true, input: [user('Hi <reasoning>supplied plan</reasoning>')]};
try {
  install(ctx, {fetch: fakeFetch});
  // Other hosts and paths bypass the relay.
  assert.equal((await send('https://chatgpt.com/backend-api/codex/responses', req)).direct, true);
  assert.equal((await send('https://api.z.ai/api/paas/v4/models', req)).direct, true);
  // Relay rewrites body, keeps credentials, streams the reply back.
  let r = await send(dest, req);
  assert.equal(r.status, 200); assert.equal(r.text, 'event: done\ndata: {"ok":"✓"}\n\n');
  assert.equal(seen.at(-1).url, dest); assert.equal(seen.at(-1).auth, 'Bearer test-only');
  assert.deepEqual(seen.at(-1).body.input, [user('Hi '), ...R('supplied plan')]);
  // Wrong permit refused.
  assert.equal((await fetch(r.url.replace(/\/[0-9a-f]{64}\//, '/' + '0'.repeat(64) + '/'), {method: 'POST', body: '{}'})).status, 403);
  // Kill switch: no relay, body goes out untouched.
  writeFileSync(configDir + '/zai-reasoning-inject.disabled', '');
  assert.equal((await send(dest, req)).direct, true);
  rmSync(configDir + '/zai-reasoning-inject.disabled');
  // Simulate a separate relay: injector steps aside and the relay applies shared transforms.
  captureActive = true;
  assert.equal((await send(dest, req)).direct, true);
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  const captureTransform = globalThis[TRANSFORMS].get('zai-reasoning-inject');
  assert.equal(typeof captureTransform, 'function');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captureTransform(bytes, '/api/v1/responses'))).input,
    [user('Hi '), ...R('supplied plan')]);
  writeFileSync(configDir + '/zai-reasoning-inject.disabled', '');
  assert.equal(captureTransform(bytes, '/api/v1/responses'), bytes);
  // A previously rewritten relay URL also obeys the kill switch.
  await fetch(r.url, {method: 'POST', body: JSON.stringify(req)});
  assert.deepEqual(seen.at(-1).body, req);
  rmSync(configDir + '/zai-reasoning-inject.disabled');
  captureActive = false;
  // Token does not authorize arbitrary paths or methods.
  for (const suffix of ['/api/v1/models', '/api/v1/responses/extra']) {
    assert.equal((await fetch(r.url.replace('/api/v1/responses', suffix), {method: 'POST'})).status, 403);
  }
  assert.equal((await fetch(r.url)).status, 403);
  // End-to-end request headers survive; hop-by-hop headers and nominated fields do not.
  await fetch(r.url + '?test=1', {method: 'POST', body: JSON.stringify(req), headers: {
    authorization: 'Bearer test-only', connection: 'x-local', 'x-local': 'remove',
    'proxy-authorization': 'remove', te: 'trailers', 'x-provider': 'keep',
  }});
  assert.equal(seen.at(-1).url, dest + '?test=1');
  assert.equal(seen.at(-1).headers.get('x-local'), null);
  assert.equal(seen.at(-1).headers.get('proxy-authorization'), null);
  assert.equal(seen.at(-1).headers.get('te'), null);
  assert.equal(seen.at(-1).headers.get('x-provider'), 'keep');
  assert.equal(seen.at(-1).init.redirect, 'manual');
  assert.equal(seen.at(-1).init.decompress, false);
  // Invalid JSON and unrelated endpoints pass through the byte transform unchanged.
  const invalid = new TextEncoder().encode('{invalid');
  assert.equal(transformBytes(invalid, '/api/v1/responses'), invalid);
  assert.equal(transformBytes(bytes, '/other'), bytes);
  for (const url of ['http://api.z.ai/api/v1/responses', 'https://api.z.ai:444/api/v1/responses',
    'https://api.z.ai.example/api/v1/responses', 'https://name@api.z.ai/api/v1/responses']) {
    assert.equal((await send(url, req)).direct, true);
  }
  const ws = {url: dest, headers: new Headers(), transport: 'websocket'};
  for (const f of rewriters) f(ws);
  assert.equal(ws.url, dest);
  // The request cap rejects large uploads before any upstream send.
  const sendsBeforeLimit = seen.length;
  const oversized = new Uint8Array(64 * 1024 * 1024 + 1);
  assert.equal((await fetch(r.url, {method: 'POST', body: oversized})).status, 413);
  assert.equal(seen.length, sendsBeforeLimit);
  // Compressed requests remain byte-identical rather than being decoded as JSON.
  const compressed = Bun.gzipSync(JSON.stringify(req));
  upstreamOverride = async (_, init) => {
    assert.deepEqual(init.body, compressed);
    assert.equal(init.headers.get('content-encoding'), 'gzip');
    return new Response(null, {status: 204});
  };
  assert.equal((await fetch(r.url, {method: 'POST', headers: {'content-encoding': 'gzip'}, body: compressed})).status, 204);
  // Network errors are mapped without leaking exception text or credentials.
  upstreamOverride = async () => { throw new Error('private upstream error'); };
  const failed = await fetch(r.url, {method: 'POST', body: '{}'});
  assert.equal(failed.status, 502);
  assert.equal(await failed.text(), '');
  // Response headers are filtered and the first chunk arrives before upstream closes.
  let streamController;
  upstreamOverride = async () => new Response(new ReadableStream({start(controller) {
    streamController = controller;
    controller.enqueue(new TextEncoder().encode('data: first\n\n'));
  }}), {headers: {'content-type': 'text/event-stream', connection: 'x-upstream', 'x-upstream': 'remove', 'x-request-id': 'keep'}});
  const streamed = await fetch(r.url, {method: 'POST', body: '{}'});
  assert.equal(streamed.headers.get('x-upstream'), null);
  assert.equal(streamed.headers.get('x-request-id'), 'keep');
  const reader = streamed.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  streamController.enqueue(new TextEncoder().encode('data: last\n\n'));
  streamController.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: last\n\n');
  assert.equal((await reader.read()).done, true);
  console.log('PASS');
} finally {
  for (const s of stops) s();
  assert.equal(rewriters.length, 0);
  assert.equal(globalThis[TRANSFORMS].has('zai-reasoning-inject'), false);
  globalThis[TRANSFORMS] = priorTransforms;
  globalThis[CAPTURE_ACTIVE] = priorActive;
  rmSync(configDir, {recursive: true, force: true});
}

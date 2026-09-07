// Local-only browser harness. Requires the existing compiled output; writes nothing.
// Run: node scripts/preview-quiz.cjs. Reset: Restart/Retry quiz (or restart this process).
// Stop: Ctrl+C. This deliberately does not activate the extension or execute checks.
'use strict';

const http = require('node:http');
const path = require('node:path');
const { readFile } = require('node:fs/promises');
const Module = require('node:module');
const { createRequire } = Module;
const { fileURLToPath, pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');

const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = 4387;
const ORIGIN = `http://${HOST}:${PORT}`;
const PANEL_FILE = path.join(ROOT, 'out/src/ui/quizPanel.js');
const MAX_BODY = 8192;
const MEDIA = new Map([
  ['learning.css', 'text/css; charset=utf-8'],
  ['quiz.css', 'text/css; charset=utf-8'],
  ['quiz.js', 'text/javascript; charset=utf-8']
]);
const mediaUris = new Map([...MEDIA.keys()].map(name => [path.join(ROOT, 'media', name), `${ORIGIN}/media/${name}`]));
const counters = { errorCount: 0, sourceCount: 0, externalOpenCount: 0, actionCount: 0, timeoutCount: 0, messageCount: 0 };
let lastError;
let panel;
let controller;
let server;
let handlingAction = false;

class Uri {
  constructor(url) {
    this.url = url;
    this.scheme = url.protocol.slice(0, -1);
    this.fsPath = this.scheme === 'file' ? fileURLToPath(url) : '';
  }
  static file(value) { return new Uri(pathToFileURL(path.resolve(value))); }
  static parse(value) { return new Uri(new URL(value)); }
  static joinPath(base, ...parts) {
    if (base.scheme === 'file') { return Uri.file(path.join(base.fsPath, ...parts)); }
    const url = new URL(base.toString());
    url.pathname = path.posix.join(url.pathname, ...parts);
    return new Uri(url);
  }
  toString() { return this.url.href; }
}

function subscribe(listeners, callback, thisArg, disposables) {
  const listener = callback.bind(thisArg);
  listeners.add(listener);
  const disposable = { dispose: () => { listeners.delete(listener); } };
  disposables?.push(disposable);
  return disposable;
}

class PreviewPanel {
  constructor(viewType, title, viewColumn, options) {
    this.viewType = viewType;
    this.title = title;
    this.viewColumn = viewColumn;
    this.options = options;
    this.disposed = false;
    this.receivers = new Set();
    this.disposals = new Set();
    this.posted = [];
    this.htmlGeneration = 0;
    let html = '';
    const owner = this;
    this.webview = {
      cspSource: ORIGIN,
      get html() { return html; },
      set html(value) { html = value; owner.htmlGeneration++; },
      asWebviewUri(value) {
        const url = value.scheme === 'file' && mediaUris.get(value.fsPath);
        if (!url) { throw new Error('Preview media is not approved.'); }
        return Uri.parse(url);
      },
      onDidReceiveMessage: (callback, thisArg, disposables) => subscribe(this.receivers, callback, thisArg, disposables),
      postMessage: async message => {
        if (this.disposed) { return false; }
        counters.messageCount++;
        // Forward only the real host's public acknowledgement, never arbitrary payloads.
        if (message?.type === 'actionFinished' && typeof message.renderId === 'string' && message.renderId.length <= 128) {
          this.posted.push({ type: 'actionFinished', renderId: message.renderId });
          if (this.posted.length > 64) { this.posted.shift(); }
        }
        return true;
      }
    };
  }
  onDidDispose(callback, thisArg, disposables) { return subscribe(this.disposals, callback, thisArg, disposables); }
  reveal(viewColumn) { this.viewColumn = viewColumn ?? this.viewColumn; }
  receive(message) { for (const callback of this.receivers) { callback(message); } }
  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const callback of [...this.disposals]) { callback(); }
    this.disposals.clear();
    this.receivers.clear();
  }
}

function recordError() {
  counters.errorCount++;
  // Do not retain/echo host exceptions: they could contain paths or answer material.
  lastError = 'The quiz host reported an error; details are withheld by the preview.';
}

const vscode = {
  Uri,
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: (...args) => { panel = new PreviewPanel(...args); return panel; },
    showInformationMessage: async (message, _options, ...items) => {
      // The only automated consent is restarting this fixed, disposable sample attempt.
      return message === 'Restart this quiz attempt?' && items.includes('Restart quiz') ? 'Restart quiz' : undefined;
    },
    showErrorMessage: async () => { recordError(); }
  },
  env: { openExternal: async () => { counters.externalOpenCount++; return false; } }
};

function loadPanel() {
  const requireFromPanel = createRequire(PANEL_FILE);
  const originalLoad = Module._load;
  try {
    // Synchronous, narrowly scoped interception. All other imports (including fs,
    // course loading, grading and rendering) use Node's actual module loader/cache.
    Module._load = function (id, parent, isMain) {
      if (id === 'vscode' && parent?.filename === PANEL_FILE) { return vscode; }
      return originalLoad.call(this, id, parent, isMain);
    };
    return requireFromPanel(PANEL_FILE).QuizPanel;
  } finally {
    Module._load = originalLoad;
  }
}

function browserDocument(html) {
  const nonce = /<script\b[^>]*\bnonce="([A-Za-z0-9+/=]+)"/u.exec(html)?.[1];
  const connect = /connect-src (?:&#39;none&#39;|'none');/u;
  if (!nonce || !connect.test(html) || !html.includes('</body>')) {
    throw new Error('Compiled panel document is incompatible with the preview bridge.');
  }
  // The sole CSP relaxation permits the bridge to this exact loopback origin.
  // The inline bootstrap runs before the original deferred quiz.js; UI/scoring stay real.
  const bootstrap = `<script nonce="${nonce}">
(() => {
  'use strict';
  const report = text => {
    const status = document.getElementById('action-status');
    if (status) { status.textContent = text; }
  };
  window.acquireVsCodeApi = () => ({
    postMessage(message) {
      void fetch('/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', mode: 'same-origin', redirect: 'error',
        body: JSON.stringify(message)
      }).then(async response => {
        if (!response.ok) { throw new Error('Preview transport rejected the request.'); }
        const result = await response.json();
        if (result.changed) { location.reload(); return; }
        for (const data of result.messages) {
          window.dispatchEvent(new MessageEvent('message', { data }));
        }
        if (result.error) { report(result.error); }
        else if (result.timedOut) { report('No host completion within two seconds. Reload before continuing.'); }
        else if (result.sourceOpened) { report('Source request recorded (' + result.sourceCount + '); no file or editor opened.'); }
      }).catch(() => { report('Preview transport failed. Reload the page before continuing.'); });
    }
  });
})();
</script>`;
  return html.replace(connect, `connect-src ${ORIGIN};`).replace('</body>', `${bootstrap}</body>`);
}

function reply(response, status, body, type = 'application/json; charset=utf-8') {
  if (response.destroyed || response.writableEnded) { return; }
  response.writeHead(status, {
    'Content-Type': type, 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin'
  });
  response.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readMessage(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let chunks = [];
    let settled = false;
    const fail = (status, message) => {
      if (settled) { return; }
      settled = true;
      chunks = [];
      reject(new RequestError(status, message));
    };
    request.on('data', chunk => {
      if (settled) { return; }
      bytes += chunk.length;
      if (bytes > MAX_BODY) { fail(413, 'JSON body exceeds 8192 bytes.'); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) { return; }
      let message;
      try { message = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { fail(400, 'A JSON object is required.'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        fail(400, 'A JSON object is required.'); return;
      }
      settled = true;
      resolve(message); // The actual QuizPanel validates the complete action envelope.
    });
    request.on('error', () => { fail(400, 'Request could not be read.'); });
    request.on('aborted', () => { fail(400, 'Request was aborted.'); });
  });
}

async function action(message) {
  const current = panel;
  const generation = current.htmlGeneration;
  const sources = counters.sourceCount;
  const errors = counters.errorCount;
  current.posted.length = 0;
  counters.actionCount++;
  current.receive(message); // Registered closure returns void, NOT the host's Promise.
  const deadline = performance.now() + 2000;
  const finished = () => current.htmlGeneration !== generation ||
    current.posted.some(event => event.renderId === message.renderId);
  for (let iteration = 0; iteration < 200; iteration++) {
    await new Promise(resolve => { setImmediate(resolve); });
    if (finished() || performance.now() >= deadline) { break; }
    await new Promise(resolve => { setTimeout(resolve, Math.min(10, Math.max(0, deadline - performance.now()))); });
  }
  const completed = finished();
  if (!completed) { counters.timeoutCount++; }
  return {
    changed: current.htmlGeneration !== generation, completed, timedOut: !completed,
    messages: current.posted.splice(0), sourceOpened: counters.sourceCount > sources,
    sourceCount: counters.sourceCount, errorCount: counters.errorCount,
    ...(counters.errorCount > errors ? { error: lastError } : {})
  };
}

async function main() {
  if (process.argv.length !== 2) { throw new Error('This preview accepts no arguments.'); }
  const QuizPanel = loadPanel();
  const { loadCourse } = createRequire(PANEL_FILE)('../core/course.js');
  const course = await loadCourse(path.join(ROOT, 'examples/foundations/course.json'));
  const unit = course.manifest.units.find(value => value.unitId === 'foundations_start');
  if (!unit) { throw new Error('Bundled sample unit is missing.'); }
  controller = new QuizPanel({ extensionUri: Uri.file(ROOT) }, async () => { counters.sourceCount++; });
  await controller.show({ course, unit });
  browserDocument(panel.webview.html); // Fail closed if the compiled bridge contract changed.
  const assets = new Map(await Promise.all([...MEDIA].map(async ([name, type]) => [
    `/media/${name}`, { body: await readFile(path.join(ROOT, 'media', name)), type }
  ])));

  server = http.createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      // Exact authority/origin checks prevent DNS rebinding and cross-site writes.
      // No CORS, redirects, URL normalization, query parameters or file routes.
      if (request.socket.remoteAddress !== HOST || request.headers.host !== `${HOST}:${PORT}` ||
        (request.headers.origin !== undefined && request.headers.origin !== ORIGIN) ||
        request.headers['sec-fetch-site'] === 'cross-site') {
        request.resume(); reply(response, 403, { error: 'Loopback origin required.' }); return;
      }
      if (request.method === 'GET') {
        if (request.url === '/') { reply(response, 200, browserDocument(panel.webview.html), 'text/html; charset=utf-8'); return; }
        if (request.url === '/state' || request.url === '/status') {
          reply(response, 200, { ...counters, htmlGeneration: panel.htmlGeneration, busy: handlingAction }); return;
        }
        const asset = assets.get(request.url);
        if (asset) { reply(response, 200, asset.body, asset.type); return; }
        reply(response, 404, { error: 'Not found.' }); return;
      }
      if (request.method !== 'POST' || request.url !== '/action') {
        request.resume(); reply(response, 405, { error: 'Method or route not allowed.' }); return;
      }
      if (request.headers.origin !== ORIGIN) {
        request.resume(); reply(response, 403, { error: 'Same-origin POST required.' }); return;
      }
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'] ?? '') ||
        (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
        request.resume(); reply(response, 415, { error: 'Uncompressed application/json required.' }); return;
      }
      if (Number(request.headers['content-length'] ?? 0) > MAX_BODY) {
        request.resume(); reply(response, 413, { error: 'JSON body exceeds 8192 bytes.' }); return;
      }
      const message = await readMessage(request);
      if (handlingAction) { reply(response, 409, { error: 'A quiz action is already pending.' }); return; }
      handlingAction = true;
      try { reply(response, 200, await action(message)); }
      finally { handlingAction = false; }
    })().catch(error => {
      if (error instanceof RequestError) { reply(response, error.status, { error: error.message }); }
      else { recordError(); reply(response, 500, { error: lastError }); }
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  server.setTimeout(5000, socket => { socket.destroy(); });
  server.on('error', () => {
    console.error('Preview server failed. Ensure local port 4387 is free.');
    stop(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`Quiz preview: ${ORIGIN}/ (one shared, in-memory sample attempt)`);
    console.log('Reset: Restart/Retry quiz. Status: /status. Stop: Ctrl+C. No external links or source files are opened.');
  });
}

function stop(code = 0) {
  controller?.dispose();
  if (server) { server.close(); server.closeAllConnections(); }
  process.exitCode = code;
}
process.once('SIGINT', () => { stop(); });
process.once('SIGTERM', () => { stop(); });
void main().catch(() => {
  console.error('Preview could not start. Check existing compiled output, dependencies and bundled sample. Details withheld.');
  stop(1);
});
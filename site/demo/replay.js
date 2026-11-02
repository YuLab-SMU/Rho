// The website demo has no backend. This script runs before the application and answers its
// API requests from demo-data/recording.json, the answers a real Rho service gave while
// scripts/demo-tour.mjs walked the shipped PA14 project. A request the recording does not hold
// is refused as unavailable: nothing is computed, saved or sent anywhere.
(function () {
  var realFetch = window.fetch.bind(window);
  var recording = null;
  var misses = window.__rhoDemoMisses = [];
  function load() {
    return recording || (recording = realFetch(new URL('demo-data/recording.json', document.baseURI)).then(function (r) { return r.json(); }));
  }
  function canonical(value) {
    return JSON.stringify(value, function (_, v) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
      var out = {}; Object.keys(v).sort().forEach(function (k) { out[k] = v[k]; }); return out;
    });
  }
  function answer(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { 'content-type': 'application/json' } });
  }
  function without(input, keys) {
    var copy = {}; Object.keys(input).forEach(function (k) { if (keys.indexOf(k) < 0) copy[k] = input[k]; }); return canonical(copy);
  }
  // A table is read a page at a time. Pages the walk read are cut again for another offset or
  // size when every requested row was recorded.
  function page(entries, input) {
    var rows = {}, template = null, wanted = without(input, ['offset', 'limit']);
    Object.keys(entries).forEach(function (key) {
      var parsed = JSON.parse(key), body = entries[key].body;
      if (!body.ok || without(parsed, ['offset', 'limit']) !== wanted) return;
      template = template || body.value;
      body.value.rows.forEach(function (row, i) { rows[body.value.offset + i] = row; });
    });
    if (!template) return null;
    var offset = input.offset || 0, end = Math.min(offset + (input.limit || 100), template.filtered), out = [];
    for (var i = offset; i < end; i++) { if (!(i in rows)) return null; out.push(rows[i]); }
    var value = Object.assign({}, template, { offset: offset, rows: out, more: end < template.filtered, nextOffset: end < template.filtered ? end : null });
    return { status: 200, body: { apiVersion: '2.0', ok: true, value: value } };
  }
  // A document the walk opened but did not read again answers with the buffer it opened.
  function opened(calls, id) {
    var entries = calls['document.open'] || {}, found = null;
    Object.keys(entries).forEach(function (key) { var b = entries[key].body; if (!found && b.ok && b.value.id === id) found = entries[key]; });
    return found;
  }
  function lookup(calls, method, input) {
    var entries = calls[method];
    if (!entries && method === 'document.read') return opened(calls, input.documentId);
    if (!entries) return null;
    var exact = entries[canonical(input)];
    if (exact) return exact;
    if (method === 'data.page') return page(entries, input);
    if (method === 'document.read') return opened(calls, input.documentId);
    // Reads that differ only in how many records they ask for return the recorded list.
    var loose = without(input, ['limit']), found = null;
    Object.keys(entries).forEach(function (key) { if (!found && without(JSON.parse(key), ['limit']) === loose) found = entries[key]; });
    return found;
  }
  var toast = null, toastTimer = 0;
  function say(text) {
    if (!document.body) return;
    if (!toast) {
      toast = document.createElement('div');
      toast.setAttribute('role', 'status');
      toast.style.cssText = 'position:fixed;left:50%;bottom:56px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 32px));padding:10px 14px;border-radius:8px;background:#202927;color:#fff;font:13px/1.45 system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.18)';
      document.body.appendChild(toast);
    }
    toast.textContent = text; toast.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toast.hidden = true; }, 4200);
  }
  function idleStream(signal) {
    // The live event stream stays open and quiet: a recording has no later events.
    return new Response(new ReadableStream({
      start: function (controller) { if (signal) signal.addEventListener('abort', function () { try { controller.close(); } catch (e) { /* already closed */ } }); }
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }
  window.fetch = function (input, init) {
    var url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url, location.href);
    if (url.origin !== location.origin || url.pathname.indexOf('/api/') !== 0) return realFetch(input, init);
    if (url.pathname === '/api/v2/events') return Promise.resolve(idleStream(init && init.signal));
    var method = url.pathname.slice('/api/v2/'.length);
    var body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
    return load().then(function (rec) {
      var hit = lookup(rec.calls, method, body);
      if (hit) return answer(hit.status, hit.body);
      misses.push({ method: method, input: body });
      say('This is a recorded demo with no backend, so “' + method + '” was not sent anywhere. Install Rho to do this on your own project.');
      return answer(503, { apiVersion: '2.0', ok: false, error: { kind: 'unavailable', message: 'This demo replays a recorded Rho session and has no backend; nothing was sent. Install Rho to run this on your own project.' } });
    });
  };
  // Inside the front page the caption already says this; the badge is for the demo opened on its own.
  function badge() {
    if (window.top !== window.self) return;
    var b = document.createElement('a');
    b.href = '../#install';
    b.target = '_top';
    b.textContent = innerWidth < 768 ? 'Demo · no backend' : 'Demo · recorded PA14 project · no backend';
    b.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646;font-size:' + (innerWidth < 768 ? '11px;padding:3px 8px' : '12px;padding:5px 10px') + ';border:1px solid #c9d6cf;border-radius:999px;background:rgba(255,255,255,.94);color:#1e6b52;font-weight:600;line-height:1.4;font-family:system-ui,-apple-system,sans-serif;text-decoration:none';
    document.body.appendChild(b);
  }
  if (document.body) badge(); else document.addEventListener('DOMContentLoaded', badge);
})();

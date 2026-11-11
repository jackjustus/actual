/**
 * The page Plaid Link runs on. It is served by the sync-server in its own
 * tab because Actual's app page is cross-origin isolated (COOP/COEP), which
 * blocks Link's iframe and the OAuth popup.
 *
 * The page talks only to its own session routes (relative URLs); the
 * session id in the path is the capability, and it expires with the link
 * token.
 */
export function renderLinkPage(opts: {
  linkToken: string;
  mode: 'create' | 'update';
  institutionName?: string | null;
}): string {
  const data = JSON.stringify(opts).replace(/</g, '\\u003c');
  const title =
    opts.mode === 'update'
      ? `Reconnect ${escapeHtml(opts.institutionName ?? 'your bank')}`
      : 'Add a bank account';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Actual</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f8; --fg:#1f2433; --muted:#636b80;
    --card:#fff; --accent:#5c3dd6; --ok:#1d7a4a; --err:#b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14161d; --fg:#e8e9ee;
    --muted:#9aa0b0; --card:#1d2029; --accent:#8f78f0; --ok:#4fc28a; --err:#f97066; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
    background:var(--bg); color:var(--fg);
    font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { background:var(--card); border-radius:14px; padding:32px;
    width:min(420px, calc(100vw - 32px)); box-sizing:border-box;
    box-shadow:0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { margin:0 0 16px; color:var(--muted); }
  ul { margin:0 0 24px; padding-left:18px; color:var(--muted); font-size:14px; }
  button { width:100%; padding:12px 16px; border:0; border-radius:10px;
    background:var(--accent); color:#fff; font:inherit; font-weight:600; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  #status { margin-top:16px; font-size:14px; min-height:1.5em; }
  .ok { color:var(--ok); } .err { color:var(--err); }
</style>
</head>
<body>
<main>
  <h1>${title}</h1>
  <p>${
    opts.mode === 'update'
      ? 'Log in to your bank again so Actual can keep syncing.'
      : 'Connect your bank instantly with Plaid so Actual can import transactions and balances.'
  }</p>
  <ul>
    <li>Your bank login goes to Plaid, never to Actual.</li>
    <li>Bank-level encryption; read-only access.</li>
    <li>You can disconnect at any time.</li>
  </ul>
  <button id="go" disabled>Loading…</button>
  <div id="status" role="status"></div>
</main>
<script src="https://cdn.plaid.com/link/v2/stable/link-initialize.js"></script>
<script>
(function () {
  var S = ${data};
  var base = location.pathname.replace(/\\/$/, '');
  var btn = document.getElementById('go');
  var statusEl = document.getElementById('status');
  var label = S.mode === 'update' ? 'Reconnect' : 'Add a bank account';

  function show(text, cls) { statusEl.textContent = text; statusEl.className = cls || ''; }
  function post(path, body) {
    return fetch(base + '/' + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function watch() {
    fetch(base + '/status', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (res) {
        var s = res.data || {};
        if (s.status === 'importing') {
          show('Importing your transaction history… this can take a minute or two.');
          setTimeout(watch, 3000);
        } else if (s.status === 'complete') {
          btn.hidden = true;
          show(s.duplicate
            ? 'This bank is already connected. Return to Actual to pick accounts.'
            : 'Done! Return to Actual to choose which accounts to link. You can close this tab.', 'ok');
        } else if (s.status === 'error') {
          show((s.error && s.error.reason) || 'Something went wrong.', 'err');
          btn.disabled = false; btn.textContent = 'Try again';
        } else {
          setTimeout(watch, 3000);
        }
      })
      .catch(function () { setTimeout(watch, 5000); });
  }

  var handler = Plaid.create({
    token: S.linkToken,
    onLoad: function () { btn.disabled = false; btn.textContent = label; },
    onSuccess: function (publicToken, metadata) {
      btn.disabled = true;
      show('Connecting…');
      post('complete', { public_token: publicToken, metadata: metadata })
        .then(watch)
        .catch(function () { show('Could not reach the Actual server.', 'err'); });
    },
    onExit: function (err, metadata) {
      post('exit', { error: err, metadata: metadata }).catch(function () {});
      if (err) {
        show((err.display_message || err.error_message || 'The connection did not finish.') +
          ' You can try again.', 'err');
      } else {
        show('Closed without connecting. Return to Actual to use banks you have already connected, or try again.');
      }
    },
    onEvent: function (eventName, metadata) {
      post('event', {
        eventName: eventName,
        link_session_id: metadata.link_session_id,
        institution_id: metadata.institution_id,
        view_name: metadata.view_name,
        error_type: metadata.error_type,
        error_code: metadata.error_code,
      }).catch(function () {});
    },
  });

  btn.addEventListener('click', function () { show(''); handler.open(); });
})();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ] ?? c,
  );
}

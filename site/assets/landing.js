// Agent Handshake landing page: copy buttons and the clickable 3-click demo.
(function () {
  // Copy buttons
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]');
    if (!b) return;
    var text = b.getAttribute('data-copy');
    var done = function () {
      var t = b.textContent;
      b.textContent = 'Copied';
      setTimeout(function () { b.textContent = t; }, 1400);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, done);
    else done();
  });

  // Demo
  var demo = document.querySelector('.demo');
  if (!demo) return;
  var URLS = ['lumenvideo.com', 'lumenvideo.com · choose your app', 'Sign in · agent handshake', 'Your agent app', 'My tools'];
  var BEHIND = [
    'The site publishes an MCP server card. The button picks the right install link per app.',
    'Claude, Cursor and VS Code each get their own install link. Install links never carry keys.',
    'OAuth 2.1 with PKCE. The agent gets a token for this one tool, this plan, and nothing else.',
    'Every call is checked against the plan (scopes, call cap, expiry) and metered at the gateway.',
    'Labels come from real usage. Remove revokes the token at once; upgrades use a checkout page.'
  ];
  var app = 'Claude';

  function go(step) {
    demo.setAttribute('data-step', step);
    demo.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = String(step) !== p.getAttribute('data-pane'); });
    demo.querySelectorAll('.demo-steps li').forEach(function (li) {
      var i = Number(li.getAttribute('data-i'));
      li.className = i < step ? 'is-done' : i === step ? 'is-now' : '';
    });
    demo.querySelector('.demo-url').textContent = URLS[step];
    demo.querySelector('.js-behind').textContent = BEHIND[step];
    demo.querySelectorAll('.js-app').forEach(function (s) { s.textContent = app; });
    if (step === 0) reset();
  }

  function reset() {
    demo.querySelectorAll('.demo-tool').forEach(function (t) { t.classList.remove('is-gone'); t.hidden = false; });
    var toast = demo.querySelector('.demo-toast');
    toast.hidden = true;
  }

  function toast(msg) {
    var t = demo.querySelector('.demo-toast');
    t.textContent = msg;
    t.hidden = false;
  }

  demo.addEventListener('click', function (e) {
    var a = e.target.closest('[data-app]');
    if (a) app = a.getAttribute('data-app');
    var g = e.target.closest('[data-go]');
    if (g) return go(Number(g.getAttribute('data-go')));
    if (e.target.closest('[data-remove]')) {
      var tool = demo.querySelector('[data-tool="notes"]');
      tool.classList.add('is-gone');
      setTimeout(function () { tool.hidden = true; }, 300);
      return toast('Removed Old Notes Tool. Its token is revoked, so your agent can no longer use it.');
    }
    if (e.target.closest('[data-upgrade]')) return toast('A checkout page opens in your browser (Stripe). Your agent never sees card details. This is a demo, so nothing happens.');
    if (e.target.closest('[data-keep]')) return toast('Lumen Video moves to the free plan when the trial ends. No card needed.');
  });

  go(0);
})();

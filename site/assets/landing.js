// Agent Handshake landing page: hub links, copy buttons, and the agent demo.
(function () {
  // Point "Connect your agent" at the live hub when one is configured (site/config.js).
  var hub = (window.AH_HUB_URL || '').replace(/\/+$/, '');
  if (hub) {
    document.querySelectorAll('[data-hub]').forEach(function (a) { a.href = hub + a.getAttribute('data-hub'); });
    document.querySelectorAll('[data-hub-text]').forEach(function (el) { el.textContent = hub + el.getAttribute('data-hub-text'); });
  }

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

  // Agent demo: the agent finds, adds and uses a tool.
  var root = document.querySelector('.agentdemo');
  if (!root) return;
  var body = root.querySelector('.ad-body');
  var behind = root.querySelector('.ad-behind');
  var STEPS = [
    { html: '<div class="b me">Make me a 15-second video of a sunrise over a lake.</div>', why: 'The agent has no video tool yet. It is connected to one hub that has many.' },
    { html: '<div class="b bot">I can\'t make videos yet. Let me find a tool.</div><span class="chip">handshake_search · "video"</span>', why: 'The agent searches the catalog in plain words.' },
    { html: '<div class="found"><span class="mi">L</span><div><b>Lumen Video</b><small>Turn a prompt into a short video · Free for 7 days, up to 100 calls · then $9/mo</small></div></div>', why: 'Each result carries its terms: what it can do, the free trial, the price.' },
    { html: '<span class="chip">handshake_add · lumen-video</span><div class="b bot">Lumen Video has a free 7-day trial with a $0 spend limit, so I added it.</div>', why: 'You allowed free trials when you connected, so the agent adds it right away. Paid plans would need you.' },
    { html: '<span class="chip">lumen-video__create_project</span><div class="b bot">Done: project prj_001 with 3 shots (sunrise, lake, close-up). Want a preview?</div>', why: 'The new tool is checked against its plan and metered on every call.' },
    { html: '<div class="b me">Can you render it in 4K?</div>', why: '4K is a paid feature of this tool.' },
    { html: '<span class="chip">handshake_upgrade · lumen-video</span><div class="b bot">4K is part of Lumen Video Pro ($9/mo). You can upgrade here: <span class="lnk">checkout link</span>. You pay on that page, never in chat.</div>', why: 'Money only moves after you approve on a checkout page. You can remove the tool anytime in My tools.' },
  ];
  var i = 0;
  function show(n) {
    for (; i < n && i < STEPS.length; i++) {
      var div = document.createElement('div');
      div.className = 'ad-step';
      div.innerHTML = STEPS[i].html;
      body.appendChild(div);
      behind.textContent = STEPS[i].why;
    }
    body.scrollTop = body.scrollHeight;
    root.querySelector('[data-ad="next"]').disabled = i >= STEPS.length;
  }
  function reset() {
    body.innerHTML = '';
    i = 0;
    show(1);
  }
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ad]');
    if (!b) return;
    var a = b.getAttribute('data-ad');
    if (a === 'next') show(i + 1);
    if (a === 'all') show(STEPS.length);
    if (a === 'reset') reset();
  });
  reset();
})();

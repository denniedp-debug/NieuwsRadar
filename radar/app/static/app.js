(() => {
  const app = document.getElementById('app');
  const TABS = [['all', 'Alles'], ['ok', 'Bevestigd'], ['it', 'IT-security'], ['il', 'Israël'], ['nl', 'Nederland'], ['tech', 'Tech'], ['world', 'Wereld']];
  const state = { tab: localGet('tab') || 'all', q: '', limit: 30, dismissed: localGet('dismissed') || '' };

  function localGet(k) { try { return localStorage.getItem('nr:' + k); } catch { return null; } }
  function localSet(k, v) { try { localStorage.setItem('nr:' + k, v); } catch {} }
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || '') ? u : '');
  const check = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>';

  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 60) return `${Math.max(m, 1)} min geleden`;
    if (m < 1440) return `${Math.round(m / 60)} uur geleden`;
    return new Date(iso).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short' });
  }
  const catClass = (c) => (c.critical ? 'cat-crit' : 'cat-' + (c.category || 'world'));

  function badge(c, long) {
    let out = '';
    if (c.critical) out += `<span class="badge b-crit">Kritiek${long ? ' · pushmelding verstuurd' : ' · push'}</span>`;
    if (c.status === 'confirmed') out += `<span class="badge b-ok">${long ? 'Bevestigd door ' : ''}${c.independent} onafhankelijke bronnen</span>`;
    if (c.status === 'official') out += `<span class="badge b-ok">Officiële bron</span>`;
    if (c.status === 'waiting') out += `<span class="badge b-wait">Wacht op bevestiging</span>`;
    return out;
  }

  function hero(c, cls) {
    const img = safeUrl(c.image);
    return `<div class="${cls} ${catClass(c)}${img ? ' has-img' : ''}">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : '<span class="blob1"></span><span class="blob2"></span>'}`;
  }

  async function api(path, opts) {
    const r = await fetch(path, opts);
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }

  // ---------- Feed ----------
  async function renderFeed() {
    const [items, cfg, watch] = await Promise.all([
      api(`/api/clusters?cat=${encodeURIComponent(state.tab)}&q=${encodeURIComponent(state.q)}&limit=${state.limit}`),
      api('/api/settings'),
      api('/api/watchers').catch(() => []),
    ]);
    const watchHtml = watch.length ? `<div class="panel"><h3>Paginawachters</h3>${watch.map((w) => `
      <div style="margin-bottom:12px"><a href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener"><b>${esc(w.name)}</b></a>
      <small style="display:block;color:var(--on-var)">${w.changed ? 'Laatst gewijzigd ' + esc(ago(w.changed)) : 'Nog geen wijziging gezien'}</small>
      ${w.text ? `<pre style="white-space:pre-wrap;font:inherit;font-size:14px;margin:8px 0 0;background:var(--surface);border-radius:16px;padding:12px 14px">${esc(w.text)}</pre>` : ''}</div>`).join('')}
      <button class="tonal" id="testWatch">Stuur testmelding</button></div>` : '';
    const crit = items.find((c) => c.critical && Date.now() - new Date(c.updatedAt) < 864e5);
    const snack = crit && String(crit.id) !== state.dismissed
      ? `<div class="snack" role="status"><div class="t"><b>Kritiek: ${esc(crit.title)}</b><span>Bevestigd door ${crit.independent} bronnen · ${esc(ago(crit.updatedAt))}</span></div>
         <a href="#/c/${crit.id}">Openen</a><button data-dismiss="${crit.id}" aria-label="Melding sluiten">✕</button></div>` : '';
    const chips = TABS.map(([id, label]) =>
      `<button class="chip" data-tab="${id}" aria-pressed="${state.tab === id}">${state.tab === id ? check : ''}${label}</button>`).join('');
    const cards = items.map((c, i) => `
      <a class="card" href="#/c/${c.id}">
        ${hero(c, 'hero' + (i === 0 ? ' big' : ''))}
          <span class="lead"><span class="dot">${esc((c.lead || '?')[0])}</span>${esc(c.lead)}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${esc(c.title)}</div>
          ${c.teaser ? `<div class="teaser">${esc(c.teaser)}</div>` : ''}
          <div class="meta">${badge(c)}<span>${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}</span></div>
        </div>
      </a>`).join('');
    const rules = cfg.rules.map((r) => `
      <label class="rule"><span>${esc(r.label)}<small>${esc(r.hint)}</small></span>
        <input class="switch" type="checkbox" role="switch" data-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}></label>`).join('');
    app.innerHTML = `
      <div class="layout">
        <section class="feed">
          ${snack}
          <nav class="chips" aria-label="Rubriek">${chips}</nav>
          <h2 class="section-h">Voor jou · ${new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          ${cards || '<div class="empty">Nog niets hier. De radar haalt elke 5 minuten nieuwe artikelen op.</div>'}
          ${items.length >= state.limit ? '<button class="tonal more" id="more">Meer laden</button>' : ''}
        </section>
        <aside class="side">
          <div class="panel" id="pushPanel"><h3>Meldingen op dit apparaat</h3><p>Even kijken…</p></div>
          <div class="panel"><h3>Pushregels</h3><p>Bepaalt wanneer je een melding krijgt.</p>${rules}</div>
          ${watchHtml}
          <div class="panel"><h3>Watchlist</h3><div class="tags">${cfg.watchlist.map((w) => `<span class="tag">${esc(w)}</span>`).join('')}</div></div>
          <div class="panel"><h3>Zo telt de radar</h3><p>Overgenomen ANP-, Reuters- of AP-tekst telt als één bron. Bevestigd = 2+ bronnen met eigen herkomst binnen 48 uur.</p>
          <p>Laatste run: ${cfg.lastRun ? esc(ago(cfg.lastRun)) : 'nog niet'}</p></div>
        </aside>
      </div>`;
    updatePushPanel();
  }

  // ---------- Web Push ----------
  const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  async function updatePushPanel(msg) {
    const el = document.getElementById('pushPanel');
    if (!el) return;
    const h = '<h3>Meldingen op dit apparaat</h3>';
    if (!window.isSecureContext) { el.innerHTML = h + '<p>Open de app via https om meldingen te kunnen aanzetten.</p>'; return; }
    if (isIos && !standalone) { el.innerHTML = h + '<p>Op iPhone/iPad: tik op <b>Deel › Zet op beginscherm</b> en open NieuwsRadar vanaf het beginscherm. Daarna kun je hier meldingen aanzetten.</p>'; return; }
    if (!pushSupported) { el.innerHTML = h + '<p>Deze browser ondersteunt geen pushmeldingen.</p>'; return; }
    if (Notification.permission === 'denied') { el.innerHTML = h + '<p>Meldingen zijn geblokkeerd. Sta ze toe in de site-instellingen van je browser.</p>'; return; }
    const sub = await currentSub().catch(() => null);
    let prefsHtml = '';
    if (sub) {
      const r = await api('/api/push/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null);
      if (!r) { await sub.unsubscribe().catch(() => {}); return updatePushPanel('Dit apparaat was niet meer bekend. Zet meldingen opnieuw aan.'); }
      const p = r.prefs;
      const row = (key, label, hint, on) => `<label class="rule"><span>${esc(label)}<small>${esc(hint)}</small></span>
        <input class="switch" type="checkbox" role="switch" data-pref="${esc(key)}" ${on ? 'checked' : ''}></label>`;
      prefsHtml = '<p style="margin-top:6px">Wat wil je op dit apparaat ontvangen?</p>'
        + row('news', 'Nieuws', 'Volgens de pushregels hieronder', p.news)
        + row('security', 'IT-beveiliging', 'Kritieke lekken, NCSC en CISA', p.security)
        + r.watchers.map((w) => row('watch:' + w, w, 'Paginawachter', p.watchers === 'all' || p.watchers.includes(w))).join('');
    }
    el.innerHTML = h + (sub
      ? `${prefsHtml}
         <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"><button class="tonal" id="pushTest">Testmelding</button>
         <button class="chip" id="pushOff">Uitzetten</button></div>`
      : `<p>Uit. Zet meldingen aan om kritieke lekken en wijzigingen meteen te zien.</p>
         <button class="tonal" id="pushOn">Meldingen aanzetten</button>`) + (msg ? `<p style="margin:10px 0 0">${esc(msg)}</p>` : '');
  }
  async function pushOn() {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return updatePushPanel('Toestemming niet gegeven.');
    const { publicKey } = await api('/api/push/key');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
    const label = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    await api('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), label }) });
    updatePushPanel('Meldingen staan aan.');
  }
  async function pushOff() {
    const sub = await currentSub();
    if (sub) {
      await api('/api/push/unsubscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    }
    updatePushPanel();
  }
  async function pushTest() {
    const sub = await currentSub();
    if (!sub) return updatePushPanel();
    const r = await api('/api/push/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
    updatePushPanel(r.sent ? 'Testmelding verstuurd.' : 'Versturen mislukt. Zet meldingen uit en weer aan.');
  }

  async function savePrefs() {
    const sub = await currentSub();
    if (!sub) return;
    const boxes = [...document.querySelectorAll('[data-pref]')];
    const val = (k) => boxes.find((b) => b.dataset.pref === k)?.checked ?? true;
    const w = boxes.filter((b) => b.dataset.pref.startsWith('watch:'));
    const prefs = { news: val('news'), security: val('security'),
      watchers: w.every((b) => b.checked) ? 'all' : w.filter((b) => b.checked).map((b) => b.dataset.pref.slice(6)) };
    await api('/api/push/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, prefs }) });
  }

  // ---------- Detail ----------
  async function renderDetail(id) {
    const c = await api('/api/clusters/' + encodeURIComponent(id));
    const facts = (c.facts || []).map((f) => `<li><span class="check">${check}</span><span>${esc(f.text)} <small style="color:var(--on-var)">(${esc((f.by || []).join(', '))})</small></span></li>`).join('');
    const disputed = (c.disputed || []).map((d) => `<li>${esc(d)}</li>`).join('');
    const srcs = c.sources.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">
      <span class="ini">${esc((s.feed_title || '?')[0])}</span>
      <span style="flex:1;min-width:0"><b style="font-weight:500">${esc(s.feed_title)}</b><small>${esc(s.origin === s.site ? 'eigen redactie' : 'herkomst: ' + s.origin)} · ${esc(ago(s.published_at))}</small><small>${esc(s.title)}</small></span></a></li>`).join('');
    app.innerHTML = `
      <a class="back" href="#/"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Terug naar feed</a>
      <div style="display:flex;flex-direction:column;gap:20px;padding:12px 0 40px">
        ${hero(c, 'dhero')}
          <div class="dhero-in"><span class="pill">${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}</span><h1>${esc(c.title)}</h1></div>
        </div>
        <div class="layout" style="padding:0">
          <article class="article">
            <div class="meta">${badge(c, true)}</div>
            ${c.summary ? `<p class="lede">${esc(c.summary)}</p>` : `<p class="lede">${esc(c.teaser)}</p>`}
            ${facts ? `<div class="box"><h2>Wat de bronnen bevestigen</h2><ul class="facts">${facts}</ul></div>` : ''}
            ${disputed ? `<div class="box"><h2>Waar de bronnen verschillen</h2><ul>${disputed}</ul></div>` : ''}
            ${c.pushReason ? `<div class="why">Waarom je een melding kreeg: ${esc(c.pushReason)}.</div>` : ''}
          </article>
          <aside class="side"><div class="panel"><h2>Bronnen (${c.sources.length})</h2><ul class="srcs">${srcs}</ul></div></aside>
        </div>
      </div>`;
    window.scrollTo(0, 0);
  }

  // ---------- Router & events ----------
  async function route() {
    const m = location.hash.match(/^#\/c\/(\d+)/);
    try { m ? await renderDetail(m[1]) : await renderFeed(); }
    catch { app.innerHTML = '<div class="empty">Kan de radar niet bereiken. Je ziet de laatst opgeslagen versie zodra die er is.</div>'; }
  }
  window.addEventListener('hashchange', route);

  app.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tab],[data-dismiss],#more,#testWatch,#pushOn,#pushOff,#pushTest');
    if (!t) return;
    if (t.id === 'pushOn' || t.id === 'pushOff' || t.id === 'pushTest') {
      t.disabled = true;
      ({ pushOn, pushOff, pushTest })[t.id]().catch((err) => updatePushPanel('Mislukt: ' + err.message));
      return;
    }
    if (t.id === 'testWatch') { t.disabled = true; t.textContent = 'Verstuurd'; api('/api/watchers/test', { method: 'POST' }).then(renderFeed).catch(() => {}); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.limit = 30; localSet('tab', state.tab); renderFeed(); }
    else if (t.dataset.dismiss) { state.dismissed = t.dataset.dismiss; localSet('dismissed', state.dismissed); renderFeed(); }
    else if (t.id === 'more') { state.limit += 30; renderFeed(); }
  });
  app.addEventListener('change', async (e) => {
    if (e.target.closest('[data-pref]')) return savePrefs();
    const t = e.target.closest('[data-rule]');
    if (!t) return;
    await api('/api/rules/' + t.dataset.rule, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: t.checked }) });
  });
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = document.getElementById('q').value.trim();
    location.hash === '#/' || location.hash === '' ? renderFeed() : (location.hash = '#/');
  });

  // Elke 2 minuten verversen als de feed open staat
  setInterval(() => { if (!location.hash.startsWith('#/c/') && document.visibilityState === 'visible') renderFeed().catch(() => {}); }, 120000);

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let deferred;
  const btn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; });

  route();
})();

(() => {
  const app = document.getElementById('app');
  const TABS = [['all', 'Alles'], ['ok', 'Bevestigd'], ['it', 'IT-security'], ['il', 'Israël'], ['nl', 'Nederland'], ['kerk', 'Kerk'], ['tech', 'Tech'], ['world', 'Wereld']];
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
    const items = await api(`/api/clusters?cat=${encodeURIComponent(state.tab)}&q=${encodeURIComponent(state.q)}&limit=${state.limit}`);
    const crit = items.find((c) => c.critical && Date.now() - new Date(c.updatedAt) < 864e5);
    const snack = crit && String(crit.id) !== state.dismissed
      ? `<div class="snack" role="status"><div class="t"><b>Kritiek: ${esc(crit.title)}</b><span>Bevestigd door ${crit.independent} bronnen · ${esc(ago(crit.updatedAt))}</span></div>
         <a href="#/c/${crit.id}">Openen</a><button data-dismiss="${crit.id}" aria-label="Melding sluiten">✕</button></div>` : '';
    const chips = TABS.map(([id, label]) =>
      `<button class="chip" data-tab="${id}" aria-pressed="${state.tab === id}">${state.tab === id ? check : ''}${label}</button>`).join('');
    const cards = items.map((c, i) => `
      <article class="card-wrap" data-card="${c.id}">
      <button class="hide-btn" data-hide="${c.id}" aria-label="Niet interessant: ${esc(c.title)}" title="Niet interessant">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/></svg>
      </button>
      <a class="card" href="#/c/${c.id}">
        ${hero(c, 'hero' + (i === 0 ? ' big' : ''))}
          <span class="lead"><span class="dot">${esc((c.lead || '?')[0])}</span>${esc(c.lead)}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${esc(c.title)}</div>
          ${c.teaser ? `<div class="teaser">${esc(c.teaser)}</div>` : ''}
          <div class="meta">${badge(c)}<span>${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}${c.originalTitle ? ' · vertaald' : ''}</span></div>
        </div>
      </a></article>`).join('');
    app.innerHTML = `
      <section class="feed single">
        <div id="undo"></div>
        ${snack}
        <nav class="chips" aria-label="Rubriek">${chips}</nav>
        <h2 class="section-h">${state.q ? 'Zoekresultaten voor “' + esc(state.q) + '”' : 'Voor jou · ' + new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        ${cards || '<div class="empty">Nog niets hier. De radar haalt elke 5 minuten nieuwe artikelen op.</div>'}
        ${items.length >= state.limit ? '<button class="tonal more" id="more">Meer laden</button>' : ''}
      </section>`;
  }

  // ---------- Pagina's uit het menu ----------
  const page = (title, body) => `<section class="page"><h1 class="page-h">${title}</h1>${body}</section>`;

  async function renderMeldingen() {
    const cfg = await api('/api/settings');
    const rules = cfg.rules.map((r) => `
      <label class="rule"><span>${esc(r.label)}<small>${esc(r.hint)}</small></span>
        <input class="switch" type="checkbox" role="switch" data-rule="${esc(r.id)}" ${r.enabled ? 'checked' : ''}></label>`).join('');
    app.innerHTML = page('Meldingen', `
      <div class="panel" id="pushPanel"><h3>Meldingen op dit apparaat</h3><p>Even kijken…</p></div>
      <div class="panel"><h3>Pushregels</h3><p>Bepaalt wanneer nieuws een melding oplevert. Geldt voor alle apparaten.</p>${rules}</div>
      <div class="panel"><h3>Watchlist</h3><p>Aanpassen in config.yaml.</p><div class="tags">${cfg.watchlist.map((w) => `<span class="tag">${esc(w)}</span>`).join('')}</div></div>`);
    updatePushPanel();
  }

  async function renderWachters() {
    const watch = await api('/api/watchers').catch(() => []);
    app.innerHTML = page('Paginawachters', (watch.length ? watch.map((w) => `
      <div class="panel"><h3><a href="${esc(safeUrl(w.url))}" target="_blank" rel="noopener">${esc(w.name)}</a></h3>
      <p>${w.changed ? 'Laatst gewijzigd ' + esc(ago(w.changed)) : 'Nog geen wijziging gezien'}${w.checked ? ' · gecontroleerd ' + esc(ago(new Date(w.checked * 1000).toISOString())) : ''}</p>
      ${w.text ? `<pre class="watch-text">${esc(w.text)}</pre>` : '<p>Nog niet opgehaald.</p>'}</div>`).join('')
      + '<button class="tonal" id="testWatch">Stuur testmelding</button>'
      : '<div class="panel"><p>Nog geen paginawachters. Voeg ze toe onder <b>watchers</b> in config.yaml.</p></div>'));
  }

  async function renderFilters() {
    const [f, hidden] = await Promise.all([api('/api/filters'), api('/api/clusters?cat=hidden&limit=50')]);
    app.innerHTML = page('Filters', `
      <div class="panel"><h3>Zo werkt het</h3>
        <p>Tik op het oog-icoon op een verhaal (of <b>Niet interessant</b> op de artikelpagina). Dat verhaal verdwijnt, en nieuwe verhalen die er sterk op lijken worden voortaan ook verborgen.</p></div>
      <div class="panel"><h3>Geleerd van jou (${f.learned.length})</h3>
        ${f.learned.length ? '<ul class="srcs">' + f.learned.map((n) => `<li><span style="display:flex;align-items:center;gap:12px;min-height:52px">
          <span style="flex:1;min-width:0">${esc(n.title)}</span>
          <button class="chip" data-forget="${n.id}">Vergeten</button></span></li>`).join('') + '</ul>' : '<p>Nog niets. Verberg een paar verhalen die je niet interesseren.</p>'}</div>
      <div class="panel"><h3>Trefwoorden</h3><p>Aanpassen onder <b>filters › keywords</b> in config.yaml.</p>
        <div class="tags">${f.keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join('') || '<span class="tag">geen</span>'}</div></div>
      <div class="panel"><h3>Verborgen verhalen (${f.hiddenCount})</h3>
        ${hidden.length ? '<ul class="srcs">' + hidden.map((c) => `<li><span style="display:flex;align-items:center;gap:12px;min-height:52px">
          <a href="#/c/${c.id}" style="flex:1;min-width:0;color:var(--on)">${esc(c.title)}</a>
          <button class="chip" data-unhide="${c.id}">Terugzetten</button></span></li>`).join('') + '</ul>' : '<p>Niets verborgen.</p>'}</div>`);
  }

  async function setHidden(id, hidden) {
    await api(`/api/clusters/${id}/hide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hidden }) });
  }

  function renderWeergave() {
    const cur = localGet('fs') || 'm';
    const opts = [['s', 'Klein'], ['m', 'Normaal'], ['l', 'Groot'], ['xl', 'Groter']];
    app.innerHTML = page('Weergave', `
      <div class="panel"><h3>Tekstgrootte</h3><p>Geldt alleen voor dit apparaat.</p>
        <div class="seg" role="radiogroup" aria-label="Tekstgrootte">${opts.map(([k, l]) =>
          `<label class="seg-item"><input type="radio" name="fs" value="${k}" ${cur === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
        <p style="margin-top:14px">Voorbeeld: <b>Twee kritieke lekken in PHP; noodpatches uitgebracht</b></p>
      </div>
      <div class="panel"><h3>Thema</h3><p>Automatisch volgt de instelling van je telefoon of computer.</p>
        <div class="seg three" role="radiogroup" aria-label="Thema">${[['auto', 'Automatisch'], ['light', 'Licht'], ['dark', 'Donker']].map(([k, l]) =>
          `<label class="seg-item"><input type="radio" name="theme" value="${k}" ${(localGet('theme') || 'auto') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
      </div>`);
  }

  async function renderUitleg() {
    const cfg = await api('/api/settings').catch(() => ({}));
    app.innerHTML = page('Zo werkt de radar', `
      <div class="panel"><h3>Bronnen tellen</h3>
        <p>Artikelen over hetzelfde onderwerp worden samengevoegd tot één verhaal. De radar telt de <b>herkomst</b>, niet het aantal sites: overgenomen ANP-, Reuters-, AP- of AFP-tekst telt als één bron.</p>
        <p><b>Bevestigd</b> = minstens 2 bronnen met een eigen herkomst binnen 48 uur. <b>Officieel</b> = alleen een officiële bron zoals NCSC. <b>Wacht op bevestiging</b> = nog maar één herkomst.</p></div>
      <div class="panel"><h3>Status</h3><p>Laatste run: ${cfg.lastRun ? esc(ago(cfg.lastRun)) : 'nog niet'}</p></div>`);
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
      <a class="back" href="#/"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>Terug</a>
      <div style="display:flex;flex-direction:column;gap:20px;padding:12px 0 40px">
        ${hero(c, 'dhero')}
          <div class="dhero-in"><span class="pill">${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}</span><h1>${esc(c.title)}</h1></div>
        </div>
        <div class="layout" style="padding:0">
          <article class="article">
            <div class="meta">${badge(c, true)}</div>
            <div><button class="chip" data-detail-hide="${c.id}" data-state="${c.hidden ? 'hidden' : 'shown'}">${c.hidden ? 'Terugzetten in de feed' : 'Niet interessant'}</button>
              ${c.hidden && c.hideReason ? `<small style="color:var(--on-var);margin-left:8px">Verborgen: ${esc(c.hideReason)}</small>` : ''}</div>
            ${c.originalTitle ? `<p class="translated">Automatisch vertaald uit het Engels · origineel: “${esc(c.originalTitle)}”</p>` : ''}
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
  const PAGES = { '#/filters': renderFilters, '#/meldingen': renderMeldingen, '#/wachters': renderWachters, '#/weergave': renderWeergave, '#/uitleg': renderUitleg };
  const isFeed = () => location.hash === '' || location.hash === '#/' || location.hash === '#';
  async function route() {
    const m = location.hash.match(/^#\/c\/(\d+)/);
    document.querySelectorAll('.drawer a').forEach((a) => a.setAttribute('aria-current', a.getAttribute('href') === (location.hash || '#/') ? 'page' : 'false'));
    try {
      if (m) await renderDetail(m[1]);
      else if (PAGES[location.hash]) await PAGES[location.hash]();
      else await renderFeed();
      if (!m) window.scrollTo(0, 0);
    } catch { app.innerHTML = '<div class="empty">Kan de radar niet bereiken. Je ziet de laatst opgeslagen versie zodra die er is.</div>'; }
  }
  window.addEventListener('hashchange', route);

  app.addEventListener('click', (e) => {
    const h = e.target.closest('[data-hide],[data-undo],[data-detail-hide],[data-unhide],[data-forget]');
    if (h) {
      e.preventDefault();
      if (h.dataset.hide) {
        const id = h.dataset.hide;
        setHidden(id, true).then(() => {
          document.querySelector(`[data-card="${id}"]`)?.remove();
          const u = document.getElementById('undo');
          if (u) u.innerHTML = `<div class="snack" role="status"><div class="t"><b>Verborgen</b><span>Vergelijkbare verhalen worden voortaan ook verborgen.</span></div><button data-undo="${id}">Ongedaan maken</button></div>`;
        }).catch(() => {});
      } else if (h.dataset.undo) setHidden(h.dataset.undo, false).then(renderFeed);
      else if (h.dataset.detailHide) setHidden(h.dataset.detailHide, h.dataset.state !== 'hidden').then(() => (h.dataset.state === 'hidden' ? renderDetail(h.dataset.detailHide) : (location.hash = '#/')));
      else if (h.dataset.unhide) setHidden(h.dataset.unhide, false).then(renderFilters);
      else if (h.dataset.forget) api('/api/filters/learned/' + h.dataset.forget, { method: 'DELETE' }).then(renderFilters);
      return;
    }
    const t = e.target.closest('[data-tab],[data-dismiss],#more,#testWatch,#pushOn,#pushOff,#pushTest');
    if (!t) return;
    if (t.id === 'pushOn' || t.id === 'pushOff' || t.id === 'pushTest') {
      t.disabled = true;
      ({ pushOn, pushOff, pushTest })[t.id]().catch((err) => updatePushPanel('Mislukt: ' + err.message));
      return;
    }
    if (t.id === 'testWatch') { t.disabled = true; t.textContent = 'Verstuurd'; api('/api/watchers/test', { method: 'POST' }).then(renderWachters).catch(() => {}); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.limit = 30; localSet('tab', state.tab); renderFeed(); }
    else if (t.dataset.dismiss) { state.dismissed = t.dataset.dismiss; localSet('dismissed', state.dismissed); renderFeed(); }
    else if (t.id === 'more') { state.limit += 30; renderFeed(); }
  });
  app.addEventListener('change', async (e) => {
    if (e.target.name === 'fs') { localSet('fs', e.target.value); applyFontSize(); return; }
    if (e.target.name === 'theme') { localSet('theme', e.target.value); applyTheme(); return; }
    if (e.target.closest('[data-pref]')) return savePrefs();
    const t = e.target.closest('[data-rule]');
    if (!t) return;
    await api('/api/rules/' + t.dataset.rule, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: t.checked }) });
  });
  document.getElementById('searchForm').addEventListener('submit', (e) => {
    e.preventDefault();
    state.q = document.getElementById('q').value.trim();
    isFeed() ? renderFeed() : (location.hash = '#/');
  });

  // ---------- Menu (navigation drawer) ----------
  const drawer = document.getElementById('drawer');
  document.getElementById('menuBtn').addEventListener('click', () => drawer.showModal());
  drawer.addEventListener('click', (e) => { if (e.target === drawer || e.target.closest('a,[data-close]')) drawer.close(); });

  // ---------- Thema ----------
  function applyTheme() {
    const t = localGet('theme') || 'auto';
    const root = document.documentElement;
    if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
    // kleur van de statusbalk/titelbalk meenemen
    const light = document.getElementById('tcLight'), dark = document.getElementById('tcDark');
    if (light && dark) {
      light.media = t === 'auto' ? '(prefers-color-scheme: light)' : (t === 'light' ? 'all' : 'not all');
      dark.media = t === 'auto' ? '(prefers-color-scheme: dark)' : (t === 'dark' ? 'all' : 'not all');
    }
  }

  // ---------- Tekstgrootte ----------
  function applyFontSize() {
    const map = { s: '13px', m: '14.4px', l: '16px', xl: '17.6px' };
    document.documentElement.style.fontSize = map[localGet('fs') || 'm'] || map.m;
  }

  // Elke 2 minuten verversen als de feed open staat
  setInterval(() => { if (isFeed() && document.visibilityState === 'visible') renderFeed().catch(() => {}); }, 120000);

  // ---------- PWA ----------
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  let deferred;
  const btn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; btn.hidden = false; });
  btn.addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; btn.hidden = true; });

  applyFontSize();
  applyTheme();
  route();
})();

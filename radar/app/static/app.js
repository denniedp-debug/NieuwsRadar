(() => {
  const app = document.getElementById('app');
  const TABS = [['all', 'Alles'], ['ok', 'Bevestigd'], ['it', 'IT-security'], ['il', 'Israël'], ['nl', 'Nederland'], ['kerk', 'Kerk'], ['tech', 'Tech'], ['world', 'Wereld']];
  const state = { tab: localGet('tab') || 'all', q: '', limit: 30 };
  // eigen id per apparaat: zo heeft ieder toestel een eigen 'gelezen'-lijst
  let DEVICE = localGet('device') || (() => {
    const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2);
    localSet('device', id); return id;
  })();

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
    const r = await fetch(path, { credentials: 'same-origin', ...opts });
    if (r.status === 401 && !path.startsWith('/api/admin')) { renderPair(); throw new Error('niet gekoppeld'); }
    if (!r.ok) {
      let msg = r.status;
      try { msg = (await r.json()).detail || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  // ---------- Koppelen ----------
  function renderPair(msg) {
    const guess = /iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad'
      : /Android/.test(navigator.userAgent) ? 'Android-telefoon' : /Windows/.test(navigator.userAgent) ? 'Windows-pc' : /Mac/.test(navigator.userAgent) ? 'Mac' : 'Toestel';
    app.innerHTML = page('Toestel koppelen', `
      <div class="panel">
        <p>Dit toestel is nog niet gekoppeld. Vraag een koppelcode aan de beheerder (te maken op <b>/admin</b>) en vul die hieronder in.</p>
        <form id="pairForm" class="pair-form">
          <label for="pairCode">Koppelcode</label>
          <input id="pairCode" inputmode="numeric" autocomplete="one-time-code" maxlength="7" placeholder="123456" required>
          <label for="pairName">Naam van dit toestel</label>
          <input id="pairName" maxlength="60" value="${esc(guess)}">
          <button class="tonal" type="submit">Koppelen</button>
          ${msg ? `<p class="error" role="alert">${esc(msg)}</p>` : ''}
        </form>
      </div>`);
    document.getElementById('pairForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: document.getElementById('pairCode').value, name: document.getElementById('pairName').value, legacyId: DEVICE }) });
        await boot();
      } catch (err) { renderPair(err.message === 'niet gekoppeld' ? 'Code onbekend of verlopen.' : err.message); }
    });
  }

  async function boot() {
    try {
      const me = await api('/api/me');
      if (!me.paired) return renderPair();
      if (me.device) { DEVICE = me.device.id; localSet('device', DEVICE); }
    } catch { /* offline: met cache verder */ }
    loadWeather();
    route();
  }

  // ---------- Feed ----------
  async function renderFeed() {
    const items = await api(`/api/clusters?cat=${encodeURIComponent(state.tab)}&q=${encodeURIComponent(state.q)}&limit=${state.limit}&device=${encodeURIComponent(DEVICE)}&view=feed`);
    const crit = items.find((c) => c.critical && Date.now() - new Date(c.updatedAt) < 864e5);
    const snack = crit && !crit.read
      ? `<div class="snack" role="status"><div class="t"><b>Kritiek: ${esc(crit.title)}</b><span>Bevestigd door ${crit.independent} bronnen · ${esc(ago(crit.updatedAt))}</span></div>
         <a href="#/c/${crit.id}">Openen</a><button data-read="${crit.id}" aria-label="Gelezen, melding sluiten">✕</button></div>` : '';
    const chips = TABS.map(([id, label]) =>
      `<button class="chip" data-tab="${id}" aria-pressed="${state.tab === id}">${state.tab === id ? check : ''}${label}</button>`).join('');
    const compact = (localGet('view') || 'compact') === 'compact';
    const eye = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-10-8-10-8a18 18 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 10 8 10 8a18 18 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2M2 2l20 20"/></svg>';
    const tick = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/></svg>';
    const hideBtn = (c) => `<div class="card-actions">
      <button class="hide-btn" data-read="${c.id}" aria-label="Archiveren: ${esc(c.title)}" title="Archiveren (gelezen)">${tick}</button>
      <button class="hide-btn" data-hide="${c.id}" aria-label="Niet interessant: ${esc(c.title)}" title="Niet interessant">${eye}</button></div>`;
    const metaLine = (c) => `${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}${c.originalTitle ? ' · vertaald' : ''}`;
    const cards = items.map((c, i) => compact ? `
      <article class="card-wrap row" data-card="${c.id}">
        <a class="row-card" href="#/c/${c.id}">
          <div class="rc-body">
            <div class="rc-lead">${esc(c.lead)}</div>
            <div class="rc-title">${esc(c.title)}</div>
            <div class="meta">${badge(c)}<span>${metaLine(c)}</span></div>
          </div>
          ${hero(c, 'rc-thumb')}</div>
        </a>
        ${hideBtn(c)}
      </article>` : `
      <article class="card-wrap" data-card="${c.id}">
      ${hideBtn(c)}
      <a class="card" href="#/c/${c.id}">
        ${hero(c, 'hero' + (i === 0 ? ' big' : ''))}
          <span class="lead"><span class="dot">${esc((c.lead || '?')[0])}</span>${esc(c.lead)}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${esc(c.title)}</div>
          ${c.teaser ? `<div class="teaser">${esc(c.teaser)}</div>` : ''}
          <div class="meta">${badge(c)}<span>${metaLine(c)}</span></div>
        </div>
      </a></article>`).join('');
    app.innerHTML = `
      <section class="feed single">
        <div id="undo"></div>
        ${snack}
        <nav class="chips" aria-label="Rubriek">${chips}</nav>
        <div class="section-row"><h2 class="section-h">${state.q ? 'Zoekresultaten voor “' + esc(state.q) + '”' : 'Voor jou · ' + new Date().toLocaleDateString('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
          ${items.length && !state.q ? `<button class="text-btn" data-readall="${items.map((c) => c.id).join(',')}">Alles gelezen</button>` : ''}</div>
        ${cards || (state.q ? '<div class="empty">Niets gevonden.</div>' : '<div class="empty">Je bent bij! Gelezen verhalen staan in <a href="#/archief">Archief</a>.</div>')}
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

  function markRead(ids, read = true) {
    return api('/api/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ device: DEVICE, ids: ids.map(Number), read }) });
  }

  function undoBar(text, attr, value) {
    const u = document.getElementById('undo');
    if (u) u.innerHTML = `<div class="snack" role="status"><div class="t"><b>${text}</b></div><button ${attr}="${value}">Ongedaan maken</button></div>`;
  }

  async function renderArchief() {
    const items = await api(`/api/clusters?view=archive&device=${encodeURIComponent(DEVICE)}&limit=100`);
    app.innerHTML = page('Archief', `
      <p class="muted" style="margin:-6px 0 4px">Wat je op dit apparaat hebt gelezen of gearchiveerd. Na ${30} dagen wordt het opgeruimd.</p>
      ${items.length ? '<div class="panel"><ul class="srcs">' + items.map((c) => `<li><span style="display:flex;align-items:center;gap:12px;min-height:56px">
        <a href="#/c/${c.id}" style="flex:1;min-width:0;color:var(--on);text-decoration:none"><b style="font-weight:500">${esc(c.title)}</b>
          <small style="display:block;color:var(--on-var)">${esc(c.categoryLabel)} · ${esc(ago(c.updatedAt))}</small></a>
        <button class="chip" data-unread="${c.id}">Terugzetten</button></span></li>`).join('') + '</ul></div>'
      : '<div class="panel"><p>Nog niets gelezen op dit apparaat.</p></div>'}`);
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
      <div class="panel"><h3>Kaarten</h3><p>Compact toont meer verhalen tegelijk.</p>
        <div class="seg two" role="radiogroup" aria-label="Kaarten">${[['compact', 'Compact'], ['large', 'Groot']].map(([k, l]) =>
          `<label class="seg-item"><input type="radio" name="view" value="${k}" ${(localGet('view') || 'compact') === k ? 'checked' : ''}><span>${l}</span></label>`).join('')}</div>
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
        + row('morning', 'Ochtendoverzicht', 'Elke ochtend de best bevestigde verhalen van de nacht', p.morning)
        + r.watchers.map((w) => row('watch:' + w, w, 'Paginawachter', p.watchers === 'all' || p.watchers.includes(w))).join('');
    }
    el.innerHTML = h + (sub
      ? `${prefsHtml}
         <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px"><button class="tonal" id="pushTest">Testmelding</button>
         <button class="chip" id="morningTest">Ochtendoverzicht nu</button>
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
    const prefs = { news: val('news'), security: val('security'), morning: val('morning'),
      watchers: w.every((b) => b.checked) ? 'all' : w.filter((b) => b.checked).map((b) => b.dataset.pref.slice(6)) };
    await api('/api/push/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, prefs }) });
  }

  // ---------- Detail ----------
  async function renderDetail(id) {
    const c = await api('/api/clusters/' + encodeURIComponent(id));
    markRead([c.id], true).catch(() => {});
    const facts = (c.facts || []).map((f) => `<li><span class="check">${check}</span><span>${esc(f.text)} <small style="color:var(--on-var)">(${esc((f.by || []).join(', '))})</small></span></li>`).join('');
    const disputed = (c.disputed || []).map((d) => `<li>${esc(d)}</li>`).join('');
    const srcs = c.sources.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">
      <span class="ini">${esc((s.feed_title || '?')[0])}</span>
      <span style="flex:1;min-width:0"><b style="font-weight:500">${esc(s.feed_title)}</b><small>${esc(s.origin === s.site ? 'eigen redactie' : 'herkomst: ' + s.origin)} · ${esc(ago(s.published_at))}${s.lowTrust ? ' · telt niet mee voor bevestiging' : ''}</small><small>${esc(s.title)}</small></span></a></li>`).join('');
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
            ${c.summary ? `<p class="lede">${esc(c.summary)}</p>` : ''}
            <div class="box">
              <div class="art-head"><h2>Artikel</h2>
                ${c.sources.length > 1 ? `<div class="chips small" role="tablist" aria-label="Bron">${c.sources.map((s, i) =>
                  `<button class="chip" role="tab" data-src="${s.id}" aria-pressed="${i === 0}">${esc(s.feed_title)}</button>`).join('')}</div>` : ''}
              </div>
              <div id="artText" class="article-text"><p class="muted">Tekst laden…</p></div>
              <p id="artNote" class="muted"></p>
            </div>
            ${facts ? `<div class="box"><h2>Wat de bronnen bevestigen</h2><ul class="facts">${facts}</ul></div>` : ''}
            ${disputed ? `<div class="box"><h2>Waar de bronnen verschillen</h2><ul>${disputed}</ul></div>` : ''}
            ${c.pushReason ? `<div class="why">Waarom je een melding kreeg: ${esc(c.pushReason)}.</div>` : ''}
          </article>
          <aside class="side"><div class="panel"><h2>Bronnen (${c.sources.length})</h2><ul class="srcs">${srcs}</ul></div></aside>
        </div>
      </div>`;
    window.scrollTo(0, 0);
    if (c.sources.length) loadArticle(c.sources[0].id);
  }

  async function loadArticle(eid) {
    const box = document.getElementById('artText'), note = document.getElementById('artNote');
    if (!box) return;
    document.querySelectorAll('[data-src]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === String(eid))));
    box.innerHTML = '<p class="muted">Volledige tekst ophalen…</p>'; note.innerHTML = '';
    try {
      const r = await api(`/api/entries/${eid}/text?full=true`);
      const paras = (r.text || '').split(/\n\s*\n/).filter(Boolean);
      box.innerHTML = paras.length ? paras.map((p) => `<p>${esc(p)}</p>`).join('') : '<p class="muted">Geen tekst beschikbaar.</p>';
      const link = safeUrl(r.url) ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">Lees bij de bron</a>` : '';
      note.innerHTML = r.full ? link : `Deze bron geeft alleen een inleiding. ${link}`;
    } catch { box.innerHTML = '<p class="muted">Tekst ophalen mislukt.</p>'; }
  }

  // ---------- Router & events ----------
  const PAGES = { '#/archief': renderArchief, '#/filters': renderFilters, '#/meldingen': renderMeldingen, '#/wachters': renderWachters, '#/weergave': renderWeergave, '#/uitleg': renderUitleg };
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
    const r = e.target.closest('[data-read],[data-readall],[data-unread],[data-undoread]');
    if (r) {
      e.preventDefault();
      if (r.dataset.read) {
        const id = r.dataset.read;
        markRead([id]).then(() => {
          document.querySelector(`[data-card="${id}"]`)?.remove();
          r.closest('.snack')?.remove();
          undoBar('Gearchiveerd', 'data-undoread', id);
        }).catch(() => {});
      } else if (r.dataset.readall) {
        const ids = r.dataset.readall.split(',');
        markRead(ids).then(renderFeed).then(() => undoBar(`${ids.length} verhalen gearchiveerd`, 'data-undoread', ids.join(','))).catch(() => {});
      } else if (r.dataset.undoread) markRead(r.dataset.undoread.split(','), false).then(renderFeed);
      else if (r.dataset.unread) markRead([r.dataset.unread], false).then(renderArchief);
      return;
    }
    const h = e.target.closest('[data-hide],[data-undo],[data-detail-hide],[data-unhide],[data-forget]');
    if (h) {
      e.preventDefault();
      if (h.dataset.hide) {
        const id = h.dataset.hide;
        setHidden(id, true).then(() => {
          document.querySelector(`[data-card="${id}"]`)?.remove();
          undoBar('Verborgen · vergelijkbare verhalen voortaan ook', 'data-undo', id);
        }).catch(() => {});
      } else if (h.dataset.undo) setHidden(h.dataset.undo, false).then(renderFeed);
      else if (h.dataset.detailHide) setHidden(h.dataset.detailHide, h.dataset.state !== 'hidden').then(() => (h.dataset.state === 'hidden' ? renderDetail(h.dataset.detailHide) : (location.hash = '#/')));
      else if (h.dataset.unhide) setHidden(h.dataset.unhide, false).then(renderFilters);
      else if (h.dataset.forget) api('/api/filters/learned/' + h.dataset.forget, { method: 'DELETE' }).then(renderFilters);
      return;
    }
    const src = e.target.closest('[data-src]');
    if (src) { loadArticle(src.dataset.src); return; }
    const t = e.target.closest('[data-tab],#more,#testWatch,#pushOn,#pushOff,#pushTest,#morningTest');
    if (!t) return;
    if (t.id === 'morningTest') {
      t.disabled = true;
      api('/api/push/morning-test', { method: 'POST' }).then((r) => updatePushPanel(r.stories ? `Ochtendoverzicht met ${r.stories} verhalen verstuurd.` : 'Nog geen bevestigde verhalen van de afgelopen 12 uur.')).catch((err) => updatePushPanel('Mislukt: ' + err.message));
      return;
    }
    if (t.id === 'pushOn' || t.id === 'pushOff' || t.id === 'pushTest') {
      t.disabled = true;
      ({ pushOn, pushOff, pushTest })[t.id]().catch((err) => updatePushPanel('Mislukt: ' + err.message));
      return;
    }
    if (t.id === 'testWatch') { t.disabled = true; t.textContent = 'Verstuurd'; api('/api/watchers/test', { method: 'POST' }).then(renderWachters).catch(() => {}); return; }
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.limit = 30; localSet('tab', state.tab); renderFeed(); }
    else if (t.id === 'more') { state.limit += 30; renderFeed(); }
  });
  app.addEventListener('change', async (e) => {
    if (e.target.name === 'fs') { localSet('fs', e.target.value); applyFontSize(); return; }
    if (e.target.name === 'theme') { localSet('theme', e.target.value); applyTheme(); return; }
    if (e.target.name === 'view') { localSet('view', e.target.value); return; }
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

  // ---------- Weer ----------
  const WMO = (code, day) => {
    const c = Number(code);
    if (c === 0) return [day ? 'sun' : 'moon', 'onbewolkt'];
    if (c <= 2) return [day ? 'partly' : 'moon', 'licht bewolkt'];
    if (c === 3) return ['cloud', 'bewolkt'];
    if (c === 45 || c === 48) return ['fog', 'mist'];
    if (c >= 51 && c <= 67) return ['rain', c <= 57 ? 'motregen' : 'regen'];
    if (c >= 71 && c <= 77) return ['snow', 'sneeuw'];
    if (c >= 80 && c <= 82) return ['rain', 'buien'];
    if (c >= 85 && c <= 86) return ['snow', 'sneeuwbuien'];
    if (c >= 95) return ['storm', 'onweer'];
    return ['cloud', 'bewolkt'];
  };
  const WICON = {
    sun: '<circle cx="12" cy="12" r="4" fill="#F5B400" stroke="#F5B400"/><path stroke="#F5B400" d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path fill="#9AA8C7" stroke="#9AA8C7" d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    partly: '<circle cx="8" cy="8" r="3.2" fill="#F5B400" stroke="#F5B400"/><path stroke="#F5B400" d="M8 1.5v1.5M2.5 8H1M3.4 3.4l1 1M12.6 3.4l-1 1"/><path fill="#C9D1DD" stroke="#9AA3B2" d="M17.5 19H8a4 4 0 1 1 .9-7.9A5 5 0 0 1 18.5 12a3.5 3.5 0 0 1-1 7z"/>',
    cloud: '<path fill="#C9D1DD" stroke="#9AA3B2" d="M17.5 19H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.4 11a4 4 0 0 1-1.9 8z"/>',
    rain: '<path fill="#C9D1DD" stroke="#9AA3B2" d="M17.5 15H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.4 7a4 4 0 0 1-1.9 8z"/><path stroke="#3B82F6" d="M8 18l-1 3M12 18l-1 3M16 18l-1 3"/>',
    snow: '<path fill="#C9D1DD" stroke="#9AA3B2" d="M17.5 15H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.4 7a4 4 0 0 1-1.9 8z"/><path stroke="#7DB7E8" d="M8 18v3M6.5 19.5h3M15 18v3M13.5 19.5h3"/>',
    fog: '<path stroke="#9AA3B2" d="M3 9h18M5 13h14M3 17h18"/>',
    storm: '<path fill="#9AA3B2" stroke="#7A8394" d="M17.5 14H8a5 5 0 1 1 1.2-9.9A6 6 0 0 1 19.4 6a4 4 0 0 1-1.9 8z"/><path fill="#F5B400" stroke="#F5B400" d="M12 14l-2 4h3l-1.5 4 4-6h-3l1.5-2z"/>',
  };
  async function loadWeather() {
    const el = document.getElementById('weather');
    if (!el) return;
    try {
      const w = await api('/api/weather');
      const [icon, desc] = WMO(w.code, w.isDay);
      const t = Math.round(w.temp);
      el.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WICON[icon]}</svg>
        <span class="w-temp">${t}°</span><span class="w-sub">${esc(w.place)}${w.max != null ? ` · ${Math.round(w.min)}°/${Math.round(w.max)}°` : ''}${w.rainChance ? ` · ${w.rainChance}% regen` : ''}</span>`;
      el.setAttribute('aria-label', `${w.place}: ${t} graden, ${desc}`);
      el.title = `${w.place}: ${t}°, ${desc}`;
      el.hidden = false;
    } catch { el.hidden = true; }
  }

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
    const map = { s: '12px', m: '13px', l: '14.4px', xl: '16px' };
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
  setInterval(loadWeather, 15 * 60000);
  boot();
})();

(() => {
  const el = document.getElementById('adm');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (iso) => iso ? new Date(iso).toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–';
  const device = (ua) => /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  let timer;

  async function api(path, opts = {}) {
    const r = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, ...opts });
    let data = {};
    try { data = await r.json(); } catch {}
    if (!r.ok) { const e = new Error(data.detail || r.status); e.status = r.status; throw e; }
    return data;
  }

  function renderLogin(msg, disabled) {
    document.getElementById('logout').hidden = true;
    el.innerHTML = `<h1 class="page-h">Beheer</h1>
      <div class="panel">
        ${disabled ? '<p class="error">Toegangsbeveiliging staat uit. Zet <b>ADMIN_PASSWORD</b> in je stack en rol opnieuw uit. Tot die tijd is de app voor iedereen open.</p>' : ''}
        <form id="login" class="pair-form">
          <label for="pw">Beheerderswachtwoord</label>
          <input id="pw" type="password" autocomplete="current-password" required>
          <button class="tonal" type="submit">Inloggen</button>
          ${msg ? `<p class="error" role="alert">${esc(msg)}</p>` : ''}
        </form>
      </div>`;
    document.getElementById('login').addEventListener('submit', async (e) => {
      e.preventDefault();
      try { await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: document.getElementById('pw').value }) }); render(); }
      catch (err) { renderLogin(err.message, disabled); }
    });
    document.getElementById('pw').focus();
  }

  async function render(codeBox = '') {
    let devices;
    try { devices = await api('/api/admin/devices'); }
    catch (err) { if (err.status === 401) { const me = await api('/api/admin/me'); return renderLogin('', !me.enabled); } throw err; }
    document.getElementById('logout').hidden = false;
    el.innerHTML = `<h1 class="page-h">Beheer</h1>
      <div class="panel">
        <h3>Nieuw toestel koppelen</h3>
        <p>Maak een code aan en vul die in op het nieuwe toestel (open daar gewoon de app). De code werkt één keer en verloopt na 15 minuten.</p>
        <form id="codeForm" class="pair-form">
          <label for="devName">Naam (optioneel)</label>
          <input id="devName" maxlength="60" placeholder="Bijv. Telefoon Petra">
          <button class="tonal" type="submit">Code maken</button>
        </form>
        <div id="codeBox">${codeBox}</div>
      </div>
      <div class="panel">
        <h3>Gekoppelde toestellen (${devices.length})</h3>
        ${devices.length ? `<ul class="srcs">${devices.map((d) => `<li><span style="display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;min-height:60px;padding:6px 0">
          <span style="flex:1 1 200px;min-width:0"><b style="font-weight:600">${esc(d.name)}</b>
            <small>${esc(device(d.user_agent))}${device(d.user_agent) ? ' · ' : ''}laatst gezien ${esc(when(d.last_seen))} · gekoppeld ${esc(when(d.created_at))}${d.push ? ' · meldingen aan' : ''}</small></span>
          <button class="chip" data-rename="${esc(d.id)}" data-name="${esc(d.name)}">Hernoemen</button>
          <button class="chip" data-revoke="${esc(d.id)}" data-name="${esc(d.name)}">Ontkoppelen</button></span></li>`).join('')}</ul>`
          : '<p>Nog geen toestellen. Maak hierboven een code en koppel je eerste toestel.</p>'}
      </div>`;
    document.getElementById('codeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const r = await api('/api/admin/codes', { method: 'POST', body: JSON.stringify({ name: document.getElementById('devName').value }) });
      const until = Date.now() + r.minutes * 60000;
      const box = (left) => `<div class="code-show" role="status"><span class="code">${r.code.slice(0, 3)} ${r.code.slice(3)}</span>
        <small>${left > 0 ? `nog ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} geldig` : 'verlopen'}</small></div>`;
      document.getElementById('codeBox').innerHTML = box(r.minutes * 60);
      clearInterval(timer);
      timer = setInterval(() => {
        const left = Math.max(0, Math.round((until - Date.now()) / 1000));
        const b = document.getElementById('codeBox');
        if (b) b.innerHTML = box(left);
        if (!left) clearInterval(timer);
      }, 1000);
    });
  }

  el.addEventListener('click', async (e) => {
    const rv = e.target.closest('[data-revoke]');
    if (rv) {
      if (!confirm(`${rv.dataset.name} ontkoppelen? Dit toestel moet daarna opnieuw een code invullen.`)) return;
      await api('/api/admin/devices/' + encodeURIComponent(rv.dataset.revoke), { method: 'DELETE' });
      return render(document.getElementById('codeBox')?.innerHTML || '');
    }
    const rn = e.target.closest('[data-rename]');
    if (rn) {
      const name = prompt('Nieuwe naam', rn.dataset.name);
      if (!name) return;
      await api('/api/admin/devices/' + encodeURIComponent(rn.dataset.rename), { method: 'PATCH', body: JSON.stringify({ name }) });
      render(document.getElementById('codeBox')?.innerHTML || '');
    }
  });
  document.getElementById('logout').addEventListener('click', async () => { await api('/api/admin/logout', { method: 'POST' }); renderLogin(); });

  render().catch((err) => { el.innerHTML = `<p class="error">Fout: ${esc(err.message)}</p>`; });
})();

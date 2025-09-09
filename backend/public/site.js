// Basit etkileşimler: yıl ve plan butonları
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Util
const $ = (s) => document.querySelector(s);
const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : location.origin;

function setToken(token){
  if (token) localStorage.setItem('hk_token', token);
}
function getToken(){ return localStorage.getItem('hk_token'); }
function clearToken(){ localStorage.removeItem('hk_token'); }
function setPostLoginRedirect(url){ if (url) localStorage.setItem('hk_post_login_redirect', url); }
function consumePostLoginRedirect(){ const k='hk_post_login_redirect'; const v=localStorage.getItem(k); if (v) localStorage.removeItem(k); return v; }

function updateHeader(){
  const token = getToken();
  const userEmailEl = $('#userEmail');
  const userPlanEl = $('#userPlan');
  const btnLogin = $('#btnLogin');
  const btnLogout = $('#btnLogout');
  const btnAccount = $('#btnAccount');
  const verifyDot = $('#verifyDot');
  if (token){
    // /me ile temel bilgileri doldur
    fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(me => {
        if (me && me.email){ userEmailEl.textContent = me.email; userEmailEl.style.display = 'inline-block'; }
        if (me && me.plan){ userPlanEl.textContent = `Plan: ${me.plan}`; userPlanEl.style.display = 'inline-block'; }
        if (verifyDot){ verifyDot.style.display = me && me.emailVerified ? 'none' : 'inline-block'; }
      }).catch(() => {});
    if (btnLogin) btnLogin.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'inline-flex';
    if (btnAccount) btnAccount.style.display = 'inline-flex';
  } else {
    if (userEmailEl){ userEmailEl.style.display = 'none'; userEmailEl.textContent = ''; }
    if (userPlanEl){ userPlanEl.style.display = 'none'; userPlanEl.textContent = 'Plan: free'; }
    if (btnLogin) btnLogin.style.display = 'inline-flex';
    if (btnLogout) btnLogout.style.display = 'none';
    if (btnAccount) btnAccount.style.display = 'none';
    if (verifyDot) verifyDot.style.display = 'none';
  }
}

// Abonelik plan butonları (placeholder)
function onPlanClick(e){
  const plan = e.currentTarget.getAttribute('data-plan');
  if (!plan) return;
  const token = getToken();
  if (!token){ openAuth(); return; }
  // Call backend to create PayTR checkout session
  fetch(`${backendBase}/api/paytr/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan })
  })
  .then(r => r.json())
  .then(j => {
    if (j?.iframe_url){ window.location.href = j.iframe_url; return; }
    alert(j?.error || 'Ödeme başlatılamadı');
  })
  .catch(() => alert('Bağlantı hatası'));
}
document.querySelectorAll('[data-plan]')
  .forEach(btn => btn.addEventListener('click', onPlanClick));

// Auth Modal
const authModal = $('#authModal');
const btnLogin = $('#btnLogin');
const btnLogout = $('#btnLogout');
const authClose = $('#authClose');
const tabLogin = $('#tabLogin');
const tabRegister = $('#tabRegister');
const formLogin = $('#formLogin');
const formRegister = $('#formRegister');
const formForgot = $('#formForgot');
const authMsg = $('#authMsg');

function openAuth(){ if (authModal) authModal.style.display = 'block'; }
function closeAuth(){ if (authModal) authModal.style.display = 'none'; }
function positionTabIndicator(){
  try{
    const ind = document.getElementById('tabIndicator');
    const active = document.querySelector('#authModal .btn-tab.active');
    const bar = document.querySelector('#authModal .tabbar');
    if (!ind || !active || !bar) return;
    const br = bar.getBoundingClientRect();
    const ar = active.getBoundingClientRect();
    const left = Math.max(0, ar.left - br.left);
    ind.style.width = `${ar.width}px`;
    ind.style.transform = `translateX(${left}px)`;
  } catch {}
}
function showLogin(){
  if (formLogin && formRegister){
    formLogin.style.display = 'block'; formRegister.style.display = 'none';
    if (tabLogin) tabLogin.classList.add('active');
    if (tabRegister) tabRegister.classList.remove('active');
    if (authMsg){ authMsg.textContent = ''; authMsg.style.display = 'none'; authMsg.className = 'alert alert-info'; }
    positionTabIndicator();
  }
}
function showRegister(){
  if (formLogin && formRegister){
    formLogin.style.display = 'none'; formRegister.style.display = 'block';
    if (tabRegister) tabRegister.classList.add('active');
    if (tabLogin) tabLogin.classList.remove('active');
    if (authMsg){ authMsg.textContent = ''; authMsg.style.display = 'none'; authMsg.className = 'alert alert-info'; }
    positionTabIndicator();
  }
}

if (btnLogin) btnLogin.addEventListener('click', () => { openAuth(); showLogin(); });
if (btnLogout) btnLogout.addEventListener('click', () => { clearToken(); updateHeader(); alert('Çıkış yapıldı.'); });
if (authClose) authClose.addEventListener('click', closeAuth);
if (tabLogin) tabLogin.addEventListener('click', showLogin);
if (tabRegister) tabRegister.addEventListener('click', showRegister);

// İlk açılışta tab indicator'ı konumlandır
setTimeout(positionTabIndicator, 0);
window.addEventListener('resize', positionTabIndicator);

// Forgot flow switches
const linkForgot = $('#linkForgot');
const linkBackToLogin = $('#linkBackToLogin');
if (linkForgot){
  linkForgot.addEventListener('click', () => {
    if (formLogin && formForgot){ formLogin.style.display='none'; formRegister.style.display='none'; formForgot.style.display='block'; authMsg.textContent=''; }
  });
}
if (linkBackToLogin){
  linkBackToLogin.addEventListener('click', () => {
    if (formLogin && formForgot){ formForgot.style.display='none'; formLogin.style.display='block'; authMsg.textContent=''; }
  });
}

if (formForgot){
  formForgot.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#forgotEmail').value.trim();
    authMsg.textContent = 'Sıfırlama linki hazırlanıyor...';
    try {
      const r = await fetch(`${backendBase}/auth/forgot`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const j = await r.json();
      if (!r.ok){ authMsg.textContent = j?.error || 'Hata'; return; }
      authMsg.textContent = 'Eğer bu e‑posta kayıtlıysa sıfırlama linki üretildi (konsola yazıldı).';
    } catch (e){ authMsg.textContent = 'Bağlantı hatası'; }
  });
}

// Account modal (simple reuse of auth modal area)
let accountOpen = false;
function openAccount(){
  accountOpen = true;
  if (authModal) authModal.style.display = 'block';
  // render a mini preferences form in msg area
  const token = getToken();
  if (!token){ openAuth(); accountOpen=false; return; }
  const html = `
    <div class="stack" style="gap:10px;">
      <div class="row" style="justify-content:space-between; align-items:center;">
        <strong>Hesabım</strong>
        <small id="accPlan" class="pill">Plan: ...</small>
      </div>
      <div class="row" style="justify-content:space-between; align-items:center; gap:8px;">
        <div class="subtle" id="accVerifyMsg">E‑posta doğrulama durumu alınıyor...</div>
        <button id="accVerifyBtn" class="btn btn-secondary" type="button" style="display:none;">E‑posta doğrula</button>
      </div>
      <div class="row" style="gap:8px; flex-wrap:wrap;">
        <small class="pill" id="accUsageDaily">Günlük: - dk</small>
        <small class="pill" id="accUsageMonthly">Aylık: - dk</small>
      </div>
      <div class="row" style="gap:8px;">
        <button id="accUpgrade" class="btn btn-primary" type="button" style="display:none;">Starter’a Geç</button>
      </div>
      <label class="subtle">Tercihler</label>
      <div class="row" style="gap:8px; flex-wrap:wrap;">
        <input id="accLang" placeholder="Dil (tr/en...)" style="flex:1; min-width:180px; padding:10px 12px; border-radius:10px; background:#0b1022; border:1px solid #1b2442; color:var(--text);"/>
        <input id="accVoice" placeholder="Ses (alloy/aria...)" style="flex:1; min-width:180px; padding:10px 12px; border-radius:10px; background:#0b1022; border:1px solid #1b2442; color:var(--text);"/>
        <select id="accCorrection" style="flex:1; min-width:180px; padding:10px 12px; border-radius:10px; background:#0b1022; border:1px solid #1b2442; color:var(--text);">
          <option value="gentle" selected>Yumuşak</option>
          <option value="strict">Katı</option>
          <option value="off">Kapalı</option>
        </select>
        <button id="accSave" class="btn btn-primary" type="button">Kaydet</button>
      </div>
      <div id="accMsg" class="subtle"></div>
    </div>`;
  if (formLogin && formRegister){ formLogin.style.display='none'; formRegister.style.display='none'; }
  if (authMsg){ authMsg.innerHTML = html; }
  fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } })
    .then(r => r.ok ? r.json() : null)
    .then(me => {
      if (!me) return;
      $('#accPlan').textContent = `Plan: ${me.plan || 'free'}`;
      const lang = $('#accLang'); const voice = $('#accVoice'); const corr = $('#accCorrection');
      if (lang) lang.value = me.preferredLanguage || '';
      if (voice) voice.value = me.preferredVoice || '';
      if (corr) corr.value = me.preferredCorrectionMode || 'gentle';
      const verifyMsg = $('#accVerifyMsg');
      const verifyBtn = $('#accVerifyBtn');
      if (me.emailVerified){
        if (verifyMsg) verifyMsg.textContent = 'E‑posta doğrulandı ✅';
      } else {
        if (verifyMsg) verifyMsg.textContent = 'E‑posta doğrulanmamış ❗';
        if (verifyBtn) verifyBtn.style.display = 'inline-flex';
      }
      // Upgrade button if plan is free
      const upBtn = $('#accUpgrade');
      if (upBtn){
        if ((me.plan || 'free') === 'free'){
          upBtn.style.display = 'inline-flex';
        } else {
          upBtn.style.display = 'none';
        }
      }
      // Fetch usage summary
      fetch(`${backendBase}/usage`, { headers: { Authorization: `Bearer ${token}` } })
        .then(u => u.ok ? u.json() : null)
        .then(sum => {
          if (!sum) return;
          const d = $('#accUsageDaily'); const m = $('#accUsageMonthly');
          if (d) d.textContent = `Günlük: ${(sum.usedDaily||0).toFixed(1)} / ${sum.limits?.daily ?? '-'} dk`;
          if (m) m.textContent = `Aylık: ${(sum.usedMonthly||0).toFixed(1)} / ${sum.limits?.monthly ?? '-'} dk`;
        })
        .catch(()=>{});
    });
  setTimeout(() => {
    const saveBtn = $('#accSave');
    const verifyBtn = $('#accVerifyBtn');
    const upBtn = $('#accUpgrade');
    if (saveBtn){
      saveBtn.addEventListener('click', async () => {
        const lang = $('#accLang')?.value?.trim();
        const voice = $('#accVoice')?.value?.trim();
        const preferredCorrectionMode = $('#accCorrection')?.value || 'gentle';
        const msg = $('#accMsg');
        msg.textContent = 'Kaydediliyor...';
        try{
          const r = await fetch(`${backendBase}/me/preferences`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ preferredLanguage: lang, preferredVoice: voice, preferredCorrectionMode }) });
          const j = await r.json();
          if (!r.ok){ msg.textContent = j?.error || 'Hata'; return; }
          msg.textContent = 'Kaydedildi.';
          updateHeader();
        }catch(e){ msg.textContent = 'Bağlantı hatası'; }
      });
    }
    if (verifyBtn){
      verifyBtn.addEventListener('click', async () => {
        const msg = $('#accMsg');
        msg.textContent = 'Doğrulama e‑postası gönderiliyor...';
        try{
          const r = await fetch(`${backendBase}/auth/verify/request`, { method:'POST', headers:{ Authorization: `Bearer ${getToken()}` } });
          const j = await r.json();
          if (!r.ok){ msg.textContent = j?.error || 'Hata'; return; }
          msg.textContent = 'Doğrulama e‑postası gönderildi. Lütfen e‑postanızı kontrol edin.';
        }catch(e){ msg.textContent = 'Bağlantı hatası'; }
      });
    }
    if (upBtn){
      upBtn.addEventListener('click', async () => {
        const msg = $('#accMsg');
        msg.textContent = 'Ödeme başlatılıyor...';
        try{
          const r = await fetch(`${backendBase}/api/paytr/checkout`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ plan: 'starter' }) });
          const j = await r.json();
          if (!r.ok){ msg.textContent = j?.error || 'Hata'; return; }
          if (j?.iframe_url){ window.location.href = j.iframe_url; return; }
          msg.textContent = 'Ödeme başlatılamadı';
        }catch(e){ msg.textContent = 'Bağlantı hatası'; }
      });
    }
  }, 50);
}
// Navigate to account page, but if /me fetch başarısızsa güvenli şekilde çıkış ve login'e yönlendir
async function navigateAccountSafe(){
  const token = getToken();
  if (!token){ setPostLoginRedirect('/account.html'); openAuth(); showLogin(); return; }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok){ throw new Error(`me ${r.status}`); }
    const me = await r.json();
    if (!me || !me.email){ throw new Error('invalid_me'); }
    window.location.href = '/account.html';
  } catch (e){
    // token bozuk/expire ya da ağ hatası: güvenli çıkış ve login modal
    clearToken();
    updateHeader();
    setPostLoginRedirect('/account.html');
    openAuth();
    showLogin();
  }
}
if (btnAccount) btnAccount.addEventListener('click', (ev) => { ev.preventDefault(); navigateAccountSafe(); });

if (formLogin){
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    authMsg.textContent = 'Giriş yapılıyor...';
    try {
      const r = await fetch(`${backendBase}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok){
        if (r.status === 403 && j?.error === 'email_not_verified'){
          authMsg.innerHTML = `E-posta doğrulanmamış. <button id="resendVerify" class="btn btn-text">Doğrulama e-postasını tekrar gönder</button>`;
          const btn = document.getElementById('resendVerify');
          if (btn){
            btn.addEventListener('click', async () => {
              authMsg.textContent = 'Gönderiliyor...';
              try{
                const rr = await fetch(`${backendBase}/auth/verify/request-by-email`, { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ email }) });
                await rr.json();
                authMsg.textContent = 'Doğrulama e-postası gönderildi (e-postanızı kontrol edin).';
              }catch(e){ authMsg.textContent = 'Bağlantı hatası'; }
            });
          }
          return;
        }
        authMsg.textContent = j?.error || 'Hata';
        return;
      }
      setToken(j.token); updateHeader();
      // post-login redirect if requested
      const dest = consumePostLoginRedirect();
      if (dest){ window.location.href = dest; return; }
      closeAuth();
    } catch (e){ authMsg.textContent = 'Bağlantı hatası'; }
  });
}

if (formRegister){
  formRegister.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#regEmail').value.trim();
    const password = $('#regPassword').value;
    authMsg.textContent = 'Kayıt oluşturuluyor...';
    try {
      const r = await fetch(`${backendBase}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok){ authMsg.textContent = j?.error || 'Hata'; return; }
      authMsg.textContent = 'Kayıt alındı. Lütfen e‑posta kutunuzu kontrol edip doğrulama yapın.';
      // Register sonrası giriş yaptırmıyoruz; doğrulama zorunlu
    } catch (e){ authMsg.textContent = 'Bağlantı hatası'; }
  });
}

// Hemen Başla CTA
const btnStart = document.getElementById('btnStart');
if (btnStart){
  btnStart.addEventListener('click', (ev) => {
    ev.preventDefault();
    const token = getToken();
    if (!token){ setPostLoginRedirect('/konus'); openAuth(); showLogin(); return; }
    window.location.href = '/konus';
  });
}

// Init UI
updateHeader();

// Intercept konus (realtime) links if not logged in
try{
  document.querySelectorAll('a[href="/konus"]').forEach(a => {
    a.addEventListener('click', (ev) => {
      const token = getToken();
      if (!token){ ev.preventDefault(); setPostLoginRedirect('/konus'); openAuth(); showLogin(); }
    });
  });
} catch {}

// Mobile menu controls
try{
  const btnMenu = document.getElementById('btnMenu');
  const mm = document.getElementById('mobileMenu');
  const mmLogin = document.getElementById('mmLogin');
  const mmAccount = document.getElementById('mmAccount');
  const mmStart = document.getElementById('mmStart');
  const token = getToken();
  if (btnMenu && mm){
    const open = () => { mm.style.display = 'block'; document.body.style.overflow = 'hidden'; };
    const close = () => { mm.style.display = 'none'; document.body.style.overflow = ''; };
    btnMenu.addEventListener('click', () => { mm.style.display === 'block' ? close() : open(); });
    // Tap on links closes menu
    mm.querySelectorAll('[data-mm-close]').forEach(el => el.addEventListener('click', close));
    // Escape closes
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // Auth buttons in mobile menu
    if (mmLogin){ mmLogin.addEventListener('click', () => { close(); openAuth(); showLogin(); }); }
    if (mmAccount){ mmAccount.addEventListener('click', async () => { close(); await navigateAccountSafe(); }); }
    if (mmStart){ mmStart.addEventListener('click', (ev) => { ev.preventDefault(); close(); const t = getToken(); if (!t){ setPostLoginRedirect('/realtime.html'); openAuth(); showLogin(); } else { window.location.href = '/realtime.html'; } }); }
    // Show correct auth buttons
    if (token){ if (mmLogin) mmLogin.style.display = 'none'; if (mmAccount) mmAccount.style.display = 'inline-flex'; }
  }
} catch {}

// If navigated with ?auth=1&redirect=...
try{
  const usp = new URLSearchParams(window.location.search);
  if (usp.get('auth') === '1'){
    const redirect = usp.get('redirect') || '/konus';
    setPostLoginRedirect(redirect);
    openAuth();
    showLogin();
  }
} catch {}

function setupCounters(){
try{
const els = document.querySelectorAll('.stat__value[data-counter]');
if (!('IntersectionObserver' in window)){
// Fallback: set values directly
els.forEach(el => el.textContent = String(Number(el.getAttribute('data-counter')||'0')));
return;
}
const started = new WeakSet();
const io = new IntersectionObserver((entries) => {
entries.forEach(entry => {
if (entry.isIntersecting){
const el = entry.target;
if (started.has(el)) return;
started.add(el);
const target = Number(el.getAttribute('data-counter')||'0');
const start = performance.now();
const dur = 900 + Math.random()*400;
function step(ts){
const t = Math.min(1, (ts - start)/dur);
el.textContent = Math.round(target * t).toString();
if (t < 1) requestAnimationFrame(step);
}
requestAnimationFrame(step);
io.unobserve(el);
}
});
}, { root: null, threshold: 0.25 });
els.forEach(el => io.observe(el));
} catch {}
}
setupCounters();

// Scroll Reveal: [data-reveal] ögelerine görünür olduğunda 'reveal-in' sınıfını ekle
(() => {
try {
const items = document.querySelectorAll('[data-reveal]');
if (!items || items.length === 0) return;
const io = new IntersectionObserver((entries, obs) => {
entries.forEach((entry) => {
if (entry.isIntersecting) {
entry.target.classList.add('reveal-in');
obs.unobserve(entry.target);
}
});
}, { root: null, rootMargin: '0px 0px -10% 0px', threshold: 0.1 });
items.forEach(el => io.observe(el));
} catch {}
})();

// Inline script bağımlılığını azaltmak için logo fallback'ını JS'e taşı
// index.html içindeki <img src="/logo.png"> için hata olursa svg/icon'a düş
window.addEventListener('DOMContentLoaded', () => {
  const logoImg = document.querySelector('header .brand img');
  if (!logoImg) return;
  logoImg.addEventListener('error', function onErr(){
    if (!this.dataset.fallback){
      this.dataset.fallback = 'svg';
      this.src = '/logo.svg';
    } else {
      this.src = '/logo-icon.svg';
    }
  }, { once: false });
});

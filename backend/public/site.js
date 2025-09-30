// Basit etkileşimler: yıl ve plan butonları
const yearEl = document.getElementById('year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Util
const $ = (s) => document.querySelector(s);
// Use configured backend base if provided, otherwise same origin
const backendBase = (window.__BACKEND_BASE__ && window.__BACKEND_BASE__.trim()) || window.location.origin;

// Global elements

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
  const verifyDot = $('#verifyDot');
  // Nav items
  const navFeatures = document.getElementById('navFeatures');
  const navPricing = document.getElementById('navPricing');
  const navDaily = document.getElementById('navDaily');
  const mmFeatures = document.getElementById('mmFeatures');
  const mmPricing = document.getElementById('mmPricing');
  const mmDaily = document.getElementById('mmDaily');
  if (token){
    // /me ile temel bilgileri doldur
    fetch(`${backendBase}/me`, {  // /me olarak değiştirildi
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}` 
      },
      credentials: 'include'
    })
    .then(r => {
      if (!r.ok) {
        console.error('Failed to fetch user data:', r.status);
        throw new Error('Failed to fetch user data');
      }
      return r.json();
    })
    .then(me => {
      if (me && me.email){ 
        userEmailEl.textContent = me.email; 
        userEmailEl.style.display = 'inline-block'; 
      }
      if (me && me.plan){ 
        userPlanEl.textContent = `Plan: ${me.plan}`; 
        userPlanEl.style.display = 'inline-block'; 
      }
      if (verifyDot){ 
        verifyDot.style.display = me && me.emailVerified ? 'none' : 'inline-block'; 
      }
    })
    .catch(error => {
      console.error('Error fetching user data:', error);
      // Kullanıcıya göstermek isteyebilirsiniz
    });
    if (btnLogin) btnLogin.style.display = 'none';
    if (btnLogout) btnLogout.style.display = 'inline-flex';
    const accountBtn = document.getElementById('btnAccount');
    if (accountBtn) accountBtn.style.display = 'inline-flex';
    // Hide marketing links when logged in
    if (navFeatures) navFeatures.style.display = 'none';
    if (navPricing) navPricing.style.display = 'none';
    if (mmFeatures) mmFeatures.style.display = 'none';
    if (mmPricing) mmPricing.style.display = 'none';
    // Show Daily when logged in
    if (navDaily) navDaily.style.display = '';
    if (mmDaily) mmDaily.style.display = '';
  } else {
    if (userEmailEl){ userEmailEl.style.display = 'none'; userEmailEl.textContent = ''; }
    if (userPlanEl){ userPlanEl.style.display = 'none'; userPlanEl.textContent = 'Plan: free'; }
    if (btnLogin) btnLogin.style.display = 'inline-flex';
    if (btnLogout) btnLogout.style.display = 'none';
    const accountBtn = document.getElementById('btnAccount');
    if (accountBtn) accountBtn.style.display = 'none';
    if (verifyDot) verifyDot.style.display = 'none';
    // Show marketing links, hide Daily when logged-out
    if (navFeatures) navFeatures.style.display = '';
    if (navPricing) navPricing.style.display = '';
    if (mmFeatures) mmFeatures.style.display = '';
    if (mmPricing) mmPricing.style.display = '';
    if (navDaily) navDaily.style.display = 'none';
    if (mmDaily) mmDaily.style.display = 'none';
  }
}

// Plan butonları - güncellenmiş fonksiyon
async function onPlanClick(e){
  console.log('🔥 [site.js] onPlanClick çağrıldı!');
  const plan = e.currentTarget.getAttribute('data-plan');
  console.log('📋 [site.js] Plan değeri:', plan);
  if (!plan) return;
  const token = getToken();
  console.log('🔐 [site.js] Token var mı:', !!token);
  if (!token){ openAuth(); return; }

  // Kullanıcının mevcut planını al
  let currentPlan = 'free';
  try {
    console.log('📡 [site.js] /me çağrısı yapılıyor...');
    const mr = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } });
    console.log('📡 [site.js] /me yanıtı:', mr.status, mr.ok);
    if (mr.ok){
      const me = await mr.json();
      console.log('📋 [site.js] /me verisi:', JSON.stringify(me, null, 2));
      currentPlan = me.user?.plan || 'free';
      console.log('📊 [site.js] Mevcut plan:', currentPlan);
    } else {
      console.log(' [site.js] /me çağrısı başarısız:', mr.status);
    }
  } catch (error) {
    console.log(' [site.js] /me çağrısı hatası:', error.message);
  }

  // Plan değişikliği mantığı - Pro'dan alt planlara geçerken onay al
  console.log('📊 [site.js] Plan karşılaştırması yapılıyor...');
  const planHierarchy = { free: 0, starter: 1, pro: 2, enterprise: 3 };
  const currentLevel = planHierarchy[currentPlan] || 0;
  const newLevel = planHierarchy[plan] || 0;
  console.log('📊 [site.js] Plan seviyeleri:', { current: currentLevel, new: newLevel, isDowngrade: newLevel < currentLevel });

  // Pro'dan alt planlara geçerken onay al
  if (currentPlan === 'pro' && newLevel < currentLevel) {
    const planNames = { 'free': 'Ücretsiz', 'starter': 'Starter', 'pro': 'Pro' };
    console.log(`⚠️ [site.js] PRO -> ${plan.toUpperCase()} DOWNGRADE - Özel modal gösteriliyor`);
    const confirmed = await showPlanChangeModal(currentPlan, plan);
    console.log('✅ [site.js] Kullanıcı seçimi:', confirmed ? 'EVET' : 'HAYIR');
    if (!confirmed) return;
  } else {
    console.log('✅ [site.js] Direkt geçiş yapılıyor (modal gerekmiyor)');
  }

  // Free plan için direkt API çağrısı yap
  if (plan === 'free') {
    console.log('🎯 [site.js] FREE PLAN SEÇİLDİ - Direkt API çağrısı yapılıyor');
    try {
      const r = await fetch(`${backendBase}/api/update-plan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ plan: 'free' })
      });
      const j = await r.json();
      console.log('📡 [site.js] /api/update-plan yanıtı:', r.status, r.ok);
      console.log('📋 [site.js] /api/update-plan verisi:', JSON.stringify(j, null, 2));
      if (r.ok) {
        alert('Free plana geçiş yapıldı! 🎉');
        updateHeader();
// Ensure Google Sign-In initializes on page load
try{ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGoogleSignin); else initGoogleSignin(); }catch{}

// Initialize Google Sign-In lazily
try{ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initGoogleSignin); else initGoogleSignin(); }catch{}
        window.location.reload();
      } else {
        alert(j?.error || 'Free plana geçiş yapılamadı');
      }
    } catch (error) {
      console.log('💥 [site.js] Free plan geçiş hatası:', error.message);
      alert('Bağlantı hatası');
    }
    return;
  }

  // PayTR checkout session oluştur
  console.log('🚀 [site.js] PayTR checkout çağrısı yapılıyor...');
  try {
    const r = await fetch(`${backendBase}/api/paytr/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan })
    });
    const j = await r.json();
    console.log('📡 [site.js] PayTR yanıtı:', r.status, r.ok);
    console.log('📋 [site.js] PayTR verisi:', JSON.stringify(j, null, 2));
    if (j?.iframe_url){
      console.log('🔗 [site.js] Ödeme sayfasına yönlendirme:', j.iframe_url);
      window.location.href = j.iframe_url;
      return;
    }
    alert(j?.error || 'Ödeme başlatılamadı');
  } catch (error) {
    console.log('💥 [site.js] PayTR çağrısı hatası:', error.message);
    alert('Bağlantı hatası');
  }
}
// Plan değişikliği modal'ı oluştur
function createPlanChangeModal(){
  if (document.getElementById('planChangeModal')) return;

  const modal = document.createElement('div');
  modal.id = 'planChangeModal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(6px);
    z-index: 50;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.3s ease;
  `;

  modal.innerHTML = `
    <div class="card" style="max-width: 480px; width: 90%; margin: 20px; padding: 32px; text-align: center;">
      <h3 style="margin: 0 0 16px; color: var(--text);">Plan Değişikliği</h3>
      <div id="modalContent" style="margin-bottom: 24px; line-height: 1.5;">
        <!-- İçerik buraya gelecek -->
      </div>
      <div class="row" style="gap: 12px; justify-content: center;">
        <button id="modalCancel" class="btn btn-secondary" style="min-width: 100px;">İptal</button>
        <button id="modalConfirm" class="btn btn-primary" style="min-width: 100px;">Evet, Değiştir</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Modal event listeners
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closePlanChangeModal();
  });

  document.getElementById('modalCancel').addEventListener('click', () => {
    console.log('❌ [site.js] Kullanıcı İPTAL seçti');
    closePlanChangeModal();
  });

  document.getElementById('modalConfirm').addEventListener('click', () => {
    console.log('✅ [site.js] Kullanıcı EVET seçti');
    closePlanChangeModal();
    window.planChangeConfirmed = true;
  });

  // ESC ile kapatma
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closePlanChangeModal();
    }
  });
}

function showPlanChangeModal(currentPlan, targetPlan){
  createPlanChangeModal();

  const modal = document.getElementById('planChangeModal');
  const content = document.getElementById('modalContent');

  const planNames = {
    'free': 'Ücretsiz',
    'starter': 'Starter',
    'pro': 'Pro'
  };

  content.innerHTML = `
    <div style="color: var(--muted); margin-bottom: 8px;">
      Mevcut planınız: <strong>${planNames[currentPlan]}</strong>
    </div>
    <div style="color: var(--text); margin-bottom: 16px;">
      Yeni plan: <strong>${planNames[targetPlan]}</strong>
    </div>
    <div style="color: var(--danger, #ef4444); margin-bottom: 16px; padding: 12px; background: rgba(239, 68, 68, 0.1); border-radius: 8px; border-left: 4px solid var(--danger, #ef4444);">
      ⚠️ Daha düşük bir plana geçiyorsunuz. Bu işlem kullanımdaki tüm limitleri sıfırlar ve geri alınamaz.
    </div>
    <div style="color: var(--muted);">
      Emin misiniz?
    </div>
  `;

  modal.style.display = 'flex';
  // Force reflow
  modal.offsetHeight;
  modal.style.opacity = '1';

  return new Promise((resolve) => {
    window.planChangeConfirmed = false;

    const checkConfirmation = () => {
      if (window.planChangeConfirmed) {
        resolve(true);
      } else {
        setTimeout(checkConfirmation, 100);
      }
    };
    checkConfirmation();
  });
}

function closePlanChangeModal(){
  const modal = document.getElementById('planChangeModal');
  if (modal) {
    modal.style.opacity = '0';
    setTimeout(() => {
      modal.style.display = 'none';
    }, 300);
  }
}

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

// Google Sign-In
async function initGoogleSignin(){
  try{
    const mount = document.getElementById('googleBtn');
    if (!mount) return;
    // Prefer inline config if provided, otherwise fetch from backend
    let clientId = (window.__GOOGLE_CLIENT_ID__ && String(window.__GOOGLE_CLIENT_ID__).trim()) || null;
    if (!clientId){
      try{
        const r = await fetch(`${backendBase}/auth/google-client-id`);
        if (!r.ok) { console.log('[gsi] /auth/google-client-id yanıtı ok değil:', r.status); }
        const j = await r.json().catch(()=>({}));
        clientId = j?.clientId || null;
      } catch (e){ console.log('[gsi] clientId fetch hatası:', e?.message||e); }
    }
    if (!clientId){ console.log('[gsi] clientId yok (inline veya backend). Buton çizilmeyecek.'); return; }

    let tries = 0;
    const start = () => {
      try{
        if (!window.google || !google.accounts || !google.accounts.id){ throw new Error('gsi not ready'); }
        google.accounts.id.initialize({
          client_id: clientId,
          ux_mode: 'popup',
          context: 'signin',
          callback: async (resp) => {
            try{
              const cred = resp && resp.credential;
              if (!cred) return;
              const rr = await fetch(`${backendBase}/auth/google`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential: cred }) });
              const jj = await rr.json();
              if (!rr.ok){ alert(jj?.error || 'Google ile giriş başarısız'); return; }
              setToken(jj.token); updateHeader();
              const dest = consumePostLoginRedirect(); if (dest){ window.location.href = dest; return; }
              closeAuth();
            } catch (e){ alert('Google ile giriş bağlantı hatası'); }
          }
        });
        // Render button
        try{ mount.innerHTML = ''; }catch{}
        google.accounts.id.renderButton(mount, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', width: 280 });
        console.log('[gsi] button rendered');
      } catch (e){
        if (tries++ < 20){ setTimeout(start, 300); } else { console.log('[gsi] yüklenemedi'); }
      }
    };
    start();
  }catch{}
}

function openAuth(){
  try{
    if (authModal){ authModal.style.display = 'block'; try{ initGoogleSignin(); }catch{} return; }
    const redirect = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/?auth=1&redirect=${redirect}`;
  } catch {}
}
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
      try{ console.log('[account-modal] me - TAM VERİ:', JSON.stringify(me, null, 2)); }catch{}
      $('#accPlan').textContent = `Plan: ${me.plan || 'free'}`;
      const lang = $('#accLang'); const voice = $('#accVoice'); const corr = $('#accCorrection');
      if (lang) lang.value = me.preferredLanguage || '';
      if (voice) voice.value = me.preferredVoice || '';
      if (corr) corr.value = me.preferredCorrectionMode || 'gentle';
      const verifyMsg = $('#accVerifyMsg');
      const verifyBtn = $('#accVerifyBtn');
      if (me.emailVerified){
        if (verifyMsg) verifyMsg.textContent = 'E‑posta doğrulandı ';
      } else {
        if (verifyMsg) verifyMsg.textContent = 'E‑posta doğrulanmamış ';
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
      // Fetch usage summary for correct plan info
      fetch(`${backendBase}/usage`, { headers: { Authorization: `Bearer ${token}` } })
        .then(u => u.ok ? u.json() : null)
        .then(usage => {
          if (!usage) return;
          try{ console.log('[account-modal] usage - TAM VERİ:', JSON.stringify(usage, null, 2)); }catch{}
          const d = $('#accUsageDaily'); const m = $('#accUsageMonthly');
          if (d) d.textContent = `Günlük: ${(usage.usedDaily||0).toFixed(1)} / ${usage.limits?.daily ?? '-'} dk`;
          if (m) m.textContent = `Aylık: ${(usage.usedMonthly||0).toFixed(1)} / ${usage.limits?.monthly ?? '-'} dk`;
          
          // Update plan info from usage if available
          if (usage.plan) {
            $('#accPlan').textContent = `Plan: ${usage.plan}`;
            console.log('[account-modal] Plan bilgisi /usage endpointinden güncellendi:', usage.plan);
            
            // Update upgrade button visibility based on usage.plan
            const upBtn = $('#accUpgrade');
            if (upBtn){
              if ((usage.plan || 'free') === 'free'){
                upBtn.style.display = 'inline-flex';
              } else {
                upBtn.style.display = 'none';
              }
            }
          }
        })
        .catch(()=>{ console.log('[account-modal] Usage fetch error'); });
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
// Account button click handler - moved to DOMContentLoaded
document.addEventListener('DOMContentLoaded', function() {
  try{
    const accountBtnEl = document.getElementById('btnAccount');
    if (accountBtnEl) {
      accountBtnEl.addEventListener('click', function(ev) {
        ev.preventDefault();
        const token = getToken();
        if (!token) { 
          setPostLoginRedirect('/account.html'); 
          openAuth(); 
          showLogin(); 
          return; 
        }
        window.location.href = '/account.html';
      });
    }
  }catch{}
});

if (formLogin){
  formLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    authMsg.textContent = 'Giriş yapılıyor...';
    try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
    try {
      const r = await fetch(`${backendBase}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok){
        if (r.status === 403 && j?.error === 'email_not_verified'){
          authMsg.innerHTML = `E-posta doğrulanmamış. <button id="resendVerify" class="btn btn-text">Doğrulama e-postasını tekrar gönder</button>`;
          try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
          const btn = document.getElementById('resendVerify');
          if (btn){
            btn.addEventListener('click', async () => {
              authMsg.textContent = 'Gönderiliyor...';
              try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
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
        try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
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
    try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
    try {
      const r = await fetch(`${backendBase}/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const j = await r.json();
      if (!r.ok){ authMsg.textContent = j?.error || 'Hata'; try{ authMsg.style.display='block'; }catch{}; return; }
      authMsg.textContent = 'Kayıt alındı. Lütfen e‑posta kutunuzu kontrol edip doğrulama yapın.';
      try{ authMsg.style.display = 'block'; authMsg.className = 'alert alert-info'; }catch{}
      // Register sonrası giriş yaptırmıyoruz; doğrulama zorunlu
    } catch (e){ authMsg.textContent = 'Bağlantı hatası'; try{ authMsg.style.display='block'; }catch{} }
  });
}

// Hemen Başla CTA
const btnStart = document.getElementById('btnStart');
if (btnStart){
  btnStart.addEventListener('click', (ev) => {
    ev.preventDefault();
    const token = getToken();
    if (!token){ setPostLoginRedirect('/realtime.html'); openAuth(); showLogin(); return; }
    window.location.href = '/realtime.html';
  });
}

// Init UI
updateHeader();

// Expose critical functions for non-module scripts (header/footer injectors)
try{
  window.updateHeader = updateHeader;
  window.openAuth = openAuth;
  window.showLogin = showLogin;
}catch{}

// Intercept realtime demo links if not logged in
try{
  document.querySelectorAll('a[href="/realtime.html"]').forEach(a => {
    a.addEventListener('click', (ev) => {
      const token = getToken();
      if (!token){ ev.preventDefault(); setPostLoginRedirect('/realtime.html'); openAuth(); showLogin(); }
    });
  });
} catch {}

// ===== Daily Speaking Challenge (standalone page) =====
function pickScenarioForLevel(items, userLevel){
  try{
    if (!Array.isArray(items) || items.length === 0) return null;
    if (!userLevel){
      return items[Math.floor(Math.random()*items.length)];
    }
    const has = items.filter(s => typeof s.level === 'string' && s.level.toUpperCase().includes(String(userLevel).toUpperCase()));
    if (has.length > 0) return has[Math.floor(Math.random()*has.length)];
    return items[Math.floor(Math.random()*items.length)];
  }catch{ return null; }
}

async function setupDailyChallenge(){
  try{
    const dailyEl = document.getElementById('daily');
    if (!dailyEl) return; // only run on dedicated page
    const btn = document.getElementById('dailyStart');
    const shuffle = document.getElementById('dailyShuffle');
    const tag = document.getElementById('dailyTag');
    const lvl = document.getElementById('dailyLevel');
    const desc = document.getElementById('dailyDesc');

    let userLevel = null;
    let prefLearnLang = null;
    let prefNativeLang = null;
    try{
      const token = getToken();
      if (token){
        const r = await fetch(`${backendBase}/me`, { headers:{ Authorization: `Bearer ${token}` } });
        if (r.ok){
          const me = await r.json();
          userLevel = me?.user?.placementLevel || me?.placementLevel || null;
          prefLearnLang = me?.user?.preferredLearningLanguage || null;
          prefNativeLang = me?.user?.preferredNativeLanguage || null;
        }
      }
    }catch{}
    if (lvl) lvl.textContent = `Seviye: ${userLevel || '-'}`;

    // Load scenarios
    let scenarios = [];
    try{
      const r = await fetch(`${backendBase}/scenarios`);
      if (r.ok){ const j = await r.json(); scenarios = Array.isArray(j.items)? j.items : []; }
    }catch{}
    if (!scenarios || scenarios.length === 0){ if (desc) desc.textContent = 'Şu an görev yüklenemedi.'; return; }

    function renderScenario(s){
      if (!s) return;
      if (tag) tag.textContent = s.title || 'Görev';
      if (desc) desc.textContent = s.level ? `Önerilen seviye: ${s.level}` : 'Hazır mısınız?';
      const params = new URLSearchParams();
      if (s.id) params.set('scenario', s.id);
      if (prefLearnLang) params.set('learnLang', prefLearnLang);
      if (prefNativeLang) params.set('nativeLang', prefNativeLang);
      const href = `/realtime.html?${params.toString()}`;
      if (btn) btn.setAttribute('href', href);
    }

    let current = pickScenarioForLevel(scenarios, userLevel) || scenarios[0];
    renderScenario(current);

    if (shuffle){
      shuffle.addEventListener('click', () => {
        try{
          const pool = scenarios.filter(s => s.id !== current.id);
          current = pickScenarioForLevel(pool.length? pool : scenarios, userLevel) || current;
          renderScenario(current);
        }catch{}
      });
    }
  }catch{}
}

try{ if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupDailyChallenge); else setupDailyChallenge(); }catch{}

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
    if (mmAccount){ mmAccount.addEventListener('click', () => { close(); window.location.href = '/account.html'; }); }
    if (mmStart){ mmStart.addEventListener('click', (ev) => { ev.preventDefault(); close(); const t = getToken(); if (!t){ setPostLoginRedirect('/realtime.html'); openAuth(); showLogin(); } else { window.location.href = '/realtime.html'; } }); }
    // Show correct auth buttons
    if (token){ if (mmLogin) mmLogin.style.display = 'none'; if (mmAccount) mmAccount.style.display = 'inline-flex'; }
  }
} catch {}

// If navigated with ?auth=1&redirect=...
try{
  const usp = new URLSearchParams(window.location.search);
  if (usp.get('auth') === '1'){
    const redirect = usp.get('redirect') || '/realtime.html';
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

// Plan butonu event listener'ları
console.log('🔗 [site.js] Plan butonu event listener\'ları bağlanıyor...');
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-plan]')
    .forEach(btn => {
      console.log('🔘 [site.js] Buton bulundu:', btn, 'data-plan:', btn.getAttribute('data-plan'));
      btn.addEventListener('click', onPlanClick);
    });
});

const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : 'https://api.konuskonusabilirsen.com';

function $(s){ return document.querySelector(s); }

function getToken(){ return localStorage.getItem('hk_token'); }

function fillLangSelect(el, def){
  if (!el) return;
  const langs = [
    { code: 'tr', name: 'Türkçe' }, { code: 'en', name: 'İngilizce' }, { code: 'de', name: 'Almanca' },
    { code: 'fr', name: 'Fransızca' }, { code: 'es', name: 'İspanyolca' }, { code: 'it', name: 'İtalyanca' },
    { code: 'pt', name: 'Portekizce' }, { code: 'ru', name: 'Rusça' }, { code: 'ar', name: 'Arapça' },
    { code: 'fa', name: 'Farsça' }, { code: 'hi', name: 'Hintçe' }, { code: 'zh-CN', name: 'Çince (Basit)' },
    { code: 'ja', name: 'Japonca' }, { code: 'ko', name: 'Korece' }
  ];
  el.innerHTML = '';
  langs.forEach(l => {
    const opt = document.createElement('option'); opt.value = l.code; opt.textContent = `${l.name} (${l.code})`;
    if (l.code === def) opt.selected = true;
    el.appendChild(opt);
  });
}

async function loadMe(){
  const token = getToken();
  if (!token) throw new Error('missing_token');
  try{ console.log('[account] /api/me çağrısı hazırlanıyor', { backendBase, hasToken: !!token, tokenPreview: token.slice(0,12)+'...' }); }catch{}
  const r = await fetch(`${backendBase}/api/me`, { headers: { Authorization: `Bearer ${token}` }});
  if (!r.ok){
    let detail = '';
    try{ detail = (await r.clone().text()) || String(r.status); }catch{}
    try{ console.warn('[account] /api/me hata', { status: r.status, detail }); }catch{}
    const err = new Error(`me_error_${r.status}_${detail}`);
    err.status = r.status; err.detail = detail; throw err;
  }
  try{ console.log('[account] /api/me başarılı'); }catch{}
  return r.json();
}

async function loadUsage(){
  const token = getToken();
  try{ console.log('[account] /usage çağrısı', { hasToken: !!token }); }catch{}
  const r = await fetch(`${backendBase}/usage`, { headers: { Authorization: `Bearer ${token}` }});
  if (!r.ok) return null;
  return r.json();
}

async function init(){
  console.log(' [account] init() FONKSİYONU ÇAĞRILDI!');
  try {
    try{ console.log('[account] init başlıyor', { backendBase, token: getToken()? 'VAR':'YOK' }); }catch{}
    const me = await loadMe();
    // API /me yanıtı { user: { ... } } şeklinde; eski sürümlere uyum için me.user || me kullan
    const u = me && me.user ? me.user : me;
    try{ console.log('[account] me yüklendi - TAM VERİ:', JSON.stringify(me, null, 2)); }catch{}
    try{ console.log('[account] user objesi:', JSON.stringify(u, null, 2)); }catch{}
    
    // Debug: Tüm alanları kontrol edelim
    try{ console.log('[account] Kullanıcı alanları:', Object.keys(u)); }catch{}
    try{ console.log('[account] Kullanıcı değerleri:', Object.values(u)); }catch{}
    
    // Seviye bilgisini al - placementLevel, level, currentLevel gibi farklı alan isimleri kontrol et
    let levelValue = '-';
    if (u.placementLevel) {
      levelValue = u.placementLevel;
      console.log('[account] placementLevel bulundu:', levelValue);
    } else if (u.level) {
      levelValue = u.level;
      console.log('[account] level bulundu:', levelValue);
    } else if (u.currentLevel) {
      levelValue = u.currentLevel;
      console.log('[account] currentLevel bulundu:', levelValue);
    } else if (u.placement) {
      levelValue = u.placement;
      console.log('[account] placement bulundu:', levelValue);
    } else {
      console.log('[account] Seviye bilgisi bulunamadı, mevcut alanlar:', Object.keys(u));
    }
    
    console.log(' [account] ELEMENT SEÇİMİ BAŞLIYOR...');
    const badgePlan = $('#accBadgePlan');
    const badgeLevel = $('#accBadgeLevel');
    const emailEl = $('#accEmail');
    const verEl = $('#accVerified');
    
    // Plan bilgisini önce /me'den al, sonra /usage'dan güncelle
    const planValue = u.plan || 'free';
    console.log(' [account] Plan değeri:', planValue);
    if (badgePlan) badgePlan.textContent = `Plan: ${planValue}`;
    
    // Seviye bilgisi
    console.log(' [account] Seviye değeri:', levelValue);
    if (badgeLevel) badgeLevel.textContent = `Seviye: ${levelValue}`;
    
    if (emailEl) emailEl.textContent = u.email || '-';
    if (verEl) verEl.textContent = `Doğrulama: ${u.emailVerified ? 'Doğrulandı' : 'Bekliyor'}`;
    
    // Plan ve seviye elementlerini güncelle
    console.log(' [account] DOM ELEMENTLERİ ARANIYOR...');
    const planText = document.getElementById('planText');
    const levelText = document.getElementById('levelText');
    
    console.log(' [account] Plan elementi:', planText ? 'BULUNDU' : 'BULUNAMADI');
    console.log(' [account] Seviye elementi:', levelText ? 'BULUNDU' : 'BULUNAMADI');
    
    if (planText) {
      planText.textContent = planValue;
      console.log(' [account] Plan elementi güncellendi:', planText.textContent);
    }
    
    if (levelText) {
      levelText.textContent = levelValue;
      console.log(' [account] Seviye elementi güncellendi:', levelText.textContent);
    }
    
    // Debug: DOM element durumunu kontrol et
    console.log('[account] DOM element durumu:', {
      planText: planText ? 'BULUNDU' : 'BULUNAMADI',
      levelText: levelText ? 'BULUNDU' : 'BULUNAMADI',
      badgePlan: badgePlan ? 'BULUNDU' : 'BULUNAMADI',
      badgeLevel: badgeLevel ? 'BULUNDU' : 'BULUNAMADI',
      planTextValue: planText?.textContent,
      levelTextValue: levelText?.textContent,
      planValue: planValue,
      levelValue: levelValue
    });

    // Preferences
    fillLangSelect($('#accLearnLang'), u.preferredLearningLanguage || 'tr');
    fillLangSelect($('#accNativeLang'), u.preferredNativeLanguage || 'tr');
    const voice = $('#accVoice'); if (voice) voice.value = u.preferredVoice || '';
    const corr = $('#accCorrection'); if (corr) corr.value = u.preferredCorrectionMode || 'gentle';

    const usage = await loadUsage();
    if (usage){
      try{ console.log('[account] usage - TAM VERİ:', JSON.stringify(usage, null, 2)); }catch{}
      const d = $('#accUsageDaily'); const m = $('#accUsageMonthly');
      if (d) d.textContent = `Günlük: ${(usage.usedDaily||0).toFixed(1)} / ${usage.limits?.daily ?? '-' } dk`;
      if (m) m.textContent = `Aylık: ${(usage.usedMonthly||0).toFixed(1)} / ${usage.limits?.monthly ?? '-' } dk`;
      // Eğer backend /me ve /usage plan alanları farklı gelirse, /usage.plan'ı kaynak olarak kullan
      try {
        const planText = document.getElementById('planText');
        const badgePlan = $('#accBadgePlan');
        if (planText && usage.plan) {
          const planValue = usage.plan;
          planText.textContent = planValue;
          console.log('[account] Plan bilgisi /usage endpointinden güncellendi:', planValue);
          console.log('[account] Plan elementi güncellendi:', planText.textContent);
        }
        if (badgePlan && usage.plan) {
          badgePlan.textContent = `Plan: ${usage.plan}`;
        }
      } catch {}
    }

    const btnSave = $('#accSave');
    if (btnSave){
      btnSave.addEventListener('click', async () => {
        const preferredLearningLanguage = $('#accLearnLang')?.value || 'tr';
        const preferredNativeLanguage = $('#accNativeLang')?.value || 'tr';
        const preferredVoice = $('#accVoice')?.value?.trim() || null;
        const preferredCorrectionMode = $('#accCorrection')?.value || 'gentle';
        const msg = $('#accMsg'); if (msg) msg.textContent = 'Kaydediliyor...';
        try{
          const rr = await fetch(`${backendBase}/me/preferences`, {
            method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` },
            body: JSON.stringify({ preferredLearningLanguage, preferredNativeLanguage, preferredVoice, preferredCorrectionMode })
          });
          const jj = await rr.json();
          if (!rr.ok){ if (msg) msg.textContent = jj?.error || 'Hata'; return; }
          if (msg) msg.textContent = 'Kaydedildi';
        } catch (e){ if (msg) msg.textContent = 'Bağlantı hatası'; }
      });
    }

    // Gamification summary
    try{
      const gr = await fetch(`${backendBase}/gamification/summary`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (gr.ok){
        const g = await gr.json();
        const streakBadge = $('#streakBadge');
        const goalBadge = $('#goalBadge');
        const goalProgress = $('#goalProgress');
        const goalText = $('#goalText');
        const goalInput = $('#goalInput');
        if (streakBadge) streakBadge.textContent = `Seri: ${g?.streak?.count || 0} gün`;
        const daily = Number(g?.goal?.dailyMinutes || 10);
        const used = Number(g?.goal?.usedDaily || 0);
        const pct = Math.max(0, Math.min(100, Math.round((used / Math.max(1,daily)) * 100)));
        if (goalBadge) goalBadge.textContent = `Günlük Hedef: ${daily} dk`;
        if (goalProgress) goalProgress.style.width = `${pct}%`;
        if (goalText) goalText.textContent = `${used.toFixed(1)}/${daily} dk`;
        if (goalInput) goalInput.value = String(daily);
        // Achievements grid
        const achGrid = $('#achGrid');
        if (achGrid){
          const unlocked = new Set((g?.achievements||[]).map(a => a.key));
          const defs = [
            { key:'streak_3', label:'3 Gün' },
            { key:'streak_7', label:'7 Gün' },
            { key:'streak_30', label:'30 Gün' },
            { key:'daily_goal_met', label:'Günlük Hedef' }
          ];
          achGrid.innerHTML = '';
          defs.forEach(def => {
            const box = document.createElement('div');
            const on = unlocked.has(def.key);
            box.style.padding = '10px';
            box.style.border = '1px solid #1b2442';
            box.style.borderRadius = '10px';
            box.style.background = on ? 'linear-gradient(135deg, rgba(124,58,237,.25), rgba(0,209,255,.18))' : '#0b1022';
            box.style.color = on ? '#e5e7eb' : '#8a93a8';
            box.style.textAlign = 'center';
            box.style.fontSize = '12px';
            box.textContent = def.label;
            achGrid.appendChild(box);
          });
        }
        // Save daily goal
        const goalSave = $('#goalSave');
        if (goalSave && goalInput){
          goalSave.addEventListener('click', async () => {
            const v = Math.max(1, Math.min(300, Number(goalInput.value || 10)));
            const msg = $('#goalMsg'); if (msg) msg.textContent = 'Kaydediliyor...';
            try{
              const rr = await fetch(`${backendBase}/gamification/goal`, { method:'PATCH', headers:{ 'Content-Type':'application/json', Authorization: `Bearer ${getToken()}` }, body: JSON.stringify({ dailyMinutes: v }) });
              const jj = await rr.json();
              if (!rr.ok){ if (msg) msg.textContent = jj?.error || 'Hata'; return; }
              if (goalBadge) goalBadge.textContent = `Günlük Hedef: ${v} dk`;
              if (goalText) goalText.textContent = `${used.toFixed(1)}/${v} dk`;
              if (goalProgress) goalProgress.style.width = `${Math.max(0, Math.min(100, Math.round((used/Math.max(1,v))*100)))}%`;
              if (msg) msg.textContent = 'Kaydedildi';
            }catch(e){ const msg=$('#goalMsg'); if (msg) msg.textContent = 'Bağlantı hatası'; }
          });
        }
      }
    } catch {}
  } catch (e) {
    console.error('[account] load error:', e?.message || e);
    // Oturum yok veya token geçersiz ise login akışına yönlendir
    if (e?.status === 401 || String(e?.message||'').includes('missing_token')){
      const redirect = encodeURIComponent('/account.html');
      window.location.replace(`/?auth=1&redirect=${redirect}`);
      return;
    }
    alert('Hesap verileri yüklenemedi. Lütfen tekrar giriş yapın.');
  }
}

// Global debug - Sayfa yüklenirken çalışacak
console.log('🚀 [account] account.js YÜKLENİYOR...');
console.log('🌐 [account] Current URL:', window.location.href);
console.log('🔐 [account] Token var mı:', !!getToken());

// Sayfa tamamen yüklendikten sonra init'i çağır
window.addEventListener('DOMContentLoaded', () => {
  console.log('📄 [account] DOMContentLoaded - Sayfa hazır!');
  init();
});

// Eğer DOMContentLoaded çalışmadıysa, 2 saniye sonra da dene
setTimeout(() => {
  console.log('⏰ [account] Timeout - init() çağrılıyor...');
  if (!document.querySelector('#planText')) {
    console.log('⚠️ [account] Sayfa henüz hazır değil, tekrar deneniyor...');
    setTimeout(init, 1000);
  } else {
    init();
  }
}, 2000);

// Logout handler
document.addEventListener('DOMContentLoaded', () => {
  try{
    const btn = document.getElementById('btnLogoutAccount');
    if (btn){
      btn.addEventListener('click', () => {
        try{ localStorage.removeItem('hk_token'); }catch{}
        window.location.href = '/';
      });
    }
  } catch {}
});

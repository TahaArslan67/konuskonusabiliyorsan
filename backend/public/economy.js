// Economy plan page logic: Whisper STT -> Realtime (text -> audio)
console.log('[economy] script loaded v4');
// This file intentionally does NOT modify the existing realtime app logic.

const $ = (s) => document.querySelector(s);
const backendBase = (window.__BACKEND_BASE__ && window.__BACKEND_BASE__.trim()) || window.location.origin;

const statusConn = $('#statusConn');
const statusPlan = $('#statusPlan');
const pillStt = $('#pillStt');
const pillMinutes = $('#pillMinutes');
const btnMain = $('#btnMain');
const btnReplay = $('#btnReplay');
const recDot = $('#recDot');
const transcriptEl = $('#transcript');
const remoteAudio = $('#remoteAudio');
const autoTurnEl = document.querySelector('#autoTurn');

let ws = null;
let wsAudioChunks = [];
let wsPlaybackCtx = null;
let wsPlaybackSource = null;
let lastResponseBuffer = null;
let recorder = null;
let recChunks = [];
let isRecording = false;
let recStartAt = 0;

function setConn(open){
  try{ statusConn.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`; }catch{}
}
function setPlan(text){ try{ statusPlan.textContent = `Plan: ${text||'-'}`; }catch{} }
function setSttQuota(used, limit){ try{ pillStt.textContent = `STT: ${used}/${limit}`; }catch{} }
function setMinutes(used, limit){ try{ pillMinutes.textContent = `Günlük: ${Number(used||0).toFixed(1)}/${limit} dk`; }catch{} }
function setRec(on){ try{ recDot.classList.toggle('on', !!on); }catch{} }

function updateMainButton(){
  try {
    if (!btnMain) return;
    btnMain.textContent = isRecording ? 'Durdur' : 'Başla';
    btnMain.disabled = false;
  } catch {}
}

function wsEnsurePlaybackCtx(){
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!wsPlaybackCtx || (wsPlaybackCtx && wsPlaybackCtx.state === 'closed')){
    wsPlaybackCtx = new AC({ sampleRate: 24000 });
  }
  if (wsPlaybackCtx.state === 'suspended') wsPlaybackCtx.resume();
}

function wsPlayPcm(arrayBuffer){
  try{
    wsEnsurePlaybackCtx();
    const pcm16 = new Int16Array(arrayBuffer);
    const len = pcm16.length;
    if (len === 0) return;
    const padSamples = Math.floor(24000 * 0.30);
    const totalLen = len + padSamples;
    const audioBuffer = wsPlaybackCtx.createBuffer(1, totalLen, 24000);
    const ch0 = audioBuffer.getChannelData(0);
    for (let i=0;i<len;i++){ ch0[i] = Math.max(-1, Math.min(1, pcm16[i] / 32768)); }
    for (let i=len;i<totalLen;i++){ ch0[i] = 0; }
    if (wsPlaybackSource) { try { wsPlaybackSource.stop(); } catch {} }
    const src = wsPlaybackCtx.createBufferSource();
    src.buffer = audioBuffer;
    const gain = wsPlaybackCtx.createGain();
    gain.gain.value = 1.4;
    src.connect(gain);
    gain.connect(wsPlaybackCtx.destination);
    wsPlaybackSource = src;
    src.start();
    // Oynatma bittiğinde oto-tur açık ise kısa gecikme ile yeni kayda başla
    try {
      src.onended = () => {
        try {
          const auto = !!(autoTurnEl && autoTurnEl.checked);
          if (auto && ws && ws.readyState === WebSocket.OPEN && !isRecording){
            setTimeout(() => { try { if (!isRecording) toggleRec(); } catch {} }, 300);
          }
        } catch {}
      };
    } catch {}
  }catch(e){ console.log('[economy] play error', e?.message||e); }
}

async function updateMePills(){
  try{
    const token = localStorage.getItem('hk_token');
    if (!token) return;
    const r = await fetch(`${backendBase}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const me = await r.json();
    const plan = me?.user?.plan || me?.plan || 'free';
    setPlan(plan);
    const usage = me?.user?.usage || me?.usage;
    if (usage){ setMinutes(usage.dailyUsed||0, usage.dailyLimit ?? '-'); }
  }catch{}
}

async function connect(autostart = false){
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (autostart && !isRecording) toggleRec();
    return;
  }
  if (btnMain) btnMain.disabled = true;
  try{
    const token = localStorage.getItem('hk_token');
    if (!token){ window.location.replace(`/?auth=1&redirect=${encodeURIComponent('/ekonomi')}`); return; }

    // Start session with economy plan
    const r = await fetch(`${backendBase}/session/start`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ plan: 'economy' })
    });
    if (!r.ok){
      if (r.status === 401){ window.location.replace(`/?auth=1&redirect=${encodeURIComponent('/ekonomi')}`); return; }
      const j = await r.json().catch(()=>({}));
      if (r.status === 403 && j?.error === 'placement_required'){
        const redirect = encodeURIComponent('/ekonomi');
        window.location.replace(`/placement.html?redirect=${redirect}`);
        return;
      }
      alert(j?.error || `Bağlantı başlatılamadı (${r.status})`);
      if (btnMain) btnMain.disabled = false; updateMainButton(); return;
    }
    const s = await r.json();
    const url = s.wsUrl.startsWith('ws') ? s.wsUrl : `${backendBase.replace('http','ws')}${s.wsUrl}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    try { window._ekWs = ws; console.log('[economy] WS connecting to', url); } catch {}
    ws.onopen = () => {
      setConn(true);
      updateMePills();
      // Ek güvence: Türkçe kısa yanıt için oturum ayarını client'tan da gönder
      try {
        ws.send(JSON.stringify({ type: 'session.update', session: { instructions: 'Sadece Türkçe ve kısa yanıt ver. 1-2 doğal cümle kullan. Cümleyi mutlaka nokta veya soru işaretiyle bitir. Sorudan sapma.' } }));
      } catch {}
      if (autostart) {
        setTimeout(() => { try { if (!isRecording) toggleRec(); } catch {} }, 150);
      } else {
        updateMainButton();
      }
    };
    ws.onclose = () => {
      setConn(false);
      isRecording = false;
      setRec(false);
      updateMainButton();
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string'){
        try{
          const obj = JSON.parse(ev.data);
          if (obj.type === 'usage_update' && obj.usage){
            setMinutes(obj.usage.usedDaily||0, obj.usage.limits?.daily ?? '-');
          }
          if (obj.type === 'limit_reached'){
            if (btnMain) btnMain.disabled = true;
          }
          if (obj.type === 'bot_speaking'){
            wsAudioChunks = [];
            // Bot konuşmaya başlarsa kullanıcı kaydını hemen durdur
            try { if (isRecording && recorder && recorder.state === 'recording') recorder.stop(); } catch {}
          }
          if (obj.type === 'debug'){
            try { console.log('[economy][debug]', obj); } catch {}
          }
          if (obj.type === 'error'){
            try { console.error('[economy][ws error]', obj.error || obj); } catch {}
            try { alert(`Sunucu hata döndürdü: ${obj?.error?.message || obj?.error?.code || 'unknown'}`); } catch {}
          }
          if (obj.type === 'transcript'){
            try {
              const text = String(obj.text||'');
              const lines = (transcriptEl.textContent || '').split('\n');
              const lastIdx = lines.length - 1;
              if (!obj.final){
                if (lastIdx >= 0 && lines[lastIdx].startsWith('[BOT')){
                  lines[lastIdx] = `[BOT•] ${text}`;
                } else {
                  lines.push(`[BOT•] ${text}`);
                }
              } else {
                if (lastIdx >= 0 && lines[lastIdx].startsWith('[BOT•] ')){
                  lines[lastIdx] = `[BOT] ${text}`;
                } else {
                  lines.push(`[BOT] ${text}`);
                }
              }
              transcriptEl.textContent = lines.filter(l => l !== '').join('\n');
            } catch {}
          }
          if (obj.type === 'audio_end'){
            const total = wsAudioChunks.reduce((s,a)=> s + a.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0; for (const c of wsAudioChunks){ merged.set(new Uint8Array(c), off); off += c.byteLength; }
            lastResponseBuffer = merged.buffer;
            try { console.debug('[economy] audio_end totalBytes=', total); } catch {}
            if (btnReplay) btnReplay.disabled = false;
            if (total > 0){
              wsPlayPcm(lastResponseBuffer);
            } else {
              // Hiç ses gelmediyse oto-tur açıkken kısa gecikme ile tekrar kayda başla
              try {
                const auto = !!(autoTurnEl && autoTurnEl.checked);
                if (auto && ws && ws.readyState === WebSocket.OPEN && !isRecording){
                  setTimeout(() => { try { if (!isRecording) toggleRec(); } catch {} }, 300);
                }
              } catch {}
            }
            wsAudioChunks = [];
          }
        }catch{}
      } else {
        // binary PCM
        wsAudioChunks.push(ev.data);
      }
    };
  }catch(e){
    alert('Bağlantı hatası');
    if (btnMain) btnMain.disabled = false;
    updateMainButton();
  }
}

function disconnect(){
  try{ if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000,'bye'); }catch{}
  ws = null;
  setConn(false);
  isRecording = false;
  setRec(false);
  updateMainButton();
}

// Record toggle and STT
async function toggleRec(){
  if (isRecording){
    try{ recorder && recorder.stop(); }catch{}
    return;
  }
  try{
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recChunks.push(e.data); };
    recorder.onstop = async () => {
      setRec(false);
      try{ 
        const blob = new Blob(recChunks, { type: 'audio/webm' });
        const b64 = await blobToDataURL(blob);
        const durationMs = recStartAt ? (Date.now() - recStartAt) : 0;
        const text = await doSTT(b64, durationMs);
        if (typeof text === 'string' && text.trim().length > 0){
          const prev = transcriptEl.textContent || '';
          const you = `[YOU] ${text}`;
          transcriptEl.textContent = prev ? `${prev}\n${you}` : you;
          if (ws && ws.readyState === WebSocket.OPEN){
            try{ ws.send(JSON.stringify({ type: 'text', text })); }catch{}
          }
        }
      } catch (e){ console.log('[economy] STT error', e?.message||e); }
      try{ stream.getTracks().forEach(t=>t.stop()); }catch{}
      isRecording = false;
      updateMainButton();
    };
    recorder.start();
    recStartAt = Date.now();
    isRecording = true;
    updateMainButton();
    setRec(true);
    // Otomatik olarak 7 sn sonra durdur (kısa cümleler için)
    setTimeout(() => { try{ isRecording && recorder && recorder.state === 'recording' && recorder.stop(); }catch{} }, 7000);
  }catch(e){ alert('Mikrofona erişilemiyor'); }
}

async function blobToDataURL(blob){
  return new Promise((resolve,reject) => {
    try{
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    }catch(e){ reject(e); }
  });
}

async function doSTT(dataUrl, durationMs){
  try{
    const token = localStorage.getItem('hk_token');
    if (!token){ alert('Giriş yapın'); return ''; }
    const r = await fetch(`${backendBase}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ audio: dataUrl, language: 'tr', durationMs: Number(durationMs)||undefined })
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok){
      if (r.status === 403 && j?.error === 'limit_reached'){
        const used = j?.usage?.dailyUsed ?? j?.quota?.dailyUsed ?? j?.dailyUsed ?? '-';
        const lim = j?.usage?.dailyLimit ?? j?.quota?.dailyLimit ?? j?.dailyLimit ?? '-';
        setSttQuota(used, lim);
        alert('Günlük limitiniz doldu.');
        return '';
      }
      alert(j?.error || 'STT hatası');
      return '';
    }
    const used = j?.quota?.dailyUsed ?? '-';
    const lim = j?.quota?.dailyLimit ?? '-';
    setSttQuota(used, lim);
    return j?.text || '';
  }catch(e){ alert('Bağlantı hatası'); return ''; }
}

if (btnMain) btnMain.addEventListener('click', async () => {
  try {
    if (!ws || (ws.readyState !== WebSocket.OPEN)) {
      await connect(true); // bağlan ve kaydı başlat
    } else {
      await toggleRec(); // başlat/durdur
    }
  } catch {}
});
if (btnReplay) btnReplay.addEventListener('click', () => { try{ if (lastResponseBuffer) wsPlayPcm(lastResponseBuffer); }catch{} });

// Prefetch pills on load
updateMePills().catch(()=>{});

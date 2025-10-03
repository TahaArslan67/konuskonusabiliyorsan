// Economy plan page logic: Whisper STT -> Realtime (text -> audio)
// This file intentionally does NOT modify the existing realtime app logic.

const $ = (s) => document.querySelector(s);
const backendBase = (window.__BACKEND_BASE__ && window.__BACKEND_BASE__.trim()) || window.location.origin;

const statusConn = $('#statusConn');
const statusPlan = $('#statusPlan');
const pillStt = $('#pillStt');
const pillMinutes = $('#pillMinutes');
const btnConnect = $('#btnConnect');
const btnDisconnect = $('#btnDisconnect');
const btnRec = $('#btnRec');
const btnReplay = $('#btnReplay');
const recDot = $('#recDot');
const transcriptEl = $('#transcript');
const remoteAudio = $('#remoteAudio');

let ws = null;
let wsAudioChunks = [];
let wsPlaybackCtx = null;
let wsPlaybackSource = null;
let lastResponseBuffer = null;
let recorder = null;
let recChunks = [];
let isRecording = false;

function setConn(open){
  try{ statusConn.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`; }catch{}
}
function setPlan(text){ try{ statusPlan.textContent = `Plan: ${text||'-'}`; }catch{} }
function setSttQuota(used, limit){ try{ pillStt.textContent = `STT: ${used}/${limit}`; }catch{} }
function setMinutes(used, limit){ try{ pillMinutes.textContent = `Günlük: ${Number(used||0).toFixed(1)}/${limit} dk`; }catch{} }
function setRec(on){ try{ recDot.classList.toggle('on', !!on); }catch{} }

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

async function connect(){
  if (ws && ws.readyState === WebSocket.OPEN) return;
  btnConnect.disabled = true;
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
      btnConnect.disabled = false; return;
    }
    const s = await r.json();
    const url = s.wsUrl.startsWith('ws') ? s.wsUrl : `${backendBase.replace('http','ws')}${s.wsUrl}`;
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    try { window._ekWs = ws; console.log('[economy] WS connecting to', url); } catch {}
    ws.onopen = () => {
      setConn(true);
      btnDisconnect.disabled = false;
      btnRec.disabled = false;
      updateMePills();
    };
    ws.onclose = () => {
      setConn(false);
      btnConnect.disabled = false;
      btnDisconnect.disabled = true;
      btnRec.disabled = true;
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
            btnRec.disabled = true;
          }
          if (obj.type === 'bot_speaking'){
            wsAudioChunks = [];
          }
          if (obj.type === 'debug'){
            try { console.debug('[economy][debug]', obj); } catch {}
          }
          if (obj.type === 'error'){
            try { console.error('[economy][ws error]', obj.error || obj); } catch {}
            try { alert(`Sunucu hata döndürdü: ${obj?.error?.message || obj?.error?.code || 'unknown'}`); } catch {}
          }
          if (obj.type === 'transcript'){
            try {
              const prev = transcriptEl.textContent || '';
              const prefix = obj.final ? '[BOT] ' : '[BOT•] ';
              transcriptEl.textContent = prev ? `${prev}\n${prefix}${String(obj.text||'')}` : `${prefix}${String(obj.text||'')}`;
            } catch {}
          }
          if (obj.type === 'audio_end'){
            const total = wsAudioChunks.reduce((s,a)=> s + a.byteLength, 0);
            const merged = new Uint8Array(total);
            let off = 0; for (const c of wsAudioChunks){ merged.set(new Uint8Array(c), off); off += c.byteLength; }
            lastResponseBuffer = merged.buffer;
            if (btnReplay) btnReplay.disabled = false;
            wsPlayPcm(lastResponseBuffer);
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
    btnConnect.disabled = false;
  }
}

function disconnect(){
  try{ if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000,'bye'); }catch{}
  ws = null;
  setConn(false);
  btnConnect.disabled = false;
  btnDisconnect.disabled = true;
  btnRec.disabled = true;
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
        const text = await doSTT(b64);
        if (typeof text === 'string' && text.trim().length > 0){
          transcriptEl.textContent = text;
          if (ws && ws.readyState === WebSocket.OPEN){
            try{ ws.send(JSON.stringify({ type: 'text', text })); }catch{}
          }
        }
      } catch (e){ console.log('[economy] STT error', e?.message||e); }
      try{ stream.getTracks().forEach(t=>t.stop()); }catch{}
      isRecording = false;
      btnRec.textContent = 'Kaydı Başlat';
    };
    recorder.start();
    isRecording = true;
    btnRec.textContent = 'Kaydı Durdur';
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

async function doSTT(dataUrl){
  try{
    const token = localStorage.getItem('hk_token');
    if (!token){ alert('Giriş yapın'); return ''; }
    const r = await fetch(`${backendBase}/api/stt`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ audio: dataUrl, language: 'tr' })
    });
    const j = await r.json().catch(()=>({}));
    if (!r.ok){
      if (r.status === 403 && j?.error === 'limit_reached'){
        setSttQuota(j?.dailyUsed ?? '-', j?.dailyLimit ?? '-');
        alert('Günlük STT hakkınız doldu.');
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

if (btnConnect) btnConnect.addEventListener('click', connect);
if (btnDisconnect) btnDisconnect.addEventListener('click', disconnect);
if (btnRec) btnRec.addEventListener('click', toggleRec);
if (btnReplay) btnReplay.addEventListener('click', () => { try{ if (lastResponseBuffer) wsPlayPcm(lastResponseBuffer); }catch{} });

// Prefetch pills on load
updateMePills().catch(()=>{});

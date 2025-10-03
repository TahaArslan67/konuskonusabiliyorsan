// Economy plan page logic: Whisper STT -> Realtime (text -> audio)
console.log('[economy] script loaded v4');
// This file intentionally does NOT modify the existing realtime app logic.

const $ = (s) => document.querySelector(s);
const backendBase = (window.__BACKEND_BASE__ && window.__BACKEND_BASE__.trim()) || window.location.origin;

const statusConn = $('#statusConn');
const statusPlan = $('#statusPlan');
const pillMinutes = $('#pillMinutes');
const btnMain = $('#btnMain');
const btnReplay = $('#btnReplay');
const recDot = $('#recDot');
const transcriptEl = $('#transcript');
const remoteAudio = $('#remoteAudio');

let ws = null;
let wsAudioChunks = [];
let wsPlaybackCtx = null;
let wsPlaybackSource = null;
let lastResponseBuffer = null;
// Streaming mic state (STT kaldırıldı; Realtime'a PCM akışı)
let audioCtx = null;
let micStream = null;
let micSource = null;
let micProcessor = null;
let micStreaming = false;   // currently streaming within a turn
let vadSilenceMs = 0;
let bytesSinceStart = 0;
let isBotSpeaking = false;
function setConn(open){ try{ statusConn.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`; }catch{} }
function setPlan(text){ try{ statusPlan.textContent = `Plan: ${text||'-'}`; }catch{} }
function setMinutes(used, limit){ try{ pillMinutes.textContent = `Günlük: ${Number(used||0).toFixed(1)}/${limit} dk`; }catch{} }
function setRec(on){ try{ recDot.classList.toggle('on', !!on); }catch{} }

let micCapturing = false;

function updateMainButton(){
  try {
    if (!btnMain) return;
    btnMain.textContent = micCapturing ? 'Durdur' : 'Başla';
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
    // Oynatma bittiğinde otomatik yeni tura hazır ol
    try {
      src.onended = () => {
        try {
          isBotSpeaking = false;
          // VAD, kullanıcı konuştuğunda yeni turu başlatacak (capture açıkken)
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
    if (autostart && !micCapturing) startCapture();
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
        setTimeout(() => { try { if (!micCapturing) startCapture(); } catch {} }, 150);
      } else {
        updateMainButton();
      }
    };
    ws.onclose = () => {
      setConn(false);
      try { stopCapture(true); } catch {}
      micCapturing = false;
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
            isBotSpeaking = true;
            // Bot konuşmaya başlarsa kullanıcı akışını sonlandır
            try { if (micStreaming && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {}
            micStreaming = false;
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
              // Sessiz yanıt; sadece bot konuşma durumunu sıfırla
              isBotSpeaking = false;
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
  try { stopCapture(true); } catch {}
  micCapturing = false;
  setRec(false);
  updateMainButton();
}

// ----- Realtime Mic Streaming (no STT) -----
function floatTo16BitPCM(input){
  const out = new Int16Array(input.length);
  for (let i=0;i<input.length;i++){
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return out.buffer;
}

async function startCapture(){
  if (!ws || ws.readyState !== WebSocket.OPEN) { await connect(true); return; }
  if (micCapturing) return;
  try{
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 24000, echoCancellation: true, noiseSuppression: true } });
  } catch(e){ alert('Mikrofon izni/erişimi yok'); return; }
  try{
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
  } catch(e){ try{ micStream.getTracks().forEach(t=>t.stop()); }catch{} alert('AudioContext açılamadı'); return; }
  micSource = audioCtx.createMediaStreamSource(micStream);
  micProcessor = audioCtx.createScriptProcessor(4096, 1, 1);
  const speakThreshold = 0.02;
  micProcessor.onaudioprocess = (ev) => {
    try{
      const ch = ev.inputBuffer.getChannelData(0);
      let sum = 0; for (let i=0;i<ch.length;i++){ const v = ch[i]; sum += v*v; }
      const rms = Math.sqrt(sum / ch.length);
      const ms = (ch.length / (audioCtx.sampleRate || 24000)) * 1000;

      if (isBotSpeaking) {
        // Bot konuşurken kullanıcı akışını başlatma / devam ettirme
        vadSilenceMs = 0;
        if (micStreaming) { try { ws.send(JSON.stringify({ type: 'audio_stop' })); } catch{} micStreaming = false; setRec(false); }
        return;
      }

      if (!micStreaming && rms > speakThreshold) {
        // Yeni tur başlat
        try { ws.send(JSON.stringify({ type: 'audio_start', format: 'pcm16', sampleRate: 24000, channels: 1 })); } catch {}
        micStreaming = true; bytesSinceStart = 0; vadSilenceMs = 0; setRec(true);
      }

      if (micStreaming) {
        const buf = floatTo16BitPCM(ch);
        try { ws.send(buf); } catch {}
        bytesSinceStart += buf.byteLength;
        if (rms > speakThreshold) {
          vadSilenceMs = 0;
        } else {
          vadSilenceMs += ms;
          if (vadSilenceMs >= 350) {
            if (bytesSinceStart >= 4800) { try { ws.send(JSON.stringify({ type: 'audio_stop' })); } catch {} }
            micStreaming = false; setRec(false); vadSilenceMs = 0; bytesSinceStart = 0;
          }
        }
      }
    }catch{}
  };
  micSource.connect(micProcessor);
  micProcessor.connect(audioCtx.destination);
  micCapturing = true; updateMainButton();
}

function stopCapture(silent){
  try { if (micStreaming && ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'audio_stop' })); } catch{}
  micStreaming = false; setRec(false);
  try { micProcessor && micProcessor.disconnect(); } catch {}
  try { micSource && micSource.disconnect(); } catch {}
  try { micStream && micStream.getTracks().forEach(t=>t.stop()); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  micProcessor = null; micSource = null; micStream = null; audioCtx = null;
  micCapturing = false; if (!silent) updateMainButton();
}

if (btnMain) btnMain.addEventListener('click', async () => {
  try {
    if (!ws || (ws.readyState !== WebSocket.OPEN)) {
      await connect(true); // bağlan ve kaydı başlat
    } else {
      if (!micCapturing) { await startCapture(); } else { stopCapture(); }
    }
  } catch {}
});
if (btnReplay) btnReplay.addEventListener('click', () => { try{ if (lastResponseBuffer) wsPlayPcm(lastResponseBuffer); }catch{} });

// Prefetch pills on load
updateMePills().catch(()=>{});

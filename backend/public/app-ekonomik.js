// Economic Plan App - Uses cheaper speech-to-text processing
// Instead of direct WebRTC audio streaming, this converts speech to text first

// Get backend base URL from config (same pattern as app.js)
const backendBase = (typeof window !== 'undefined' && window.__BACKEND_BASE__) ? window.__BACKEND_BASE__ : 'https://api.konuskonusabilirsen.com';

let ws = null;
let wsMicStream = null;
let remoteAudio = null;
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;

// DOM elements
const btnStartTalk = document.getElementById('btnStartTalk');
const btnStopTalk = document.getElementById('btnStopTalk');
const btnReplay = document.getElementById('btnReplay');
const statusConnEl = document.getElementById('statusConn');
const statusMicEl = document.getElementById('statusMic');
const statusPlanEl = document.getElementById('statusPlan');
const limitDailyEl = document.getElementById('limitDaily');
const remoteAudioEl = document.getElementById('remoteAudio');

// Initialize
try {
  remoteAudio = remoteAudioEl;
  // Load user preferences and limits
  loadUserData();

  // Event listeners
  if (btnStartTalk) btnStartTalk.addEventListener('click', startConversation);
  if (btnStopTalk) btnStopTalk.addEventListener('click', stopConversation);
  if (btnReplay) btnReplay.addEventListener('click', replayLastResponse);

  // Periodic status updates
  setInterval(updateStatus, 1000);

} catch (e) {
  console.error('[app-ekonomik] init error:', e);
}

async function loadUserData() {
  try {
    const token = localStorage.getItem('hk_token');
    if (!token) return;

    const r = await fetch(`${backendBase}/me`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (r.ok) {
      const me = await r.json();
      console.log('[app-ekonomik] User data loaded:', me);

      if (statusPlanEl) statusPlanEl.textContent = `Plan: ${me.user?.plan || 'free'}`;
      if (limitDailyEl) {
        const used = me.usage?.dailyUsed || 0;
        const limit = me.usage?.dailyLimit || 0;
        limitDailyEl.textContent = `Günlük: ${used}/${limit} dk`;
      }

      // Update placement level
      const placementBadgeEl = document.getElementById('placementBadge');
      if (placementBadgeEl && me.user?.placementLevel) {
        placementBadgeEl.textContent = `Seviye: ${me.user.placementLevel}`;
      }
    }
  } catch (e) {
    console.error('[app-ekonomik] loadUserData error:', e);
  }
}

function updateStatus() {
  if (statusConnEl) {
    const open = ws && ws.readyState === WebSocket.OPEN;
    statusConnEl.textContent = `Bağlantı: ${open ? 'Açık' : 'Kapalı'}`;
  }
  if (statusMicEl) {
    statusMicEl.textContent = `Mikrofon: ${isRecording ? 'Açık' : 'Kapalı'}`;
  }
}

async function startConversation() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    console.log('[app-ekonomik] already connected');
    return;
  }

  try {
    $('#btnStartTalk').disabled = true;

    // 1) Get session
    const sessionRes = await fetch(`${backendBase}/session/economic/start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${localStorage.getItem('hk_token')}`
      }
    });

    if (!sessionRes.ok) {
      const err = await sessionRes.json();
      throw new Error(err.message || `Session failed: ${sessionRes.status}`);
    }

    const { sessionId, wsUrl } = await sessionRes.json();

    // 2) Connect WebSocket (for economic plan - handles text input/output)
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      console.log('[app-ekonomik] WebSocket connected');
      console.log('[app-ekonomik] WebSocket readyState:', ws.readyState);
      $('#btnStopTalk').disabled = false;
      $('#btnStartTalk').disabled = true;

      // Start microphone recording for speech-to-text
      console.log('[app-ekonomik] Starting microphone recording...');
      startMicrophoneRecording().catch(error => {
        console.error('[app-ekonomik] Microphone error:', error);
        alert('Mikrofon erişimi başarısız: ' + error.message);
      });
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleMessage(msg);
      } catch (err) {
        console.error('[app-ekonomik] message parse error:', err);
      }
    };

    ws.onclose = (e) => {
      console.log('[app-ekonomik] WebSocket closed:', e.code, e.reason);
      console.log('[app-ekonomik] WebSocket close event:', e);
      console.log('[app-ekonomik] ws wasClean:', e.wasClean);
      console.log('[app-ekonomik] ws readyState at close:', ws.readyState);
      cleanup();
    };

    ws.onerror = (e) => {
      console.error('[app-ekonomik] WebSocket error:', e);
      cleanup();
    };

  } catch (e) {
    console.error('[app-ekonomik] start error:', e);
    alert('Bağlantı başlatılırken hata: ' + e.message);
    $('#btnStartTalk').disabled = false;
  }
}

async function stopConversation() {
  if (!ws) return;

  try {
    // Stop recording
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
    }

    // Close WebSocket
    ws.close();
    ws = null;

    $('#btnStartTalk').disabled = false;
    $('#btnStopTalk').disabled = true;

  } catch (e) {
    console.error('[app-ekonomik] stop error:', e);
  }
}

async function startMicrophoneRecording() {
  try {
    console.log('[app-ekonomik] Requesting microphone access...');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 16000
      }
    });

    console.log('[app-ekonomik] Microphone access granted');
    wsMicStream = stream;

    // Use MediaRecorder for audio chunks
    console.log('[app-ekonomik] Creating MediaRecorder...');
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    console.log('[app-ekonomik] MediaRecorder created, state:', mediaRecorder.state);

    mediaRecorder.ondataavailable = (event) => {
      console.log('[app-ekonomik] Audio chunk received, size:', event.data.size);
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      console.log('[app-ekonomik] MediaRecorder stopped, processing audio...');
      // Process audio chunk for speech-to-text
      processAudioForSpeechToText();
    };

    mediaRecorder.onerror = (error) => {
      console.error('[app-ekonomik] MediaRecorder error:', error);
    };

    // Record in 1 second chunks and process them
    console.log('[app-ekonomik] Starting MediaRecorder...');

    let recordingInterval;
    mediaRecorder.ondataavailable = (event) => {
      console.log('[app-ekonomik] Audio chunk received, size:', event.data.size);
      if (event.data.size > 0) {
        audioChunks.push(event.data);
        // Process immediately when we get a chunk
        if (audioChunks.length > 0) {
          processAudioForSpeechToText();
        }
      }
    };

    // Start recording and set up interval to restart every 3 seconds
    const startRecording = () => {
      if (mediaRecorder && mediaRecorder.state === 'inactive') {
        audioChunks = []; // Clear previous chunks
        mediaRecorder.start(3000); // Record for 3 seconds
        console.log('[app-ekonomik] Recording started for 3 seconds');
      }
    };

    const stopAndRestart = () => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        console.log('[app-ekonomik] Recording stopped, will restart...');
        setTimeout(startRecording, 100); // Restart after 100ms
      }
    };

    mediaRecorder.onstop = () => {
      console.log('[app-ekonomik] MediaRecorder stopped, processing audio...');
      if (audioChunks.length > 0) {
        processAudioForSpeechToText();
      }
      // Restart recording after processing
      setTimeout(startRecording, 500);
    };

    startRecording();
    isRecording = true;
    console.log('[app-ekonomik] Recording started');

    // Set up interval to check and restart recording
    recordingInterval = setInterval(stopAndRestart, 3500);

  } catch (e) {
    console.error('[app-ekonomik] microphone error:', e);
    alert('Mikrofon erişimi başarısız: ' + e.message);
  }
}

async function processAudioForSpeechToText() {
  if (audioChunks.length === 0) return;

  try {
    // Combine audio chunks
    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

    // Here we would integrate with a speech-to-text service like:
    // - Google Speech-to-Text API
    // - Azure Speech Services
    // - OpenAI Whisper API (cheaper than realtime)
    // For demo purposes, we'll simulate this

    console.log('[app-ekonomik] Processing audio for speech-to-text...', audioBlob.size, 'bytes');

    // Simulate speech-to-text processing
    // In real implementation, send to speech-to-text API
    console.log('[app-ekonomik] Calling simulateSpeechToText...');
    const transcribedText = await simulateSpeechToText(audioBlob);
    console.log('[app-ekonomik] simulateSpeechToText returned:', transcribedText);
    console.log('[app-ekonomik] ws exists:', !!ws);
    console.log('[app-ekonomik] ws readyState:', ws ? ws.readyState : 'ws is null');

    // Check if WebSocket is still open before sending
    console.log('[app-ekonomik] Checking WebSocket before send...');
    console.log('[app-ekonomik] transcribedText:', transcribedText);
    console.log('[app-ekonomik] ws exists:', !!ws);
    console.log('[app-ekonomik] ws readyState:', ws ? ws.readyState : 'ws is null');

    if (!transcribedText || !transcribedText.trim()) {
      console.error('[app-ekonomik] No valid transcribed text to send');
      return;
    }

    if (!ws) {
      console.error('[app-ekonomik] WebSocket is null - cannot send message');
      console.log('[app-ekonomik] Attempting to reconnect WebSocket...');
      // Try to reconnect if WebSocket is closed
      if (window.location.reload) {
        console.log('[app-ekonomik] Reloading page to reconnect...');
        window.location.reload();
      }
      return;
    }

    console.log('[app-ekonomik] WebSocket readyState:', ws.readyState);
    console.log('[app-ekonomik] WebSocket.OPEN constant:', WebSocket.OPEN);

    if (ws.readyState === WebSocket.OPEN) {
      console.log('[app-ekonomik] WebSocket is OPEN, sending message:', transcribedText);

      // Send transcribed text to server
      const message = {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{
            type: 'input_text',
            text: transcribedText
          }]
        }
      };

      const messageStr = JSON.stringify(message);
      console.log('[app-ekonomik] Message JSON length:', messageStr.length);
      console.log('[app-ekonomik] Message JSON preview:', messageStr.substring(0, 200) + '...');

      try {
        console.log('[app-ekonomik] Calling ws.send()...');
        ws.send(messageStr);
        console.log('[app-ekonomik] Successfully sent message:', transcribedText);
      } catch (sendError) {
        console.error('[app-ekonomik] Error sending message:', sendError);
        console.error('[app-ekonomik] Send error details:', {
          name: sendError.name,
          message: sendError.message,
          stack: sendError.stack
        });
      }
    } else {
      console.error('[app-ekonomik] Cannot send message - WebSocket not OPEN');
      console.error('[app-ekonomik] Current readyState:', ws.readyState);
      console.error('[app-ekonomik] Expected OPEN state:', WebSocket.OPEN);
      console.error('[app-ekonomik] transcribedText:', transcribedText);
    }

    // Clear chunks for next recording
    audioChunks = [];

  } catch (e) {
    console.error('[app-ekonomik] speech-to-text error:', e);
  }
}

// For demo purposes, we'll use a text input instead of speech-to-text
// In production, you would integrate with a real speech-to-text API
async function simulateSpeechToText(audioBlob) {
  console.log('[app-ekonomik] simulateSpeechToText called with blob size:', audioBlob.size);

  try {
    // Show text input for demo
    const text = prompt('Demo mode: Lütfen söylemek istediğiniz metni yazın (örneğin: Merhaba):');
    console.log('[app-ekonomik] User input from prompt:', text);

    if (text && text.trim()) {
      const trimmedText = text.trim();
      console.log('[app-ekonomik] Returning trimmed text:', trimmedText);
      return trimmedText;
    } else {
      console.log('[app-ekonomik] No valid text input, returning null');
      return null;
    }
  } catch (error) {
    console.error('[app-ekonomik] Error in simulateSpeechToText:', error);
    return null;
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'conversation.item.created':
      console.log('[app-ekonomik] Item created:', msg.item?.id);
      break;

    case 'conversation.item.input_audio_transcription.completed':
      console.log('[app-ekonomik] Audio transcription completed');
      break;

    case 'response.created':
      console.log('[app-ekonomik] Response created');
      break;

    case 'response.output_item.added':
      console.log('[app-ekonomik] Output item added');
      break;

    case 'response.output_item.done':
      console.log('[app-ekonomik] Output item done');
      break;

    case 'response.done':
      console.log('[app-ekonomik] Response done');
      break;

    case 'usage_update':
      updateUsageDisplay(msg.usage);
      break;

    case 'limit_reached':
      alert('Günlük kullanım limitiniz doldu!');
      stopConversation();
      break;

    default:
      console.log('[app-ekonomik] Unhandled message type:', msg.type);
  }
}

function updateUsageDisplay(usage) {
  if (limitDailyEl && usage) {
    limitDailyEl.textContent = `Günlük: ${usage.usedDaily}/${usage.limits?.daily || 0} dk`;
  }
}

async function replayLastResponse() {
  if (remoteAudio) {
    try {
      remoteAudio.currentTime = 0;
      await remoteAudio.play();
    } catch (e) {
      console.error('[app-ekonomik] replay error:', e);
    }
  }
}

function cleanup() {
  // Clear recording interval
  if (typeof recordingInterval !== 'undefined') {
    clearInterval(recordingInterval);
  }

  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    isRecording = false;
  }

  if (wsMicStream) {
    wsMicStream.getTracks().forEach(track => track.stop());
    wsMicStream = null;
  }

  $('#btnStartTalk').disabled = false;
  $('#btnStopTalk').disabled = true;
  $('#btnReplay').disabled = true;

  ws = null;
}

// Helper function
function $(sel) {
  return document.querySelector(sel);
}

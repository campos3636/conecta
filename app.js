const $ = id => document.getElementById(id);
const MAX = 10;
let peer, localStream, displayStream, hostConnection, isHost = false, roomCode = '', userName = '', hasCamera = true;
let starting = false, releaseSession = null;
let audioContext;
const audioNodes = new Map();
const voiceMonitors = new Map();
const browserId = localStorage.getItem('conecta-browser-id') || crypto.randomUUID();
localStorage.setItem('conecta-browser-id', browserId);
const connections = new Map(), calls = new Map(), members = new Map();
const memberIds = new Map();
const screenAudioCalls = new Map(), incomingScreenAudio = new Map();
function microphoneConstraints(deviceId) {
  return {echoCancellation:true, noiseSuppression:true, autoGainControl:true, ...(deviceId ? {deviceId:{exact:deviceId}} : {})};
}

function notice(message) {
  const box = $('notice'); box.replaceChildren();
  if (!message) return;
  const text = document.createElement('span'); text.textContent = message;
  const close = document.createElement('button'); close.textContent = '✕'; close.className = 'notice-close'; close.setAttribute('aria-label', 'Fechar aviso'); close.onclick = () => box.replaceChildren();
  box.append(text, close);
}
function highlightTile(tile) {
  const selected = tile.classList.contains('featured');
  document.querySelectorAll('#videos .featured').forEach(item => { item.classList.remove('featured'); const button = item.querySelector('.feature-button'); if (button) { button.textContent = '☆ Destacar'; button.setAttribute('aria-pressed', 'false'); } });
  if (!selected) { tile.classList.add('featured'); const button = tile.querySelector('.feature-button'); button.textContent = '★ Em destaque'; button.setAttribute('aria-pressed', 'true'); }
}
function clearAudio(id) { const node = audioNodes.get(id); if (node) { node.source.disconnect(); node.gain.disconnect(); audioNodes.delete(id); } }
function clearVoice(id) { const monitor = voiceMonitors.get(id); if (monitor) { clearInterval(monitor.timer); monitor.source.disconnect(); monitor.analyser.disconnect(); voiceMonitors.delete(id); } }
function monitorVoice(id, stream, tile) {
  clearVoice(id);
  if (id.startsWith('screen-') || !stream.getAudioTracks().length) return;
  try {
    audioContext ||= new AudioContext(); audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream), analyser = audioContext.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    const timer = setInterval(() => { if (!tile.isConnected) { clearVoice(id); return; } analyser.getByteTimeDomainData(samples); let total = 0; for (const sample of samples) total += ((sample - 128) / 128) ** 2; tile.classList.toggle('speaking', Math.sqrt(total / samples.length) > 0.045); }, 200);
    voiceMonitors.set(id, {source, analyser, timer});
  } catch { /* A chamada continua funcionando mesmo sem indicador visual. */ }
}
function showScreenAudio(id, stream) {
  const key = 'screen-' + id;
  videoTile(key, 'Tela de ' + (members.get(id) || 'Participante'), stream);
  document.getElementById('video-' + key)?.classList.add('screen-tile');
}
function sendScreenAudio(id) {
  if (!peer || !displayStream || screenAudioCalls.has(id)) return;
  const call = peer.call(id, displayStream, {metadata:{kind:'screen-stream'}});
  if (!call) return;
  screenAudioCalls.set(id, call);
  call.on('close', () => { if (screenAudioCalls.get(id) === call) screenAudioCalls.delete(id); });
  call.on('error', () => { if (screenAudioCalls.get(id) === call) screenAudioCalls.delete(id); notice('Não foi possível enviar o áudio da transmissão a um participante.'); });
}
function receiveScreenAudio(call) {
  const id = call.peer;
  incomingScreenAudio.get(id)?.close(); incomingScreenAudio.set(id, call);
  call.on('stream', stream => showScreenAudio(id, stream));
  const cleanup = () => { if (incomingScreenAudio.get(id) !== call) return; incomingScreenAudio.delete(id); clearAudio('screen-' + id); document.getElementById('video-screen-' + id)?.remove(); };
  call.on('close', cleanup); call.on('error', cleanup); call.answer();
}
function videoTile(id, name, stream, local = false) {
  let tile = document.getElementById('video-' + id);
  if (!tile) {
    tile = document.createElement('div'); tile.id = 'video-' + id; tile.className = 'tile';
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = true;
    const label = document.createElement('span');
    const fullscreen = document.createElement('button'); fullscreen.className = 'fullscreen'; fullscreen.textContent = '⛶ Tela cheia';
    const feature = document.createElement('button'); feature.className = 'feature-button'; feature.textContent = '☆ Destacar'; feature.setAttribute('aria-pressed', 'false'); feature.onclick = () => highlightTile(tile);
    video.onclick = () => highlightTile(tile);
    fullscreen.onclick = async () => {
      if (tile.classList.contains('expanded')) { tile.classList.remove('expanded'); fullscreen.textContent = '⛶ Tela cheia'; return; }
      try { if (video.webkitEnterFullscreen && !video.requestFullscreen) { video.webkitEnterFullscreen(); return; } if (video.requestFullscreen) { await video.requestFullscreen(); return; } } catch {}
      tile.classList.add('expanded'); fullscreen.textContent = '✕ Fechar';
    };
    tile.append(video, label, fullscreen, feature);
    if (!local) {
      const controls = document.createElement('div'); controls.className = 'volume-control';
      const volume = document.createElement('input'); volume.type = 'range'; volume.min = '0'; volume.max = '200'; volume.value = '100'; volume.setAttribute('aria-label', 'Volume de ' + name);
      const value = document.createElement('output'); value.textContent = '100%';
      volume.oninput = () => { value.textContent = volume.value + '%'; const node = audioNodes.get(id); if (node) node.gain.gain.value = Number(volume.value) / 100; audioContext?.resume(); };
      controls.append(volume, value); tile.append(controls);
    }
    $('videos').append(tile);
  }
  tile.querySelector('span').textContent = name + (local ? ' (você)' : '');
  tile.querySelector('video').srcObject = stream;
  monitorVoice(id, stream, tile);
  if (!local && stream.getAudioTracks().length) {
    clearAudio(id);
    try {
      audioContext ||= new AudioContext();
      const source = audioContext.createMediaStreamSource(stream), gain = audioContext.createGain();
      gain.gain.value = Number(tile.querySelector('input').value) / 100; source.connect(gain).connect(audioContext.destination);
      audioNodes.set(id, {source, gain}); audioContext.resume();
    } catch { tile.querySelector('video').muted = false; notice('Controle de volume ampliado indisponível neste navegador.'); }
  }
}
function updateCount() { $('count').textContent = `${members.size} / ${MAX}`; }
function outgoingStream() {
  return localStream;
}
function setupCall(call) {
  if (calls.has(call.peer)) { call.close(); return; }
  calls.set(call.peer, call);
  sendScreenAudio(call.peer);
  call.on('stream', stream => videoTile(call.peer, members.get(call.peer) || 'Participante', stream));
  call.on('close', () => { if (calls.get(call.peer) === call) calls.delete(call.peer); clearAudio(call.peer); clearVoice(call.peer); document.getElementById('video-' + call.peer)?.remove(); });
  call.on('error', () => notice('Não foi possível conectar a mídia de um participante.'));
}
function broadcast(message) { for (const conn of connections.values()) if (conn.open) conn.send(message); }
function validChat(data) {
  return data && ((data.kind === 'text' && typeof data.content === 'string' && data.content.trim().length > 0 && data.content.length <= 1000) || (data.kind === 'image' && typeof data.content === 'string' && data.content.length <= 700000 && /^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(data.content)));
}
function renderChat(data, own = false) {
  if (!validChat(data)) return;
  const list = $('chat-messages'), bubble = document.createElement('article'); bubble.className = 'chat-bubble' + (own ? ' own' : '');
  const author = document.createElement('strong'); author.textContent = own ? 'Você' : String(data.name || 'Participante').slice(0, 30); bubble.append(author);
  if (data.kind === 'text') { const text = document.createElement('p'); text.textContent = data.content; bubble.append(text); }
  else { const image = document.createElement('img'); image.src = data.content; image.alt = 'Imagem enviada por ' + author.textContent; image.loading = 'lazy'; bubble.append(image); }
  list.append(bubble); list.scrollTop = list.scrollHeight;
  if (!own && $('chat-panel').hidden) { $('chat-toggle').textContent = '💬 Chat • nova mensagem'; }
}
function sendChat(kind, content) {
  const message = {type:'chat', kind, content, name:userName};
  if (!validChat(message)) return false;
  if (!peer || $('meeting').hidden) { notice('Entre em uma chamada antes de enviar mensagens.'); return false; }
  if (!isHost && !hostConnection?.open) { notice('Não foi possível enviar: conexão com a sala indisponível.'); return false; }
  if (isHost) broadcast(message); else hostConnection.send(message);
  renderChat(message, true); return true;
}
function removeMember(id) {
  members.delete(id); memberIds.delete(id); connections.delete(id); calls.get(id)?.close(); calls.delete(id);
  screenAudioCalls.get(id)?.close(); screenAudioCalls.delete(id); incomingScreenAudio.get(id)?.close(); incomingScreenAudio.delete(id);
  clearAudio('screen-' + id); document.getElementById('video-screen-' + id)?.remove();
  clearAudio(id); clearVoice(id); document.getElementById('video-' + id)?.remove(); updateCount();
}
function handleHostConnection(conn) {
  let admitted = false;
  conn.on('data', data => {
    if (admitted) {
      if (data?.type === 'chat' && validChat(data)) {
        const message = {type:'chat', kind:data.kind, content:data.content, name:members.get(conn.peer)};
        renderChat(message); for (const other of connections.values()) if (other !== conn && other.open) other.send(message);
      }
      return;
    }
    if (data?.type !== 'join') return;
    if (typeof data.browserId !== 'string' || !data.browserId || Array.from(memberIds.values()).includes(data.browserId)) { conn.send({type:'duplicate'}); setTimeout(() => conn.close(), 500); return; }
    if (members.size >= MAX) { conn.send({type:'full'}); setTimeout(() => conn.close(), 500); return; }
    admitted = true; connections.set(conn.peer, conn); members.set(conn.peer, String(data.name || 'Participante').slice(0,30)); memberIds.set(conn.peer, data.browserId);
    conn.send({type:'welcome', members: Array.from(members.entries())});
    broadcast({type:'member', id:conn.peer, name:members.get(conn.peer)}); updateCount();
  });
  conn.on('close', () => { if (admitted) { removeMember(conn.peer); broadcast({type:'left', id:conn.peer}); } });
  conn.on('error', () => { if (admitted) { removeMember(conn.peer); broadcast({type:'left', id:conn.peer}); } });
}
function setupClient(conn) {
  hostConnection = conn;
  conn.on('open', () => conn.send({type:'join', name:userName, browserId}));
  conn.on('data', data => {
    if (data?.type === 'full') { alert('Esta sala já atingiu o limite de 10 pessoas.'); leave(); }
    if (data?.type === 'duplicate') { alert('Este ID já está participando da sala.'); leave(); }
    if (data?.type === 'welcome') {
      for (const [id, name] of data.members) members.set(id, name);
      updateCount(); showMeeting();
      for (const [id] of members) if (id !== peer.id) { const call = peer.call(id, outgoingStream()); if (call) setupCall(call); }
    }
    if (data?.type === 'member') { members.set(data.id, data.name); updateCount(); }
    if (data?.type === 'left') removeMember(data.id);
    if (data?.type === 'chat') renderChat(data);
  });
  conn.on('close', () => { if (peer && !peer.destroyed) { alert('A sala foi encerrada porque o anfitrião saiu ou perdeu a conexão.'); leave(); } });
  conn.on('error', () => { notice('Conexão com o anfitrião interrompida.'); });
}
function showMeeting() { $('welcome').hidden = true; $('meeting').hidden = false; $('room-code').textContent = roomCode; videoTile(peer.id, userName, localStream, true); window.scrollTo(0, 0); }
async function start(host) {
  if (starting || peer) return;
  userName = $('name').value.trim(); roomCode = $('room').value.trim().toLowerCase();
  if (!userName || !roomCode || !/^[a-z0-9]{1,32}$/.test(roomCode)) { alert('Informe seu nome e um código de sala válido (letras e números).'); return; }
  if (!window.Peer) { alert('Não foi possível carregar o serviço de conexão. Verifique sua internet.'); return; }
  if (!navigator.locks) { alert('Seu navegador não oferece o recurso necessário para impedir sessões duplicadas. Use uma versão recente do Edge ou Chrome.'); return; }
  starting = true; $('create').disabled = $('join').disabled = true;
  try {
    const acquired = await new Promise((resolve, reject) => {
      navigator.locks.request('conecta-sessao', {ifAvailable:true}, lock => {
        if (!lock) { resolve(false); return; }
        return new Promise(release => { releaseSession = release; resolve(true); });
      }).catch(reject);
    });
    if (!acquired) { alert('Você já possui uma chamada aberta em outra aba deste navegador.'); return; }
    const selectedMic = $('mic-select')?.value;
    localStream = await navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(selectedMic)});
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1c302b'; ctx.fillRect(0, 0, 640, 400);
    ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Câmera desligada', 320, 200);
    localStream.addTrack(canvas.captureStream(1).getVideoTracks()[0]); hasCamera = false;
    $('camera').disabled = false; $('camera').textContent = '▣ Ligar câmera';
    isHost = host; peer = new Peer(host ? 'conecta-room-' + roomCode : undefined);
    peer.on('open', id => { members.set(id, userName); memberIds.set(id, browserId); if (host) { updateCount(); showMeeting(); } else setupClient(peer.connect('conecta-room-' + roomCode, {reliable:true})); });
    peer.on('connection', conn => { if (isHost) handleHostConnection(conn); else conn.close(); });
    peer.on('call', call => { if (call.metadata?.kind === 'screen-stream') { receiveScreenAudio(call); return; } setupCall(call); call.answer(outgoingStream()); });
    peer.on('error', err => { console.error(err); alert(err.type === 'peer-unavailable' ? 'Sala não encontrada ou participante indisponível.' : 'Erro de conexão: ' + err.type); if ($('meeting').hidden) leave(); else notice('Erro de conexão: ' + err.type); });
    peer.on('disconnected', () => notice('Conexão com o servidor de sinalização perdida.'));
  } catch (err) { alert('Não foi possível acessar o microfone ou a câmera. Verifique se o microfone está conectado e autorizado no navegador e no Windows.'); leave(); }
  finally { starting = false; $('create').disabled = $('join').disabled = false; }
}
async function replaceVideo(track) {
  await Promise.all(Array.from(calls.values(), async call => {
    const sender = call.peerConnection?.getSenders().find(s => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track);
  }));
}
async function stopScreen() {
  if (!displayStream) return;
  for (const call of screenAudioCalls.values()) call.close(); screenAudioCalls.clear();
  const old = displayStream; displayStream = null; old.getTracks().forEach(t => t.stop());
  document.getElementById('video-screen-local')?.remove(); $('screen').textContent = '▤ Compartilhar tela'; $('screen').classList.remove('active'); notice('');
}
function leave() {
  const oldPeer = peer; peer = null; hostConnection = null; if (oldPeer) oldPeer.destroy();
  localStream?.getTracks().forEach(t => t.stop()); displayStream?.getTracks().forEach(t => t.stop());
  for (const call of screenAudioCalls.values()) call.close(); screenAudioCalls.clear();
  for (const call of incomingScreenAudio.values()) call.close(); incomingScreenAudio.clear();
  localStream = displayStream = null; calls.clear(); connections.clear(); members.clear(); memberIds.clear(); $('videos').replaceChildren();
  for (const id of audioNodes.keys()) clearAudio(id);
  for (const id of voiceMonitors.keys()) clearVoice(id);
  $('chat-messages').replaceChildren(); $('chat-input').value = ''; $('chat-panel').hidden = true; $('chat-toggle').textContent = '💬 Chat';
  if (releaseSession) { releaseSession(); releaseSession = null; }
  $('welcome').hidden = false; $('meeting').hidden = true; notice(''); $('screen').textContent = '▤ Compartilhar tela'; $('screen').classList.remove('active'); $('mic').textContent = '🎙 Microfone ligado'; $('camera').textContent = '▣ Câmera ligada'; $('camera').disabled = false;
}
$('create').onclick = () => { const url = new URL('sala.html', location.href); url.searchParams.set('sala', crypto.randomUUID().replaceAll('-', '').slice(0, 16)); url.searchParams.set('criar', '1'); location.href = url.href; };
$('join').onclick = () => { if (!location.pathname.endsWith('/sala.html')) { const code = $('room').value.trim().toLowerCase(); if (!/^[a-z0-9]{1,32}$/.test(code)) { alert('Informe um código de sala válido.'); return; } const url = new URL('sala.html', location.href); url.searchParams.set('sala', code); location.href = url.href; } else start(new URLSearchParams(location.search).has('criar')); }; $('leave').onclick = leave;
$('mic').onclick = () => { const t = localStream.getAudioTracks()[0]; t.enabled = !t.enabled; $('mic').textContent = t.enabled ? '🎙 Microfone ligado' : '🎙 Microfone desligado'; };
$('camera').onclick = async () => {
  const t = localStream.getVideoTracks()[0];
  if (hasCamera) { t.enabled = !t.enabled; $('camera').textContent = t.enabled ? '▣ Câmera ligada' : '▣ Câmera desligada'; return; }
  try { const stream = await navigator.mediaDevices.getUserMedia({video:true}); const track = stream.getVideoTracks()[0]; localStream.removeTrack(t); t.stop(); localStream.addTrack(track); hasCamera = true; await replaceVideo(track); videoTile(peer.id, userName, localStream, true); $('camera').textContent = '▣ Câmera ligada'; }
  catch { notice('Não foi possível ligar a câmera. Confira se ela está conectada e autorizada.'); }
};
$('screen').onclick = async () => {
  if (displayStream) { await stopScreen(); return; }
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:60}},audio:true,systemAudio:'include',windowAudio:'system'});
    displayStream.getVideoTracks()[0].onended = stopScreen;
    videoTile('screen-local', 'Sua transmissão', displayStream, true); document.getElementById('video-screen-local').classList.add('screen-tile');
    for (const id of calls.keys()) sendScreenAudio(id);
    if (displayStream.getAudioTracks().length) { notice('Compartilhamento com áudio ativado.'); }
    else notice('Tela compartilhada sem áudio. Pare o compartilhamento e tente novamente: no Edge, escolha Tela inteira e marque Compartilhar áudio do sistema antes de clicar em Compartilhar. A opção pode não aparecer ao escolher uma janela.');
    $('screen').textContent = '▤ Parar compartilhamento'; $('screen').classList.add('active');
  } catch (err) { if (displayStream) await stopScreen(); if (err.name !== 'NotAllowedError') notice('Não foi possível compartilhar a tela.'); }
};
$('copy').onclick = async () => { try { const url = new URL('sala.html', location.href); url.searchParams.set('sala', roomCode); await navigator.clipboard.writeText(url.href); $('copy').textContent = 'Copiado!'; setTimeout(() => $('copy').textContent = 'Copiar convite', 2000); } catch { notice('Não foi possível copiar. Compartilhe o código: ' + roomCode); } };
const chatToggle = document.createElement('button'); chatToggle.id = 'chat-toggle'; chatToggle.textContent = '💬 Chat'; chatToggle.setAttribute('aria-expanded', 'false'); $('meeting').querySelector('.controls').append(chatToggle);
const chatPanel = document.createElement('aside'); chatPanel.id = 'chat-panel'; chatPanel.hidden = true; chatPanel.setAttribute('aria-label', 'Chat da chamada');
chatPanel.innerHTML = '<div class="chat-header"><div><strong>Chat da chamada</strong><small>Mensagens disponíveis durante a sessão</small></div><button type="button" id="chat-close" aria-label="Fechar chat">✕</button></div><div id="chat-messages" class="chat-messages" aria-live="polite"></div><p class="chat-info">Cole com Ctrl+V ou envie uma imagem de até 512 KB.</p><form id="chat-form" class="chat-form"><label class="chat-attach" title="Enviar imagem" aria-label="Escolher imagem">＋<input id="chat-file" type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden></label><input id="chat-input" type="text" maxlength="1000" placeholder="Digite uma mensagem ou cole uma imagem" aria-label="Mensagem"><button type="submit">Enviar</button></form>';
$('meeting').append(chatPanel);
function toggleChat(open) { chatPanel.hidden = !open; chatToggle.setAttribute('aria-expanded', String(open)); if (open) { chatToggle.textContent = '💬 Chat'; $('chat-input').focus(); } }
chatToggle.onclick = () => toggleChat(chatPanel.hidden); $('chat-close').onclick = () => toggleChat(false);
$('chat-form').onsubmit = event => { event.preventDefault(); const input = $('chat-input'), text = input.value.trim(); if (text && sendChat('text', text)) input.value = ''; };
async function sendChatImage(file) {
  if (!file) return;
  if (!['image/jpeg','image/png','image/webp','image/gif'].includes(file.type)) { notice('Escolha uma imagem PNG, JPEG, WebP ou GIF.'); return; }
  if (file.size > 512 * 1024 && file.type !== 'image/gif') {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas'), scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.8, 0.6, 0.4, 0.25]) { const compressed = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality)); if (compressed && compressed.size <= 512 * 1024) { file = compressed; break; } }
    } catch { notice('Não foi possível reduzir a imagem. Tente uma imagem menor.'); return; }
    finally { bitmap?.close(); }
  }
  if (file.size > 512 * 1024) { notice('A imagem é muito grande. Tente uma imagem de até 512 KB.'); return; }
  const reader = new FileReader(); reader.onload = () => { if (!sendChat('image', reader.result)) notice('Não foi possível enviar a imagem.'); }; reader.onerror = () => notice('Não foi possível abrir a imagem.'); reader.readAsDataURL(file);
}
$('chat-file').onchange = event => {
  const file = event.target.files[0]; event.target.value = ''; sendChatImage(file);
};
chatPanel.addEventListener('paste', event => {
  const item = Array.from(event.clipboardData?.items || []).find(entry => entry.kind === 'file' && entry.type.startsWith('image/'));
  if (!item) return;
  event.preventDefault(); sendChatImage(item.getAsFile());
});
if (location.pathname.endsWith('/sala.html')) {
  const params = new URLSearchParams(location.search); $('room').value = params.get('sala') || '';
  $('welcome').classList.add('room-entry'); $('welcome').querySelector('.intro').hidden = true;
  $('welcome').querySelector('h2').textContent = params.has('criar') ? 'Criar sua sala' : 'Entrar na chamada';
  $('welcome').querySelector('.card > p').textContent = 'Informe seu ID (nome) para participar.';
  $('welcome').querySelector('label[for="name"]').textContent = 'Seu ID / nome';
  $('create').hidden = true; $('welcome').querySelector('.divider').hidden = true; $('welcome').querySelector('label[for="room"]').hidden = true; $('room').hidden = true;
  $('join').textContent = params.has('criar') ? 'Criar e entrar' : 'Entrar na chamada';
  const prep = document.createElement('div'); prep.className = 'mic-prep';
  const label = document.createElement('label'); label.htmlFor = 'mic-select'; label.textContent = 'Microfone';
  const select = document.createElement('select'); select.id = 'mic-select';
  const defaultOption = document.createElement('option'); defaultOption.value = ''; defaultOption.textContent = 'Microfone padrão'; select.append(defaultOption);
  const test = document.createElement('button'); test.type = 'button'; test.className = 'mic-test'; test.textContent = 'Verificar microfone';
  const status = document.createElement('p'); status.className = 'mic-status'; status.textContent = 'A câmera permanece desligada ao entrar.';
  test.onclick = async () => {
    test.disabled = true; let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:microphoneConstraints(select.value)});
      const current = stream.getAudioTracks()[0].getSettings().deviceId;
      const devices = await navigator.mediaDevices.enumerateDevices(); select.replaceChildren(defaultOption);
      for (const device of devices.filter(d => d.kind === 'audioinput')) { const option = document.createElement('option'); option.value = device.deviceId; option.textContent = device.label || 'Microfone'; select.append(option); }
      if (current && [...select.options].some(option => option.value === current)) select.value = current;
      status.textContent = 'Microfone acessível. Fale na chamada para testá-lo com outra pessoa.';
    } catch { status.textContent = 'Não foi possível acessar o microfone. Verifique a conexão e as permissões do navegador.'; }
    finally { stream?.getTracks().forEach(track => track.stop()); test.disabled = false; }
  };
  prep.append(label, select, test, status); $('join').before(prep);
}
else {
  $('welcome').querySelector('label[for="name"]').hidden = true; $('name').hidden = true;
  $('welcome').querySelector('.divider').hidden = true; $('welcome').querySelector('label[for="room"]').hidden = true; $('room').hidden = true; $('join').hidden = true;
  $('welcome').querySelector('.card > p').textContent = 'Crie sua sala e convide quem você quiser para jogar e conversar.';
}

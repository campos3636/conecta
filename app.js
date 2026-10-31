const $ = id => document.getElementById(id);
const MAX = 10;
let peer, localStream, displayStream, hostConnection, isHost = false, roomCode = '', userName = '', hasCamera = true;
let starting = false, releaseSession = null;
let audioContext;
const audioNodes = new Map();
const browserId = localStorage.getItem('conecta-browser-id') || crypto.randomUUID();
localStorage.setItem('conecta-browser-id', browserId);
const connections = new Map(), calls = new Map(), members = new Map();
const memberIds = new Map();
const screenAudioCalls = new Map(), incomingScreenAudio = new Map();

function notice(message) { $('notice').textContent = message; }
function highlightTile(tile) {
  const selected = tile.classList.contains('featured');
  document.querySelectorAll('#videos .featured').forEach(item => { item.classList.remove('featured'); const button = item.querySelector('.feature-button'); if (button) { button.textContent = '☆ Destacar'; button.setAttribute('aria-pressed', 'false'); } });
  if (!selected) { tile.classList.add('featured'); const button = tile.querySelector('.feature-button'); button.textContent = '★ Em destaque'; button.setAttribute('aria-pressed', 'true'); }
}
function clearAudio(id) { const node = audioNodes.get(id); if (node) { node.source.disconnect(); node.gain.disconnect(); audioNodes.delete(id); } }
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
  call.on('close', () => { if (calls.get(call.peer) === call) calls.delete(call.peer); clearAudio(call.peer); document.getElementById('video-' + call.peer)?.remove(); });
  call.on('error', () => notice('Não foi possível conectar a mídia de um participante.'));
}
function broadcast(message) { for (const conn of connections.values()) if (conn.open) conn.send(message); }
function removeMember(id) {
  members.delete(id); memberIds.delete(id); connections.delete(id); calls.get(id)?.close(); calls.delete(id);
  screenAudioCalls.get(id)?.close(); screenAudioCalls.delete(id); incomingScreenAudio.get(id)?.close(); incomingScreenAudio.delete(id);
  clearAudio('screen-' + id); document.getElementById('video-screen-' + id)?.remove();
  clearAudio(id); document.getElementById('video-' + id)?.remove(); updateCount();
}
function handleHostConnection(conn) {
  let admitted = false;
  conn.on('data', data => {
    if (admitted || data?.type !== 'join') return;
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
    localStream = await navigator.mediaDevices.getUserMedia({audio:true});
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
if (location.pathname.endsWith('/sala.html')) {
  const params = new URLSearchParams(location.search); $('room').value = params.get('sala') || '';
  $('welcome').classList.add('room-entry'); $('welcome').querySelector('.intro').hidden = true;
  $('welcome').querySelector('h2').textContent = params.has('criar') ? 'Criar sua sala' : 'Entrar na chamada';
  $('welcome').querySelector('.card > p').textContent = 'Informe seu ID (nome) para participar.';
  $('welcome').querySelector('label[for="name"]').textContent = 'Seu ID / nome';
  $('create').hidden = true; $('welcome').querySelector('.divider').hidden = true; $('welcome').querySelector('label[for="room"]').hidden = true; $('room').hidden = true;
  $('join').textContent = params.has('criar') ? 'Criar e entrar' : 'Entrar na chamada';
}
else {
  $('welcome').querySelector('label[for="name"]').hidden = true; $('name').hidden = true;
  $('welcome').querySelector('.divider').hidden = true; $('welcome').querySelector('label[for="room"]').hidden = true; $('room').hidden = true; $('join').hidden = true;
  $('welcome').querySelector('.card > p').textContent = 'Crie sua sala e convide quem você quiser para jogar e conversar.';
}

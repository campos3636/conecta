const $ = id => document.getElementById(id);
const MAX = 10;
let peer, localStream, displayStream, hostConnection, isHost = false, roomCode = '', userName = '', hasCamera = true;
let starting = false, releaseSession = null;
const browserId = localStorage.getItem('conecta-browser-id') || crypto.randomUUID();
localStorage.setItem('conecta-browser-id', browserId);
const connections = new Map(), calls = new Map(), members = new Map();
const memberIds = new Map();

function notice(message) { $('notice').textContent = message; }
function videoTile(id, name, stream, local = false) {
  let tile = document.getElementById('video-' + id);
  if (!tile) {
    tile = document.createElement('div'); tile.id = 'video-' + id; tile.className = 'tile';
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = local;
    const label = document.createElement('span'); tile.append(video, label); $('videos').append(tile);
  }
  tile.querySelector('span').textContent = name + (local ? ' (você)' : '');
  tile.querySelector('video').srcObject = stream;
}
function updateCount() { $('count').textContent = `${members.size} / ${MAX}`; }
function outgoingStream() {
  return new MediaStream([...localStream.getAudioTracks(), ...(displayStream ? displayStream.getVideoTracks() : localStream.getVideoTracks())]);
}
function setupCall(call) {
  if (calls.has(call.peer)) { call.close(); return; }
  calls.set(call.peer, call);
  call.on('stream', stream => videoTile(call.peer, members.get(call.peer) || 'Participante', stream));
  call.on('close', () => { if (calls.get(call.peer) === call) calls.delete(call.peer); document.getElementById('video-' + call.peer)?.remove(); });
  call.on('error', () => notice('Não foi possível conectar a mídia de um participante.'));
}
function broadcast(message) { for (const conn of connections.values()) if (conn.open) conn.send(message); }
function removeMember(id) {
  members.delete(id); memberIds.delete(id); connections.delete(id); calls.get(id)?.close(); calls.delete(id);
  document.getElementById('video-' + id)?.remove(); updateCount();
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
function showMeeting() { $('welcome').hidden = true; $('meeting').hidden = false; $('room-code').textContent = roomCode; videoTile(peer.id, userName, localStream, true); }
async function start(host) {
  if (starting || peer) return;
  userName = $('name').value.trim(); roomCode = host ? Math.random().toString(36).slice(2,10) : $('room').value.trim().toLowerCase();
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
    try {
      localStream = await navigator.mediaDevices.getUserMedia({video:true, audio:true});
      hasCamera = true;
    } catch (err) {
      if (err.name !== 'NotFoundError' && err.name !== 'OverconstrainedError') throw err;
      localStream = await navigator.mediaDevices.getUserMedia({audio:true});
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 400;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#1c302b'; ctx.fillRect(0, 0, 640, 400);
      ctx.fillStyle = '#ffffff'; ctx.font = '24px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Câmera indisponível', 320, 200);
      localStream.addTrack(canvas.captureStream(1).getVideoTracks()[0]); hasCamera = false;
    }
    $('camera').disabled = !hasCamera; $('camera').textContent = hasCamera ? '▣ Câmera ligada' : '▣ Sem câmera';
    isHost = host; peer = new Peer(host ? 'conecta-room-' + roomCode : undefined);
    peer.on('open', id => { members.set(id, userName); memberIds.set(id, browserId); if (host) { updateCount(); showMeeting(); } else setupClient(peer.connect('conecta-room-' + roomCode, {reliable:true})); });
    peer.on('connection', conn => { if (isHost) handleHostConnection(conn); else conn.close(); });
    peer.on('call', call => { setupCall(call); call.answer(outgoingStream()); });
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
  const old = displayStream; displayStream = null; old.getTracks().forEach(t => t.stop());
  try { await replaceVideo(localStream.getVideoTracks()[0]); } catch { notice('Não foi possível restaurar o vídeo para todos os participantes.'); }
  videoTile(peer.id, userName, localStream, true); $('screen').textContent = '▤ Compartilhar tela'; $('screen').classList.remove('active');
}
function leave() {
  const oldPeer = peer; peer = null; hostConnection = null; if (oldPeer) oldPeer.destroy();
  localStream?.getTracks().forEach(t => t.stop()); displayStream?.getTracks().forEach(t => t.stop());
  localStream = displayStream = null; calls.clear(); connections.clear(); members.clear(); memberIds.clear(); $('videos').replaceChildren();
  if (releaseSession) { releaseSession(); releaseSession = null; }
  $('welcome').hidden = false; $('meeting').hidden = true; notice(''); $('screen').textContent = '▤ Compartilhar tela'; $('screen').classList.remove('active'); $('mic').textContent = '🎙 Microfone ligado'; $('camera').textContent = '▣ Câmera ligada'; $('camera').disabled = false;
}
$('create').onclick = () => start(true); $('join').onclick = () => start(false); $('leave').onclick = leave;
$('mic').onclick = () => { const t = localStream.getAudioTracks()[0]; t.enabled = !t.enabled; $('mic').textContent = t.enabled ? '🎙 Microfone ligado' : '🎙 Microfone desligado'; };
$('camera').onclick = () => { const t = localStream.getVideoTracks()[0]; t.enabled = !t.enabled; $('camera').textContent = t.enabled ? '▣ Câmera ligada' : '▣ Câmera desligada'; };
$('screen').onclick = async () => {
  if (displayStream) { await stopScreen(); return; }
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({video:{width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}},audio:false});
    displayStream.getVideoTracks()[0].onended = stopScreen;
    await replaceVideo(displayStream.getVideoTracks()[0]); videoTile(peer.id, userName, displayStream, true);
    $('screen').textContent = '▤ Parar compartilhamento'; $('screen').classList.add('active');
  } catch (err) { if (displayStream) await stopScreen(); if (err.name !== 'NotAllowedError') notice('Não foi possível compartilhar a tela.'); }
};
$('copy').onclick = async () => { try { const url = new URL(location.href); url.searchParams.set('sala', roomCode); await navigator.clipboard.writeText(url.href); $('copy').textContent = 'Copiado!'; setTimeout(() => $('copy').textContent = 'Copiar convite', 2000); } catch { notice('Não foi possível copiar. Compartilhe o código: ' + roomCode); } };
$('room').value = new URLSearchParams(location.search).get('sala') || '';

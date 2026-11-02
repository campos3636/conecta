const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Real PeerJS/WebRTC, isolated profiles and local signaling. Only microphone,
// camera and screen capture are replaced by generated audio/video: no device
// permissions, real screen contents or external rooms are used by these tests.
let browser, baseURL, signalPort;
const servers = [];
function startServer(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd:path.join(__dirname, '..'), env:{...process.env, ...env}, stdio:['ignore','pipe','pipe'] });
    servers.push(child);
    let output = '';
    child.on('error', reject);
    child.on('exit', code => reject(new Error('Test server exited: ' + code + '\n' + output)));
    child.stdout.on('data', data => { output += data; const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)|http:\/\/localhost:(\d+)/); if (match) resolve(Number(match[1] || match[2])); });
    child.stderr.on('data', data => { output += data; });
  });
}
before(async () => {
  const appPort = await startServer(['server.js'], {PORT:'0'});
  baseURL = 'http://localhost:' + appPort;
  signalPort = await startServer(['-e', 'require("peer").PeerServer({port:0,host:"127.0.0.1"},server=>console.log("http://127.0.0.1:"+server.address().port))']);
  browser = await chromium.launch({channel:process.env.TEST_BROWSER_CHANNEL || 'msedge', headless:true});
});
after(async () => {
  await browser?.close();
  for (const server of servers) server.kill();
});
async function client(t, room, host = false, name = 'Teste', avatar = 'Controle') {
  const context = await browser.newContext({viewport:{width:1366,height:900}});
  t.after(() => context.close());
  const errors = [];
  const peerSource = fs.readFileSync(path.join(__dirname, '../node_modules/peerjs/dist/peerjs.min.js'), 'utf8');
  await context.route('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', route => route.fulfill({contentType:'text/javascript', body:peerSource + `\n{const OriginalPeer=window.Peer;window.__mediaCalls=0;window.Peer=class extends OriginalPeer{constructor(id,options={}){super(id,{...options,host:'127.0.0.1',port:${signalPort},secure:false,path:'/',config:{...options.config,iceServers:[]}})}call(...args){window.__mediaCalls++;return super.call(...args)}};}`}));
  await context.addInitScript(() => {
    window.__captureOptions = [];
    window.__captureMode = 'normal';
    window.__makeStream = ({video = false, audio = false, color = '#21573c', tone = 880}) => {
      const tracks = [];
      if (audio) {
        const ctx = new AudioContext(), oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
        gain.gain.value = 0.01; oscillator.frequency.value = tone; oscillator.connect(gain).connect(destination); oscillator.start(); ctx.resume(); tracks.push(...destination.stream.getAudioTracks());
      }
      if (video) {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let frame = 0;
        const paint = () => { ctx.fillStyle = color; ctx.fillRect(0,0,640,360); ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('Transmissão de teste ' + frame++, 50,180); };
        paint(); const track = canvas.captureStream(15).getVideoTracks()[0];
        const timer = setInterval(() => { if (track.readyState === 'ended') clearInterval(timer); else paint(); }, 65);
        tracks.push(track);
      }
      return new MediaStream(tracks);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable:true, value:async options => window.__makeStream({...options,color:'#3a479f',tone:440})});
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable:true, value:async options => {
      window.__captureOptions.push(options);
      if (window.__captureMode === 'denied') throw new DOMException('Denied for test', 'NotAllowedError');
      if (window.__captureMode === 'fail-audio' && options.audio) throw new DOMException('System capture failed for test', 'NotReadableError');
      if (window.__captureMode === 'deferred') return new Promise(resolve => { window.__finishCapture = () => { window.__lateStream = window.__makeStream(options); resolve(window.__lateStream); }; });
      return window.__makeStream(options);
    }});
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => { if (!dialog.message().startsWith('A sala foi encerrada')) errors.push(dialog.message()); dialog.dismiss(); });
  t.after(() => assert.deepEqual(errors, [], 'No unhandled errors or unexpected dialogs'));
  await page.goto(baseURL + (room ? '/sala.html?sala=' + room + (host ? '&criar=1' : '') : '/'));
  if (room) {
    await page.getByRole('button', {name:avatar, exact:true}).click();
    await page.locator('#name').fill(name);
    await page.locator('#join').click();
    await page.locator('#meeting').waitFor({state:'visible'});
  }
  return page;
}
async function count(page, number) {
  await page.waitForFunction(value => document.getElementById('count').textContent === value + ' / 10', number);
}
async function remoteScreenReady(page, id) {
  await page.waitForFunction(id => {
    const video = document.getElementById('video-screen-' + id)?.querySelector('video');
    return video && video.readyState >= 2 && video.videoWidth > 32 && video.videoHeight > 32 && !video.paused && screenReceiveHealth.get(id)?.received === true;
  }, id);
}
test('one name entry, avatar selection and dark full-height layout at desktop/mobile sizes', async t => {
  const page = await client(t);
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), 'favicon.svg?v=1');
  const icon = await page.request.get(baseURL + '/favicon.svg?v=1');
  assert.equal(icon.status(), 200);
  assert.match(icon.headers()['content-type'], /image\/svg\+xml/);
  assert.equal(await page.locator('#room').isVisible(), false);
  await page.locator('#create').click();
  await page.waitForURL('**/sala.html?**');
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), 'favicon.svg?v=1');
  assert.equal(await page.locator('#name').isVisible(), true);
  await page.getByRole('button', {name:'Raposa', exact:true}).click();
  await page.locator('#name').fill('Raposa teste');
  await page.locator('#join').click();
  await page.locator('#meeting').waitFor({state:'visible'});
  assert.equal(await page.locator('#welcome').isVisible(), false);
  assert.equal(await page.locator('.avatar-icon').textContent(), '🦊');
  for (const size of [{width:1920,height:1600}, {width:1280,height:720}, {width:390,height:844}]) {
    await page.setViewportSize(size);
    const layout = await page.evaluate(() => ({background:getComputedStyle(document.documentElement).backgroundColor, height:document.querySelector('main').getBoundingClientRect().height, viewport:innerHeight, overflow:document.documentElement.scrollWidth > innerWidth}));
    assert.equal(layout.background, 'rgb(16, 20, 18)');
    assert.ok(layout.height >= layout.viewport - 1);
    assert.equal(layout.overflow, false);
  }
  await page.setViewportSize({width:1366,height:900});
  await page.screenshot({path:'test-results/avatar-room.png',fullPage:true});
});
test('two simultaneous screen streams, late join, avatars, mic/camera state and restart over real WebRTC', {timeout:90000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true, 'Anfitrião', 'Raposa');
  const guest = await client(t, room, false, 'Convidado', 'Panda');
  await count(host, 2); await count(guest, 2);
  const hostId = await host.evaluate(() => peer.id), guestId = await guest.evaluate(() => peer.id);
  await host.evaluate(id => { window.__initialPC = calls.get(id).peerConnection; }, guestId);
  await guest.evaluate(id => { window.__initialPC = calls.get(id).peerConnection; }, hostId);
  try { await host.locator('#video-' + guestId + ' .avatar-icon').waitFor({timeout:8000}); }
  catch (err) {
    for (const page of [host,guest]) console.log(JSON.stringify(await page.evaluate(() => ({links:Array.from(mediaLinks, ([id,link]) => ({id,pc:link.call.peerConnection?.connectionState,dc:link.control?.readyState,actualDC:link.call.dataChannel?.readyState,layout:link.remoteLayout,local:link.localLayout,remote:link.remoteStream?.getTracks().map(track => ({id:track.id,kind:track.kind})),participant:link.participantStream.getTracks().length})),notice:document.getElementById('notice').textContent})), null, 2));
    throw err;
  }
  assert.equal(await host.locator('#video-' + guestId + ' .avatar-icon').textContent(), '🐼');
  await guest.locator('#mic').click();
  await host.waitForFunction(id => document.getElementById('video-' + id)?.querySelector('.tile-name').textContent.includes('🔇'), guestId);
  await guest.locator('#camera').click();
  await host.locator('#video-' + guestId + '.camera-visible').waitFor();
  await guest.locator('#camera').click();
  await host.waitForFunction(id => !document.getElementById('video-' + id).classList.contains('camera-visible'), guestId);
  await host.locator('#screen').click(); await remoteScreenReady(guest, hostId);
  await guest.locator('#screen').click(); await remoteScreenReady(host, guestId);
  const later = await client(t, room, false, 'Entrou depois', 'Robô');
  await count(later, 3); await remoteScreenReady(later, hostId); await remoteScreenReady(later, guestId);
  const stats = await guest.evaluate(async id => mediaLinks.get(id).stats('screenVideo','inbound'), hostId);
  assert.ok(stats.frames > 0, 'Remote screen frames were decoded');
  const samePC = await guest.evaluate(id => ({same:calls.get(id).peerConnection === window.__initialPC,policy:calls.get(id).peerConnection.getConfiguration().bundlePolicy,transceivers:calls.get(id).peerConnection.getTransceivers().length}), hostId);
  assert.deepEqual(samePC, {same:true,policy:'max-bundle',transceivers:4});
  await guest.locator('#video-screen-' + hostId + ' input').fill('150');
  await guest.locator('#video-' + hostId + ' input').fill('25');
  const volumes = await guest.evaluate(id => [audioNodes.get('screen-' + id).gain.gain.value, audioNodes.get(id).gain.gain.value], hostId);
  assert.deepEqual(volumes, [1.5, 0.25]);
  await host.locator('#video-screen-' + guestId + ' .feature-button').click();
  await host.screenshot({path:'test-results/shared-room.png',fullPage:true});
  await host.setViewportSize({width:390,height:844});
  await host.screenshot({path:'test-results/mobile-room.png',fullPage:true});
  const mobileOverflow = await host.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(mobileOverflow, false);
  await host.locator('#screen').click();
  await guest.locator('#video-screen-' + hostId).waitFor({state:'detached'});
  await host.locator('#screen').click(); await remoteScreenReady(guest, hostId);
  assert.equal(await host.evaluate(id => calls.get(id).peerConnection === window.__initialPC, guestId), true);
  assert.equal(await guest.evaluate(id => calls.get(id).peerConnection === window.__initialPC, hostId), true);
  await host.locator('#leave').click();
  await host.locator('#welcome').waitFor({state:'visible'});
  const clean = await host.evaluate(() => [profiles.size, mediaLinks.size, screenSendHealth.size, screenReceiveHealth.size, voiceMonitors.size, placeholderTimer, displayStream,screenPlaceholder,silentTrack,silentContext]);
  assert.deepEqual(clean, [0,0,0,0,0,null,null,null,null,null]);
});
test('capture error offers a manual compatible retry, without experimental audio options', async t => {
  const room = 'test' + Date.now();
  const page = await client(t, room, true), guest = await client(t, room);
  await count(page, 2);
  await page.evaluate(() => { window.__captureMode = 'fail-audio'; });
  await page.locator('#screen').click();
  await page.getByRole('button', {name:'Tentar modo compatível (sem áudio)', exact:true}).waitFor();
  assert.match(await page.locator('#notice').textContent(), /NotReadableError/);
  assert.equal(await page.evaluate(() => window.__captureOptions.length), 1);
  await page.getByRole('button', {name:'Tentar modo compatível (sem áudio)', exact:true}).click();
  await page.locator('#video-screen-local').waitFor();
  const options = await page.evaluate(() => window.__captureOptions);
  assert.equal(options[0].video.frameRate.ideal, 60);
  assert.equal('windowAudio' in options[0], false);
  assert.deepEqual(options[1], {video:true,audio:false});
  assert.equal(await page.locator('#screen').isDisabled(), false);
  await remoteScreenReady(guest, await page.evaluate(() => peer.id));
});
test('denied and unsupported capture have actionable errors and no automatic retry', async t => {
  const page = await client(t, 'test' + Date.now(), true);
  await page.evaluate(() => { window.__captureMode = 'denied'; });
  await page.locator('#screen').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('NotAllowedError'));
  assert.equal(await page.locator('.notice-action').count(), 0);
  assert.equal(await page.evaluate(() => window.__captureOptions.length), 1);
  await page.evaluate(() => { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {configurable:true,value:undefined}); });
  await page.locator('#screen').click();
  assert.match(await page.locator('#notice').textContent(), /não oferece compartilhamento/);
});
test('leaving during the screen picker stops late tracks and does not reopen the share', async t => {
  const page = await client(t, 'test' + Date.now(), true);
  await page.evaluate(() => { window.__captureMode = 'deferred'; });
  await page.locator('#screen').click();
  await page.waitForFunction(() => !!window.__finishCapture);
  await page.locator('#leave').click();
  await page.evaluate(() => window.__finishCapture());
  await page.waitForFunction(() => window.__lateStream.getTracks().every(track => track.readyState === 'ended'));
  assert.equal(await page.locator('#video-screen-local').count(), 0);
});
test('one recipient failing never tears down a successfully captured screen', async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true), guest = await client(t, room), healthy = await client(t, room);
  await count(host, 3);
  const guestId = await guest.evaluate(() => peer.id), hostId = await host.evaluate(() => peer.id);
  await host.waitForFunction(() => mediaLinks.size === 2);
  await host.evaluate(id => { const link = mediaLinks.get(id), original = link.replaceSlot.bind(link); link.replaceSlot = (slot,track) => { if (slot === 'screenVideo' && track !== screenPlaceholder) return Promise.reject(new Error('Simulated recipient failure')); return original(slot,track); }; }, guestId);
  await host.locator('#screen').click();
  await host.locator('#video-screen-local').waitFor();
  await remoteScreenReady(healthy, hostId);
  assert.equal(await host.evaluate(() => displayStream.getVideoTracks()[0].readyState), 'live');
  assert.match(await host.locator('#screen').textContent(), /Parar/);
  assert.match(await host.locator('#notice').textContent(), /captura continua ativa/);
});

async function blockScreenVideo(page, target, everyAttempt = false) {
  await page.evaluate(({target, everyAttempt}) => {
    const link = mediaLinks.get(target), original = link.replaceSlot.bind(link); window.__screenAttempts = [];
    link.replaceSlot = (slot, track) => {
      if (slot === 'screenVideo' && track !== screenPlaceholder) {
        window.__screenAttempts.push(link.desired.transfer);
        if (everyAttempt || window.__screenAttempts.length === 1) return original(slot, null);
      }
      return original(slot, track);
    };
  }, {target, everyAttempt});
}
async function connectedWithoutFrames(page, senderId) {
  await page.waitForFunction(id => {
    const health = screenReceiveHealth.get(id);
    return health?.stats?.connection === 'connected' && health.stats.frames === 0 && !health.received;
  }, senderId);
}
async function triggerScreenTimeout(receiver, sender, senderId, receiverId) {
  // Advance only the watchdog's elapsed time, not media playback/permission time.
  await sender.evaluate(id => { mediaLinks.get(id).lastRetryAt = 0; }, receiverId);
  await receiver.evaluate(id => { screenReceiveHealth.get(id).startedAt -= SCREEN_CONNECT_TIMEOUT + 1; }, senderId);
}
test('one-way screen failure reconnects without recapturing or interrupting the opposite stream', {timeout:60000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true, 'Envia com falha'), guest = await client(t, room, false, 'Recebe');
  await count(host, 2);
  const hostId = await host.evaluate(() => peer.id), guestId = await guest.evaluate(() => peer.id);
  await blockScreenVideo(host, guestId);
  await guest.locator('#screen').click(); await remoteScreenReady(host, guestId);
  await host.locator('#screen').click(); await connectedWithoutFrames(guest, hostId);
  await guest.locator('#video-screen-' + hostId + ' input').fill('150');
  await guest.locator('#video-screen-' + hostId + ' .feature-button').click();
  const captureTrack = await host.evaluate(() => displayStream.getVideoTracks()[0].id);
  await triggerScreenTimeout(guest, host, hostId, guestId);
  await host.waitForFunction(id => screenSendHealth.get(id)?.confirmed === true && screenSendHealth.get(id)?.limitsApplied === true, guestId);
  await remoteScreenReady(guest, hostId); await remoteScreenReady(host, guestId);
  assert.equal(await host.evaluate(() => window.__screenAttempts.length), 2);
  assert.equal(await host.evaluate(() => window.__captureOptions.length), 1);
  assert.equal(await host.evaluate(() => displayStream.getVideoTracks()[0].id), captureTrack);
  assert.equal(await guest.locator('#video-screen-' + hostId + ' input').inputValue(), '150');
  assert.equal(await guest.locator('#video-screen-' + hostId).evaluate(tile => tile.classList.contains('featured')), true);
  const repaired = await host.evaluate(id => ({codec:screenSendHealth.get(id).stats.codec, compatible:screenSendHealth.get(id).compatible, report:screenDiagnosticReport()}), guestId);
  assert.equal(repaired.compatible, true);
  assert.equal(repaired.codec.toLowerCase(), 'video/vp8');
  assert.equal(repaired.report.sending[0].confirmed, true);
  assert.equal(/candidate|ipAddress|sdp|password|deviceId/.test(JSON.stringify(repaired.report)), false);
  // A late acknowledgement for the failed connection cannot confirm its replacement.
  const stale = await host.evaluate(async id => {
    const health = screenSendHealth.get(id); health.confirmed = false;
    await mediaLinks.get(id).handleMessage(JSON.stringify({protocol:CamposMediaLink.protocol,type:'seen',session:screenSession,transfer:window.__screenAttempts[0]}));
    return health.confirmed;
  }, guestId);
  assert.equal(stale, false);
});
test('automatic screen recovery stops after two retries and stop clears a failed receiver', {timeout:60000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true), guest = await client(t, room);
  await count(host, 2);
  const hostId = await host.evaluate(() => peer.id), guestId = await guest.evaluate(() => peer.id);
  await blockScreenVideo(host, guestId, true);
  await host.locator('#screen').click();
  for (let attempt = 0; attempt < 2; attempt++) {
    await connectedWithoutFrames(guest, hostId);
    await triggerScreenTimeout(guest, host, hostId, guestId);
    await host.waitForFunction(number => window.__screenAttempts.length === number, attempt + 2);
    const transfer = await host.evaluate(() => window.__screenAttempts.at(-1));
    await guest.waitForFunction(({id, transfer}) => screenReceiveHealth.get(id)?.transfer === transfer, {id:hostId, transfer});
  }
  await connectedWithoutFrames(guest, hostId);
  await triggerScreenTimeout(guest, host, hostId, guestId);
  await guest.waitForFunction(id => screenReceiveHealth.get(id)?.status.includes('Não chegou imagem'), hostId);
  assert.equal(await host.evaluate(() => window.__screenAttempts.length), 3);
  assert.equal(await guest.locator('#video-screen-' + hostId + ' .screen-retry').isVisible(), true);
  await host.locator('#screen').click();
  await guest.locator('#video-screen-' + hostId).waitFor({state:'detached'});
  assert.equal(await guest.evaluate(id => screenReceiveHealth.has(id), hostId), false);
  assert.equal(await host.evaluate(() => screenSendHealth.size), 0);
});
test('screen recovery between two guests uses their media link and does not change other recipients', {timeout:60000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true), sender = await client(t, room, false, 'Transmite'), receiver = await client(t, room, false, 'Assiste');
  await count(sender, 3); await count(receiver, 3);
  const hostId = await host.evaluate(() => peer.id), senderId = await sender.evaluate(() => peer.id), receiverId = await receiver.evaluate(() => peer.id);
  await blockScreenVideo(sender, receiverId);
  await sender.locator('#screen').click();
  await remoteScreenReady(host, senderId); await connectedWithoutFrames(receiver, senderId);
  await triggerScreenTimeout(receiver, sender, senderId, receiverId);
  await remoteScreenReady(receiver, senderId);
  await sender.waitForFunction(id => screenSendHealth.get(id)?.confirmed, receiverId);
  assert.equal(await sender.evaluate(id => screenSendHealth.get(id).compatible, receiverId), true);
  assert.equal(await sender.evaluate(id => screenSendHealth.get(id).compatible, hostId), false);
  assert.equal(await sender.evaluate(() => window.__captureOptions.length), 1);
});
test('camera, microphone and live audio/video stay separate on one unchanged ICE transport', {timeout:60000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true), guest = await client(t, room);
  await count(host, 2);
  const hostId = await host.evaluate(() => peer.id), guestId = await guest.evaluate(() => peer.id);
  await host.waitForFunction(id => mediaLinks.get(id)?.control?.readyState === 'open', guestId);
  await guest.waitForFunction(id => mediaLinks.get(id)?.control?.readyState === 'open', hostId);
  // Any regression to a separate media call must fail this test immediately.
  for (const [page,id] of [[host,guestId],[guest,hostId]]) await page.evaluate(id => { window.__savedMediaPC = calls.get(id).peerConnection; window.__savedCallCount = window.__mediaCalls; peer.call = () => { throw new Error('An extra media connection was attempted'); }; }, id);
  await host.evaluate(id => {
    const sender = mediaLinks.get(id).senders.screenVideo, original = sender.setParameters.bind(sender); window.__rejectedLimit = false;
    sender.setParameters = parameters => {
      if (!window.__rejectedLimit && parameters.encodings.some(encoding => encoding.active && encoding.maxFramerate === 60)) { window.__rejectedLimit = true; return Promise.reject(new DOMException('Unsupported limit for test','InvalidModificationError')); }
      return original(parameters);
    };
  }, guestId);
  await host.locator('#screen').click(); await remoteScreenReady(guest, hostId);
  assert.equal(await host.evaluate(() => window.__rejectedLimit), true);
  await host.locator('#camera').click(); await guest.locator('#video-' + hostId + '.camera-visible').waitFor();
  await guest.waitForFunction(id => {
    const video = document.querySelector('#video-' + id + ' video'), canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d'); ctx.drawImage(video,10,10,1,1,0,0,1,1); const rgb = ctx.getImageData(0,0,1,1).data;
    return rgb[2] > rgb[1] + 40;
  }, hostId);
  const sample = await guest.evaluate(id => {
    const pixel = selector => { const video = document.querySelector(selector); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const ctx = canvas.getContext('2d'); ctx.drawImage(video,10,10,1,1,0,0,1,1); return [...ctx.getImageData(0,0,1,1).data].slice(0,3); };
    const link = mediaLinks.get(id), pc = link.call.peerConnection, transports = pc.getTransceivers().map(item => item.sender.transport);
    return {camera:pixel('#video-' + id + ' video'),screen:pixel('#video-screen-' + id + ' video'),same:pc === window.__savedMediaPC,oneTransport:transports.every(transport => transport === transports[0]) && pc.sctp.transport === transports[0],cameraAudio:link.participantStream.getAudioTracks()[0].id,liveAudio:link.screenStream.getAudioTracks()[0].id};
  }, hostId);
  assert.equal(sample.same, true); assert.equal(sample.oneTransport, true);
  assert.notEqual(sample.cameraAudio, sample.liveAudio);
  assert.ok(sample.camera[2] > sample.camera[1] + 40, 'Camera contains the blue test pattern');
  assert.ok(sample.screen[1] > sample.screen[2] + 15, 'Live contains the green test pattern');
  await guest.evaluate(id => {
    const link = mediaLinks.get(id); window.__toneChecks = [link.participantStream,link.screenStream].map(stream => { const source = audioContext.createMediaStreamSource(stream), analyser = audioContext.createAnalyser(); analyser.fftSize = 4096; source.connect(analyser); return {source,analyser}; });
  }, hostId);
  await guest.waitForFunction(() => {
    const peaks = window.__toneChecks.map(({analyser}) => { const values = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(values); const max = Math.max(...values); return max ? values.indexOf(max) * audioContext.sampleRate / analyser.fftSize : 0; });
    return peaks[0] > 410 && peaks[0] < 470 && peaks[1] > 850 && peaks[1] < 910;
  });
  await host.locator('#mic').click();
  assert.equal(await host.evaluate(() => localStream.getAudioTracks()[0].enabled), false);
  assert.equal(await host.evaluate(() => displayStream.getAudioTracks()[0].enabled), true);
  await host.locator('#camera').click(); await host.locator('#screen').click();
  await guest.locator('#video-screen-' + hostId).waitFor({state:'detached'});
  await host.locator('#screen').click(); await remoteScreenReady(guest, hostId);
  await guest.locator('#screen').click(); await remoteScreenReady(host, guestId);
  await guest.locator('#video-screen-' + hostId + ' .screen-retry').click();
  await host.waitForFunction(id => screenSendHealth.get(id)?.compatible && screenSendHealth.get(id)?.confirmed, guestId);
  await guest.evaluate(async id => {
    const link = mediaLinks.get(id), transfer = link.remoteState.transfer;
    await link.handleMessage('null'); await link.handleMessage('[]'); await link.handleMessage('{');
    await link.handleMessage(JSON.stringify({protocol:CamposMediaLink.protocol,type:'state',revision:link.remoteRevision-1,layout:link.remoteLayout,screen:{phase:'off'}}));
    if (link.remoteState.transfer !== transfer) throw new Error('Stale state replaced the current screen');
  }, hostId);
  for (const [page,id] of [[host,guestId],[guest,hostId]]) assert.equal(await page.evaluate(id => calls.get(id).peerConnection === window.__savedMediaPC && window.__mediaCalls === window.__savedCallCount, id), true);
  await guest.evaluate(() => window.__toneChecks.forEach(({source,analyser}) => { source.disconnect(); analyser.disconnect(); }));
});
test('simultaneous joins connect every admitted peer before screens are attached', {timeout:60000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true);
  const [a,b] = await Promise.all([client(t, room, false, 'Pessoa A'),client(t, room, false, 'Pessoa B')]);
  for (const page of [host,a,b]) {
    await count(page, 3);
    await page.waitForFunction(() => mediaLinks.size === 2 && [...mediaLinks.values()].every(link => link.control?.readyState === 'open' && link.participantStream.getTracks().length === 2));
  }
  const aId = await a.evaluate(() => peer.id), bId = await b.evaluate(() => peer.id);
  await a.locator('#screen').click(); await b.locator('#screen').click();
  await remoteScreenReady(a,bId); await remoteScreenReady(b,aId);
  await remoteScreenReady(host,aId); await remoteScreenReady(host,bId);
});
test('an unadmitted media offer is never answered or given the active screen', {timeout:30000}, async t => {
  const room = 'test' + Date.now();
  const host = await client(t, room, true), guest = await client(t, room), outsider = await client(t);
  await count(host, 2);
  const hostId = await host.evaluate(() => peer.id);
  await host.locator('#screen').click(); await remoteScreenReady(guest, hostId);
  const outsiderId = await outsider.evaluate(hostId => new Promise(resolve => {
    const separatePeer = new Peer(); window.__outsiderPeer = separatePeer; separatePeer.on('error', () => {});
    separatePeer.on('open', id => {
      const media = window.__makeStream({video:true,audio:true}), video = media.getVideoTracks()[0], audio = media.getAudioTracks()[0];
      const pack = CamposMediaLink.pack({microphone:audio,camera:video,screenVideo:video.clone(),screenAudio:audio.clone()});
      window.__outsiderCall = separatePeer.call(hostId,pack.stream,{metadata:{mediaProtocol:CamposMediaLink.protocol}}); resolve(id);
    });
  }), hostId);
  await host.waitForFunction(id => pendingMediaCalls.has(id), outsiderId);
  assert.equal(await host.evaluate(id => mediaLinks.has(id) || members.has(id), outsiderId), false);
  await host.waitForFunction(id => !pendingMediaCalls.has(id), outsiderId);
  assert.equal(await host.evaluate(() => mediaLinks.size), 1);
  assert.equal(await outsider.evaluate(() => __outsiderCall.peerConnection.remoteDescription), null);
  await remoteScreenReady(guest,hostId);
});
test('compatible SDP keeps audio, fallback codecs and RTX associations intact', async t => {
  const page = await client(t);
  const sdp = ['v=0','m=audio 9 UDP/TLS/RTP/SAVPF 111','a=rtpmap:111 opus/48000/2','m=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97','a=rtpmap:102 H264/90000','a=rtpmap:103 rtx/90000','a=fmtp:103 apt=102','a=rtpmap:96 VP8/90000','a=rtpmap:97 rtx/90000','a=fmtp:97 apt=96','m=application 9 UDP/DTLS/SCTP webrtc-datachannel',''].join('\r\n');
  const transformed = await page.evaluate(sdp => preferScreenVP8(sdp), sdp);
  assert.equal(transformed, sdp.replace('m=video 9 UDP/TLS/RTP/SAVPF 102 103 96 97','m=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103'));
  const noVP8 = sdp.replace('VP8/90000', 'VP9/90000');
  assert.equal(await page.evaluate(sdp => preferScreenVP8(sdp), noVP8), noVP8);
});

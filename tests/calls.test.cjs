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
  await context.route('https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', route => route.fulfill({contentType:'text/javascript', body:peerSource + `\n{const OriginalPeer=window.Peer;window.Peer=class extends OriginalPeer{constructor(id){super(id,{host:'127.0.0.1',port:${signalPort},secure:false,path:'/',config:{iceServers:[]}})}};}`}));
  await context.addInitScript(() => {
    window.__captureOptions = [];
    window.__captureMode = 'normal';
    window.__makeStream = ({video = false, audio = false}) => {
      const tracks = [];
      if (audio) {
        const ctx = new AudioContext(), oscillator = ctx.createOscillator(), gain = ctx.createGain(), destination = ctx.createMediaStreamDestination();
        gain.gain.value = 0.01; oscillator.connect(gain).connect(destination); oscillator.start(); ctx.resume(); tracks.push(...destination.stream.getAudioTracks());
      }
      if (video) {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d'); let frame = 0;
        const paint = () => { ctx.fillStyle = '#21573c'; ctx.fillRect(0,0,640,360); ctx.fillStyle = '#fff'; ctx.font = '28px sans-serif'; ctx.fillText('Transmissão de teste ' + frame++, 50,180); };
        paint(); const track = canvas.captureStream(15).getVideoTracks()[0];
        const timer = setInterval(() => { if (track.readyState === 'ended') clearInterval(timer); else paint(); }, 65);
        tracks.push(track);
      }
      return new MediaStream(tracks);
    };
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {configurable:true, value:async options => window.__makeStream(options)});
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
    return video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused;
  }, id);
}
test('one name entry, avatar selection and dark full-height layout at desktop/mobile sizes', async t => {
  const page = await client(t);
  assert.equal(await page.locator('#room').isVisible(), false);
  await page.locator('#create').click();
  await page.waitForURL('**/sala.html?**');
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
  await host.locator('#video-' + guestId + ' .avatar-icon').waitFor();
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
  const stats = await guest.evaluate(async id => {
    const reports = await incomingScreenAudio.get(id).peerConnection.getStats();
    return Array.from(reports.values()).filter(report => report.type === 'inbound-rtp' && report.kind === 'video').map(report => report.framesDecoded);
  }, hostId);
  assert.ok(stats.some(frames => frames > 0), 'Remote screen frames were decoded');
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
  await host.locator('#leave').click();
  await host.locator('#welcome').waitFor({state:'visible'});
  const clean = await host.evaluate(() => [profiles.size, screenAudioCalls.size, incomingScreenAudio.size, voiceMonitors.size, placeholderTimer, displayStream]);
  assert.deepEqual(clean, [0,0,0,0,null,null]);
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
  const host = await client(t, room, true), guest = await client(t, room);
  await count(host, 2);
  await host.waitForFunction(() => calls.size === 1);
  await host.evaluate(() => { const original = peer.call.bind(peer); peer.call = (id, stream, options) => { if (options?.metadata?.kind === 'screen-stream') throw new Error('Simulated recipient failure'); return original(id,stream,options); }; });
  await host.locator('#screen').click();
  await host.locator('#video-screen-local').waitFor();
  assert.equal(await host.evaluate(() => displayStream.getVideoTracks()[0].readyState), 'live');
  assert.match(await host.locator('#screen').textContent(), /Parar/);
  assert.match(await host.locator('#notice').textContent(), /compartilhamento continua ativo/);
});

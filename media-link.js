// Four reserved RTP tracks share one PeerJS MediaConnection and its ICE/DTLS
// transport. Screen changes use replaceTrack(), never a second peer.call().
(() => {
  const SLOTS = {microphone:'audio', camera:'video', screenVideo:'video', screenAudio:'audio'};
  const PROTOCOL = 3;
  function pack(tracks) {
    const layout = {};
    for (const [slot, kind] of Object.entries(SLOTS)) {
      if (tracks[slot]?.kind !== kind) throw new Error('Faixa de mídia ausente: ' + slot);
      layout[slot] = tracks[slot].id;
    }
    return {stream:new MediaStream(Object.keys(SLOTS).map(slot => tracks[slot])), layout};
  }
  function validLayout(layout) {
    return layout && typeof layout === 'object' && !Array.isArray(layout) && Object.keys(layout).length === 4 && Object.keys(SLOTS).every(slot => typeof layout[slot] === 'string' && layout[slot].length > 0 && layout[slot].length <= 200) && new Set(Object.values(layout)).size === 4;
  }
  class MediaLink {
    static protocol = PROTOCOL;
    static pack = pack;
    constructor(call, localPack, idleTracks, callbacks = {}) {
      this.call = call;
      this.localLayout = localPack.layout;
      this.idleTracks = idleTracks;
      this.callbacks = callbacks;
      this.senders = {};
      this.slotQueues = {};
      this.screenEpoch = 0;
      this.recoveryCount = 0;
      this.revision = 0;
      this.remoteRevision = -1;
      this.remoteState = null;
      this.closed = false;
      this.desired = {stream:null, session:null, transfer:'', compatible:false};
      this.participantStream = new MediaStream();
      this.screenStream = new MediaStream();
      this.onRemoteTrack = () => this.refreshRemote();
      this.onMessage = event => { this.handleMessage(event.data).catch(err => this.callbacks.onError?.(err)); };
      call.on('stream', stream => this.attachRemote(stream));
      call.on('willCloseOnRemote', () => this.openControl().catch(err => this.callbacks.onError?.(err)));
    }
    bind() {
      for (const slot of Object.keys(SLOTS)) this.senders[slot] = this.call.peerConnection?.getSenders().find(sender => sender.track?.id === this.localLayout[slot]);
      if (Object.values(this.senders).some(sender => !sender)) throw new Error('Não foi possível reservar as faixas da chamada.');
      if (this.call.dataChannel?.readyState === 'open') this.openControl().catch(err => this.callbacks.onError?.(err));
    }
    async openControl() {
      if (this.closed || this.control === this.call.dataChannel) return;
      this.control = this.call.dataChannel;
      this.control.addEventListener('message', this.onMessage);
      await this.configureScreen(false);
      if (this.closed) return;
      this.sendState('off'); // Also exchanges RTP slots for microphone/camera.
      const desired = this.desired;
      if (desired.stream) this.setScreen(desired.stream, desired.session, desired.compatible, true).catch(err => this.callbacks.onError?.(err));
    }
    send(packet) {
      if (this.closed || this.control?.readyState !== 'open') return false;
      try { this.control.send(JSON.stringify({protocol:PROTOCOL, ...packet})); return true; } catch { return false; }
    }
    sendState(phase) {
      const desired = this.desired;
      // Track IDs can be rewritten by browsers. Negotiated MID values identify
      // each RTP slot consistently at both ends, including after replaceTrack.
      const transceivers = this.call.peerConnection?.getTransceivers() || [];
      const layout = Object.fromEntries(Object.keys(SLOTS).map(slot => [slot, transceivers.find(item => item.sender === this.senders[slot])?.mid]));
      if (!validLayout(layout)) return false;
      return this.send({type:'state', revision:++this.revision, layout, screen:{phase,session:desired.session,transfer:desired.transfer,compatible:desired.compatible,hasAudio:!!desired.stream?.getAudioTracks().length}});
    }
    cancelPending() {
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.resolve(false); this.pending = null; }
    }
    async setScreen(stream, session, compatible = false, force = false) {
      if (this.closed) return;
      if (!force && stream === this.desired.stream && session === this.desired.session) return;
      this.cancelPending();
      const epoch = ++this.screenEpoch;
      if (session !== this.desired.session) this.recoveryCount = 0;
      this.desired = {stream, session, compatible, attempt:this.recoveryCount, transfer:stream ? crypto.randomUUID() : ''};
      const desired = this.desired;
      if (!stream) {
        this.sendState('off');
        await this.configureScreen(false);
        await Promise.all([this.replaceSlot('screenVideo', this.idleTracks.screenVideo), this.replaceSlot('screenAudio', this.idleTracks.screenAudio)]);
        return;
      }
      const baseline = await this.stats('screenVideo', 'outbound');
      if (this.closed || epoch !== this.screenEpoch) return;
      this.callbacks.onLocalScreen?.({...desired, phase:'prepare', baseline});
      if (this.control?.readyState !== 'open') return; // Resumed when control opens.
      // Pause only the screen sender while the receiver records its counters.
      // The microphone, camera and opposite screen never stop.
      await this.configureScreen(false);
      await this.replaceSlot('screenVideo', this.idleTracks.screenVideo);
      if (this.closed || epoch !== this.screenEpoch) return;
      const accepted = new Promise(resolve => {
        const timer = setTimeout(() => { if (this.pending?.epoch === epoch) this.pending = null; resolve(false); }, 6000);
        this.pending = {epoch, session, transfer:desired.transfer, resolve, timer};
      });
      if (!this.sendState('prepare')) { this.cancelPending(); this.callbacks.onLocalScreen?.({...desired,phase:'error',baseline}); return; }
      if (!await accepted || this.closed || epoch !== this.screenEpoch) {
        if (!this.closed && epoch === this.screenEpoch) this.callbacks.onLocalScreen?.({...desired, phase:'error', baseline});
        return;
      }
      await Promise.all([
        this.replaceSlot('screenVideo', stream.getVideoTracks()[0]),
        this.replaceSlot('screenAudio', stream.getAudioTracks()[0] || this.idleTracks.screenAudio)
      ]);
      if (this.closed || epoch !== this.screenEpoch) return;
      const limitsApplied = await this.configureScreen(true, compatible);
      if (this.closed || epoch !== this.screenEpoch) return;
      this.sendState('live');
      this.callbacks.onLocalScreen?.({...desired, phase:'live', baseline, limitsApplied});
    }
    replaceSlot(slot, track) {
      const operation = (this.slotQueues[slot] || Promise.resolve()).then(async () => {
        if (this.closed) return;
        const sender = this.senders[slot];
        if (!sender) throw new Error('Faixa não negociada: ' + slot);
        if (sender.track !== track) await sender.replaceTrack(track);
      });
      this.slotQueues[slot] = operation.catch(() => {});
      return operation;
    }
    configureScreen(active, compatible = false) {
      const operation = (this.configurationQueue || Promise.resolve()).then(() => this.applyScreenConfiguration(active, compatible));
      this.configurationQueue = operation.catch(() => {});
      return operation;
    }
    async applyScreenConfiguration(active, compatible = false) {
      const sender = this.senders.screenVideo;
      if (!sender || this.closed) return false;
      try {
        const parameters = sender.getParameters();
        if (!parameters.encodings?.length) return false;
        const settings = sender.track?.getSettings() || {};
        for (const encoding of parameters.encodings) {
          encoding.active = active;
          encoding.maxFramerate = compatible ? 30 : 60;
          encoding.maxBitrate = compatible ? 2500000 : 6000000;
          encoding.scaleResolutionDownBy = compatible ? Math.max(1, (settings.width || 1280) / 1280, (settings.height || 720) / 720) : 1;
        }
        await sender.setParameters(parameters);
        return true;
      } catch (err) {
        // Do not leave a valid screen sender disabled merely because a browser
        // rejects a bitrate/framerate limit after the source is replaced.
        try {
          const fallback = sender.getParameters();
          if (fallback.encodings?.length) {
            for (const encoding of fallback.encodings) { encoding.active = active; delete encoding.maxFramerate; delete encoding.maxBitrate; delete encoding.scaleResolutionDownBy; }
            await sender.setParameters(fallback);
          }
        } catch { /* The caller's diagnostics still report unapplied limits. */ }
        this.callbacks.onWarning?.(err); return false;
      }
    }
    attachRemote(stream) {
      if (this.closed) return;
      if (this.remoteStream !== stream) {
        this.remoteStream?.removeEventListener('addtrack', this.onRemoteTrack);
        this.remoteStream?.removeEventListener('removetrack', this.onRemoteTrack);
        this.remoteStream = stream;
        stream.addEventListener('addtrack', this.onRemoteTrack);
        stream.addEventListener('removetrack', this.onRemoteTrack);
      }
      this.refreshRemote();
    }
    syncStream(stream, slots) {
      const transceivers = this.call.peerConnection?.getTransceivers() || [];
      const tracks = slots.map(slot => { const track = transceivers.find(item => item.mid === this.remoteLayout?.[slot])?.receiver.track; return track?.kind === SLOTS[slot] ? track : null; }).filter(Boolean);
      let changed = false;
      for (const track of stream.getTracks()) if (!tracks.includes(track)) { stream.removeTrack(track); changed = true; }
      for (const track of tracks) if (!stream.getTracks().includes(track)) { stream.addTrack(track); changed = true; }
      return changed;
    }
    refreshRemote() {
      if (this.closed || !this.remoteLayout || !this.remoteStream) return;
      const changed = this.syncStream(this.participantStream, ['microphone','camera']);
      this.syncStream(this.screenStream, ['screenVideo','screenAudio']);
      if (changed && this.participantStream.getTracks().length) this.callbacks.onParticipant?.(this.participantStream);
      if (this.remoteState?.baselineReady) this.callbacks.onRemoteScreen?.(this.remoteState, this.screenStream);
    }
    async handleMessage(raw) {
      if (this.closed || typeof raw !== 'string' || raw.length > 8000) return;
      let packet; try { packet = JSON.parse(raw); } catch { return; }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet) || packet.protocol !== PROTOCOL) return;
      if (packet.type === 'state') {
        if (!Number.isSafeInteger(packet.revision) || packet.revision <= this.remoteRevision || !validLayout(packet.layout)) return;
        const state = packet.screen;
        if (!state || !['off','prepare','live'].includes(state.phase)) return;
        if (state.phase !== 'off' && (typeof state.session !== 'string' || state.session.length > 80 || typeof state.transfer !== 'string' || state.transfer.length > 80)) return;
        this.remoteRevision = packet.revision; this.remoteLayout = packet.layout;
        const old = this.remoteState;
        const next = {phase:state.phase, session:state.session, transfer:state.transfer, compatible:state.compatible === true, hasAudio:state.hasAudio === true};
        this.remoteState = next;
        if (state.phase === 'off') { next.baselineReady = true; this.callbacks.onRemoteScreen?.(next, this.screenStream); }
        else {
          next.baseline = old?.session === state.session && old.transfer === state.transfer ? old.baseline : await this.stats('screenVideo', 'inbound');
          if (this.closed || this.remoteState !== next) return;
          next.baselineReady = true;
          if (state.phase === 'prepare') this.send({type:'accepted',session:state.session,transfer:state.transfer});
        }
        this.refreshRemote();
      } else if (packet.type === 'accepted') {
        const pending = this.pending;
        if (pending && pending.session === packet.session && pending.transfer === packet.transfer) { this.pending = null; clearTimeout(pending.timer); pending.resolve(true); }
      } else if (packet.type === 'seen') {
        if (this.desired.stream && packet.session === this.desired.session && packet.transfer === this.desired.transfer) this.callbacks.onConfirmed?.(packet);
      } else if (packet.type === 'retry') {
        if (!this.desired.stream || packet.session !== this.desired.session || packet.transfer !== this.desired.transfer) return;
        if (this.lastRetryAt && Date.now() - this.lastRetryAt < 2000) return;
        this.lastRetryAt = Date.now(); this.recoveryCount++;
        this.setScreen(this.desired.stream, this.desired.session, true, true).catch(err => this.callbacks.onError?.(err));
      }
    }
    retryScreen() {
      const state = this.remoteState;
      return state?.phase !== 'off' && this.send({type:'retry',session:state?.session,transfer:state?.transfer});
    }
    confirmScreen(session, transfer) { return this.send({type:'seen',session,transfer}); }
    async stats(slot, direction) {
      const pc = this.call.peerConnection;
      if (!pc || this.closed || pc.connectionState === 'closed') return {connection:'closed',frames:0,bytes:0};
      const transceiver = pc.getTransceivers().find(item => direction === 'outbound' ? item.sender === this.senders[slot] : item.mid === this.remoteLayout?.[slot]);
      const endpoint = direction === 'outbound' ? transceiver?.sender : transceiver?.receiver;
      if (!endpoint) return {connection:pc.connectionState,ice:pc.iceConnectionState,frames:0,bytes:0};
      const reports = typeof endpoint.getStats === 'function' ? await endpoint.getStats() : await pc.getStats(endpoint.track);
      const media = Array.from(reports.values()).filter(report => report.type === direction + '-rtp' && !report.isRemote && (report.kind || report.mediaType) === SLOTS[slot] && (report.mid === undefined || transceiver.mid === null || report.mid === transceiver.mid));
      const codec = reports.get(media[0]?.codecId);
      return {connection:pc.connectionState,ice:pc.iceConnectionState,frames:media.reduce((sum, report) => sum + (report[direction === 'outbound' ? 'framesEncoded' : 'framesDecoded'] || 0),0),bytes:media.reduce((sum, report) => sum + (report[direction === 'outbound' ? 'bytesSent' : 'bytesReceived'] || 0),0),width:media[0]?.frameWidth || 0,height:media[0]?.frameHeight || 0,codec:codec?.mimeType || 'não informado',limitation:media[0]?.qualityLimitationReason,counterKey:media.map(report => report.id).sort().join(',')};
    }
    dispose() {
      if (this.closed) return;
      this.closed = true; this.cancelPending(); this.screenEpoch++;
      this.control?.removeEventListener('message', this.onMessage);
      this.remoteStream?.removeEventListener('addtrack', this.onRemoteTrack);
      this.remoteStream?.removeEventListener('removetrack', this.onRemoteTrack);
      // Receiver/sender tracks belong to the call/capture, not to this view.
    }
  }
  window.CamposMediaLink = MediaLink;
})();

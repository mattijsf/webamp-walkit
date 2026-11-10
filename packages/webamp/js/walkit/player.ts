import * as Actions from "../actionCreators";
import * as Selectors from "../selectors";
import { BANDS, MEDIA_STATUS } from "../constants";
import { AppState, Dispatch } from "../types";
import { PlayerState, Runtime } from "walkit-web";

const STATUS: { [status: string]: PlayerState["status"] } = {
  [MEDIA_STATUS.PLAYING]: "playing",
  [MEDIA_STATUS.PAUSED]: "paused",
};

// walkit's classic vis steps every 25 ms; hearing more often draws nothing new
const VIS_FRAME_MS = 24;

const to255 = (v: number) => Math.round((v * 255) / 100);
const from255 = (v: number) => Math.round((v * 100) / 255);

export function playerState(state: AppState): PlayerState {
  const sliders = Selectors.getSliders(state) as any;
  return {
    status: STATUS[Selectors.getMediaStatus(state)] || "stopped",
    positionMs: Math.round(Selectors.getTimeElapsed(state) * 1000),
    lengthMs: Math.round((Selectors.getDuration(state) || 0) * 1000),
    title: Selectors.getCurrentTrackDisplayName(state) || "",
    trackIndex: Math.max(0, Selectors.getCurrentTrackIndex(state)),
    kbps: parseInt(Selectors.getKbps(state) || "0", 10) || 0,
    khz: parseInt(Selectors.getKhz(state) || "0", 10) || 0,
    channels: Selectors.getChannels(state) || 2,
    volume: to255(Selectors.getVolume(state)),
    pan: Math.round((Selectors.getBalance(state) * 127) / 100),
    shuffle: Selectors.getShuffle(state),
    repeat: Selectors.getRepeat(state),
    eqOn: Selectors.getEqualizerEnabled(state),
    preamp: to255(sliders.preamp),
    bands: BANDS.map((b) => to255(sliders[b])),
  };
}

export class PlayerFeed {
  private spectrum = new Float32Array(75);
  private wave = new Float32Array(576);
  private freq = new Uint8Array(0);
  private time = new Float32Array(0);
  private order: unknown = null;
  private tracks: unknown = null;
  private selOrder: unknown = null;
  private selTracks: unknown = null;
  private sent = "";
  private silent = false;
  private heardAt = -Infinity;

  private analyser: AnalyserNode;

  // its own, smaller analyser on webamp's: 75 bands and 576 samples need no 2048-point FFT
  constructor(private rt: Runtime, source: AnalyserNode) {
    this.analyser = source.context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0;
    source.connect(this.analyser);
  }

  dispose() {
    this.analyser.disconnect();
  }

  /** What the store says the player does, when it changed. */
  push(state: AppState) {
    const s = playerState(state);
    const key = JSON.stringify(s);
    if (key !== this.sent) {
      this.sent = key;
      this.rt.setPlayerState(s);
    }
    this.pushTracks(state);
    this.pushSelection(state);
  }

  private pushTracks(state: AppState) {
    const { trackOrder } = state.playlist;
    if (trackOrder === this.order && state.tracks === this.tracks) return;
    this.order = trackOrder;
    this.tracks = state.tracks;
    const name = Selectors.getTrackDisplayName(state);
    this.rt.setPlaylist(
      trackOrder.map((id) => ({
        title: name(id) || "",
        lengthMs: (state.tracks[id]?.duration || 0) * 1000,
      }))
    );
  }

  // the skin's playlist shows one selected entry: the first of the store's, or none
  private pushSelection(state: AppState) {
    const { trackOrder, selectedTracks } = state.playlist;
    if (trackOrder === this.selOrder && selectedTracks === this.selTracks) {
      return;
    }
    this.selOrder = trackOrder;
    this.selTracks = selectedTracks;
    const selected = new Set(selectedTracks);
    const index = trackOrder.findIndex((id) => selected.has(id));
    this.rt.setPlaylistSelection(index < 0 ? null : index);
  }

  /** What the analyser hears: 75 bands spaced by octaves, 576 samples and a VU level, as Winamp hands a visualizer. */
  hear(playing: boolean, now: number) {
    if (playing && now - this.heardAt < VIS_FRAME_MS) return;
    this.heardAt = now;
    if (!playing) {
      if (!this.silent) this.rt.setVis();
      this.silent = true;
      return;
    }
    this.silent = false;
    const { analyser } = this;
    if (this.freq.length !== analyser.frequencyBinCount) {
      this.freq = new Uint8Array(analyser.frequencyBinCount);
      this.time = new Float32Array(analyser.fftSize);
    }
    analyser.getByteFrequencyData(this.freq);
    analyser.getFloatTimeDomainData(this.time);
    const bins = this.freq.length;
    const top = Math.round(bins * 0.75);
    for (let i = 0; i < 75; i++) {
      const a = Math.floor(Math.pow(top, i / 75));
      const b = Math.max(a + 1, Math.floor(Math.pow(top, (i + 1) / 75)));
      let m = 0;
      for (let k = a; k < b && k < bins; k++) m = Math.max(m, this.freq[k]);
      this.spectrum[i] = m / 255;
    }
    let sum = 0;
    for (let i = 0; i < 576; i++) {
      const v = this.time[i] || 0;
      this.wave[i] = v;
      sum += v * v;
    }
    const vu = Math.min(255, Math.round(Math.sqrt(sum / 576) * 510));
    this.rt.setVis({
      spectrum: this.spectrum,
      waveform: this.wave,
      vu: [vu, vu],
    });
  }
}

export function playerCommand(
  dispatch: Dispatch,
  state: AppState,
  cmd: string,
  arg: number
) {
  const toggle = (on: boolean, action: () => any) => {
    if (!!arg !== on) dispatch(action());
  };
  switch (cmd) {
    case "play":
      return dispatch(Actions.play());
    case "pause":
      return dispatch(Actions.pause());
    case "stop":
      return dispatch(Actions.stop());
    case "next":
      return dispatch(Actions.next());
    case "previous":
      return dispatch(Actions.previous());
    case "eject":
      return dispatch(Actions.openMediaFileDialog());
    case "play_track": {
      const id = state.playlist.trackOrder[arg];
      return id == null ? undefined : dispatch(Actions.playTrackNow(id));
    }
    case "seek":
      return dispatch(Actions.seekToTime(arg / 1000));
    case "volume":
      return dispatch(Actions.setVolume(from255(arg)));
    case "pan":
      return dispatch(Actions.setBalance(Math.round((arg * 100) / 127)));
    case "shuffle":
      return toggle(Selectors.getShuffle(state), Actions.toggleShuffle);
    case "repeat":
      return toggle(Selectors.getRepeat(state), Actions.toggleRepeat);
    case "eq":
      return toggle(Selectors.getEqualizerEnabled(state), Actions.toggleEq);
    case "preamp":
      return dispatch(Actions.setPreamp(from255(arg)));
  }
  const band = /^band(\d)$/.exec(cmd);
  if (band) dispatch(Actions.setEqBand(BANDS[Number(band[1])], from255(arg)));
}

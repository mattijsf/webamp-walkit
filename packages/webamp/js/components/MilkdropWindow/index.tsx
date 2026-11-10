import { useEffect, useCallback } from "react";
import Fullscreen from "../Fullscreen";
import {
  useWindowSize,
  useScreenSize,
  useTypedSelector,
  useActionCreator,
} from "../../hooks";
import GenWindow from "../GenWindow";
import { WINDOWS } from "../../constants";
import * as Selectors from "../../selectors";
import * as Actions from "../../actionCreators";
import { TransitionType } from "../../types";
import Visualizer from "./Visualizer";

import Background from "./Background";
import PresetOverlay from "./PresetOverlay";
import DropTarget from "../DropTarget";
import MilkdropContextMenu from "./MilkdropContextMenu";
import Desktop from "./Desktop";

const MILLISECONDS_BETWEEN_PRESET_TRANSITIONS = 15000;

interface Props {
  analyser: AnalyserNode;
}

function useKeyHandler() {
  const trackTitle = useTypedSelector(Selectors.getCurrentTrackDisplayName);

  const selectNextPreset = useActionCreator(Actions.selectNextPreset);
  const selectPreviousPreset = useActionCreator(Actions.selectPreviousPreset);
  const toggleRandomize = useActionCreator(Actions.toggleRandomizePresets);
  const togglePresetOverlay = useActionCreator(Actions.togglePresetOverlay);
  const scheduleMilkdropMessage = useActionCreator(
    Actions.scheduleMilkdropMessage
  );
  const toggleCycling = useActionCreator(Actions.togglePresetCycling);

  // Handle keyboard events
  return useCallback(
    (e: KeyboardEvent) => {
      switch (e.keyCode) {
        case 32: // spacebar
          // Let Space activate focused buttons, like the close button.
          if (
            e.target instanceof Element &&
            e.target.getAttribute("role") === "button"
          ) {
            break;
          }
          selectNextPreset();
          break;
        case 8: // backspace
          selectPreviousPreset(TransitionType.IMMEDIATE);
          break;
        case 72: // H
          selectNextPreset(TransitionType.IMMEDIATE);
          break;
        case 82: // R
          toggleRandomize();
          break;
        case 76: // L
          togglePresetOverlay();
          e.stopPropagation();
          break;
        case 84: // T
          if (trackTitle != null) {
            scheduleMilkdropMessage(trackTitle);
          }
          e.stopPropagation();
          break;
        case 145: // scroll lock
        case 125: // F14 (scroll lock for OS X)
          toggleCycling();
          break;
      }
    },
    [
      scheduleMilkdropMessage,
      selectNextPreset,
      selectPreviousPreset,
      toggleCycling,
      togglePresetOverlay,
      toggleRandomize,
      trackTitle,
    ]
  );
}

export function useMilkdropCycling() {
  const presetsAreCycling = useTypedSelector(Selectors.getPresetsAreCycling);
  const currentPresetIndex = useTypedSelector(Selectors.getCurrentPresetIndex);
  const mediaIsPlaying = useTypedSelector(Selectors.getMediaIsPlaying);
  const selectNextPreset = useActionCreator(Actions.selectNextPreset);

  useEffect(() => {
    if (!presetsAreCycling || !mediaIsPlaying) {
      return;
    }
    const intervalId = setInterval(
      selectNextPreset,
      MILLISECONDS_BETWEEN_PRESET_TRANSITIONS
    );
    return () => clearInterval(intervalId);
  }, [presetsAreCycling, currentPresetIndex, mediaIsPlaying, selectNextPreset]);
}

interface ViewProps extends Props {
  width: number;
  height: number;
}

export function MilkdropView({ analyser, width, height }: ViewProps) {
  const fullscreen = useTypedSelector(Selectors.getMilkdropFullscreenEnabled);
  const overlay = useTypedSelector(Selectors.getPresetOverlayOpen);
  const toggleFullscreen = useActionCreator(Actions.toggleMilkdropFullscreen);
  const handlePresetDrop = useActionCreator(Actions.handlePresetDrop);
  const setFullscreen = useActionCreator(Actions.setMilkdropFullscreen);
  const screenSize = useScreenSize();

  const toggleFullScreenIfEnabled = useCallback(() => {
    if (document.fullscreenEnabled) {
      toggleFullscreen();
    }
  }, [toggleFullscreen]);

  const size = fullscreen ? screenSize : { width, height };
  return (
    <MilkdropContextMenu>
      <Background>
        <DropTarget windowId={WINDOWS.MILKDROP} handleDrop={handlePresetDrop}>
          {overlay && <PresetOverlay {...size} />}
          <Fullscreen enabled={fullscreen} onChange={setFullscreen}>
            <div onDoubleClick={toggleFullScreenIfEnabled}>
              <Visualizer {...size} analyser={analyser} />
            </div>
          </Fullscreen>
        </DropTarget>
      </Background>
    </MilkdropContextMenu>
  );
}

export { useKeyHandler as useMilkdropKeys };

function Milkdrop({ analyser }: Props) {
  const desktop = useTypedSelector(Selectors.getMilkdropDesktopEnabled);
  const handleKeyDown = useKeyHandler();
  const windowSize = useWindowSize();
  useMilkdropCycling();

  if (desktop) {
    return (
      <Desktop>
        <MilkdropContextMenu>
          <Visualizer {...windowSize} analyser={analyser} />
        </MilkdropContextMenu>
      </Desktop>
    );
  }

  return (
    <GenWindow
      title={"Milkdrop"}
      id="milkdrop-window"
      windowId={WINDOWS.MILKDROP}
      onKeyDown={handleKeyDown}
    >
      {(genWindowSize: { width: number; height: number }) => (
        <MilkdropView analyser={analyser} {...genWindowSize} />
      )}
    </GenWindow>
  );
}
export default Milkdrop;

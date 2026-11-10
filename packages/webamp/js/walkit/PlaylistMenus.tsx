import * as Actions from "../actionCreators";
import * as Selectors from "../selectors";
import { Node, Parent } from "../components/ContextMenu";
import { SortMenu } from "../components/PlaylistWindow/SortContextMenu";
import { MiscOptionsMenu } from "../components/PlaylistWindow/MiscOptionsContextMenu";
import { useActionCreator, useTypedSelector } from "../hooks";

// The menus of a modern skin's playlist buttons, with Winamp 5.666's items, less what webamp
// cannot do: Rem's "Remove..." (missing files, the files themselves, duplicates), Misc's "File
// info", sorting by file name or path, reading extended info, and the Media Library's items.

export function PlaylistAddMenu() {
  const count = useTypedSelector(Selectors.getTrackCount);
  const addFiles = useActionCreator(Actions.addFilesAtIndex);
  const addDir = useActionCreator(Actions.addDirAtIndex);
  const addUrl = useActionCreator(Actions.addFilesFromUrl);
  return (
    <>
      <Node label="Add file(s)" hotkey="L" onClick={() => addFiles(count)} />
      <Node label="Add folder" hotkey="Shift+L" onClick={() => addDir(count)} />
      <Node label="Add URL" hotkey="Ctrl+L" onClick={() => addUrl(count)} />
    </>
  );
}

export function PlaylistRemoveMenu() {
  const removeSelected = useActionCreator(Actions.removeSelectedTracks);
  const crop = useActionCreator(Actions.cropPlaylist);
  const clear = useActionCreator(Actions.removeAllTracks);
  return (
    <>
      <Node label="Remove selected" hotkey="Delete" onClick={removeSelected} />
      <Node label="Crop selected" hotkey="Ctrl+Delete" onClick={crop} />
      <Node label="Clear playlist" hotkey="Ctrl+Shift+Delete" onClick={clear} />
    </>
  );
}

export function PlaylistSelectMenu() {
  const all = useActionCreator(Actions.selectAll);
  const none = useActionCreator(Actions.selectZero);
  const invert = useActionCreator(Actions.invertSelection);
  return (
    <>
      <Node label="Select all" hotkey="Ctrl+A" onClick={all} />
      <Node label="Select none" onClick={none} />
      <Node label="Invert selection" hotkey="Ctrl+I" onClick={invert} />
    </>
  );
}

export function PlaylistMiscMenu() {
  return (
    <>
      <Parent label="Sort">
        <SortMenu />
      </Parent>
      <Parent label="Misc">
        <MiscOptionsMenu />
      </Parent>
    </>
  );
}

export function PlaylistListMenu() {
  const open = useActionCreator(Actions.addFilesFromList);
  const save = useActionCreator(Actions.saveFilesToList);
  const clear = useActionCreator(Actions.removeAllTracks);
  return (
    <>
      <Node label="Open playlist..." hotkey="Ctrl+O" onClick={open} />
      <Node label="Save playlist..." hotkey="Ctrl+S" onClick={save} />
      <Node label="New playlist (clear)" hotkey="Ctrl+N" onClick={clear} />
    </>
  );
}

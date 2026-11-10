import { Node } from "../ContextMenu";
import ContextMenuTarget from "../ContextMenuTarget";
import * as Actions from "../../actionCreators";
import { useActionCreator } from "../../hooks";

export function MiscOptionsMenu() {
  const downloadHtmlPlaylist = useActionCreator(Actions.downloadHtmlPlaylist);
  return <Node onClick={downloadHtmlPlaylist} label="Generate HTML playlist" />;
}

const MiscOptionsContextMenu = () => (
  <ContextMenuTarget
    style={{ width: "100%", height: "100%" }}
    top
    renderMenu={() => <MiscOptionsMenu />}
  >
    <div />
  </ContextMenuTarget>
);

export default MiscOptionsContextMenu;

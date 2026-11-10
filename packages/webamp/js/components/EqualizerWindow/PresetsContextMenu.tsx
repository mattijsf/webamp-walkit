import builtin from "../../../presets/builtin.json";
import * as Actions from "../../actionCreators";
import { Node, Parent, Hr } from "../ContextMenu";
import ContextMenuTarget from "../ContextMenuTarget";
import { useActionCreator } from "../../hooks";
import WinampButton from "../WinampButton";

export function PresetsMenu() {
  const openEqfFileDialog = useActionCreator(Actions.openEqfFileDialog);
  const downloadPreset = useActionCreator(Actions.downloadPreset);
  const setEqFromObject = useActionCreator(Actions.setEqFromObject);
  return (
    <>
      <Parent label="Load">
        {builtin.presets.map((preset) => (
          <Node
            key={preset.name}
            onClick={() => setEqFromObject(preset)}
            label={preset.name}
          />
        ))}
        <Hr />
        <Node onClick={openEqfFileDialog} label="From Eqf..." />
      </Parent>
      <Node onClick={downloadPreset} label="Save" />
    </>
  );
}

const PresetsContextMenu = () => (
  <ContextMenuTarget
    top
    id="presets-context"
    renderMenu={() => <PresetsMenu />}
  >
    <WinampButton id="presets" />
  </ContextMenuTarget>
);

export default PresetsContextMenu;

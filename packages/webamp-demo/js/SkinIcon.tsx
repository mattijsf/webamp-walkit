import WebampLazy from "../../webamp/js/webampLazy";
// @ts-ignore
import iconSmall from "../images/icons/paint-file-32x32.png";
import DesktopIcon from "./DesktopIcon";
import { log } from "./logger";

const iconUrl = iconSmall;

const isModern = (url: string) =>
  /\.wal$/i.test(new URL(url, location.href).pathname);

interface Props {
  webamp: WebampLazy;
  skin: { url: string; name: string };
}

const SkinIcon = ({ webamp, skin }: Props) => {
  function onOpen() {
    log({ category: "SkinIcon", action: "click", label: skin.name });
    webamp.setSkinFromUrl(skin.url);
  }
  return (
    <DesktopIcon
      iconUrl={iconUrl}
      name={`${skin.name}.${isModern(skin.url) ? "wal" : "wsz"}`}
      onOpen={onOpen}
    />
  );
};

export default SkinIcon;

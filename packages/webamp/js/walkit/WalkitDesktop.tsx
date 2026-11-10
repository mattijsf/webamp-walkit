import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "react-redux";
import classnames from "classnames";
import {
  MilkdropView,
  useMilkdropCycling,
  useMilkdropKeys,
} from "../components/MilkdropWindow";
import * as Selectors from "../selectors";
import { useTypedSelector } from "../hooks";
import ContextMenu from "../components/ContextMenu";
import MainContextMenu from "../components/MainWindow/MainContextMenu";
import OptionsContextMenu from "../components/OptionsContextMenu";
import { PresetsMenu } from "../components/EqualizerWindow/PresetsContextMenu";
import { SortMenu } from "../components/PlaylistWindow/SortContextMenu";
import { MiscOptionsMenu } from "../components/PlaylistWindow/MiscOptionsContextMenu";
import { AppState, FilePicker } from "../types";
import { Desktop, MenuKind, MenuPlace, Vis } from "./desktop";
import {
  PlaylistAddMenu,
  PlaylistListMenu,
  PlaylistMiscMenu,
  PlaylistRemoveMenu,
  PlaylistSelectMenu,
} from "./PlaylistMenus";

interface Props {
  analyser: AnalyserNode;
  filePickers: FilePicker[];
}

type Size = { width: number; height: number };

// where Milkdrop shows follows its window on every move: set straight on the element, so a
// drag re-renders nothing
function place(el: HTMLElement | null, vis: Vis | null) {
  if (!el || !vis) return;
  el.style.transform = `translate(${vis.left}px, ${vis.top}px)`;
  el.style.zIndex = String(vis.z);
}

function MenuItems({
  kind,
  filePickers,
}: {
  kind: MenuKind;
  filePickers: FilePicker[];
}) {
  switch (kind) {
    case "main":
      return <MainContextMenu filePickers={filePickers} />;
    case "options":
      return <OptionsContextMenu />;
    case "presets":
      return <PresetsMenu />;
    case "sort":
      return <SortMenu />;
    case "misc":
      return <MiscOptionsMenu />;
    case "playlistAdd":
      return <PlaylistAddMenu />;
    case "playlistRemove":
      return <PlaylistRemoveMenu />;
    case "playlistSelect":
      return <PlaylistSelectMenu />;
    case "playlistMisc":
      return <PlaylistMiscMenu />;
    case "playlistList":
      return <PlaylistListMenu />;
  }
}

// a menu that would run off the page moves onto it
function fitMenu(menu: HTMLElement) {
  menu.style.transform = "";
  const r = menu.getBoundingClientRect();
  const { clientWidth, clientHeight } = document.documentElement;
  const dx = Math.max(-r.left, Math.min(0, clientWidth - r.right));
  const dy = Math.max(-r.top, Math.min(0, clientHeight - r.bottom));
  if (dx || dy) menu.style.transform = `translate(${dx}px, ${dy}px)`;
}

// a submenu opens to the left of its item when there is more room there, and under (or over)
// the item when it fits on neither side
function fitSubmenu(e: MouseEvent) {
  const item = (e.target as Element).closest("li.parent");
  const sub = item?.querySelector<HTMLElement>(":scope > ul");
  if (!item || !sub || sub.contains(e.target as Node)) return;
  sub.classList.remove("flip");
  sub.style.transform = "";
  const hidden = getComputedStyle(sub).display === "none";
  if (hidden) sub.style.display = "block";
  const { clientWidth } = document.documentElement;
  const at = item.getBoundingClientRect();
  if (
    sub.getBoundingClientRect().right > clientWidth &&
    at.left > clientWidth - at.right
  ) {
    sub.classList.add("flip");
  }
  const r = sub.getBoundingClientRect();
  if (r.left < 0 || r.right > clientWidth) {
    const dx = Math.max(-r.left, Math.min(0, clientWidth - r.right));
    const below = at.bottom + r.height <= document.documentElement.clientHeight;
    const dy = below ? at.bottom - r.top : at.top - r.height - r.top;
    sub.style.transform = `translate(${dx}px, ${dy}px)`;
  } else {
    fitMenu(sub);
  }
  if (hidden) sub.style.display = "";
}

function HostedMilkdrop({
  analyser,
  size,
  box,
}: {
  analyser: AnalyserNode;
  size: Size;
  box: (el: HTMLDivElement | null) => void;
}) {
  const handleKeyDown = useMilkdropKeys();
  useMilkdropCycling();
  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => handleKeyDown(e.nativeEvent)}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: size.width,
        height: size.height,
      }}
    >
      <MilkdropView
        analyser={analyser}
        width={size.width}
        height={size.height}
      />
    </div>
  );
}

export default function WalkitDesktop({ analyser, filePickers }: Props) {
  const store = useStore<AppState>();
  const root = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<MenuPlace | null>(null);
  const menuList = useRef<HTMLUListElement>(null);
  const [visSize, setVisSize] = useState<Size | null>(null);
  const vis = useRef<Vis | null>(null);
  const visBox = useRef<HTMLDivElement | null>(null);
  const box = useCallback((el: HTMLDivElement | null) => {
    visBox.current = el;
    place(el, vis.current);
  }, []);
  const milkdrop = useTypedSelector(Selectors.getMilkdropEnabled);
  const desktopMode = useTypedSelector(Selectors.getMilkdropDesktopEnabled);

  useEffect(() => {
    const openMenu = (next: MenuPlace) => setMenu(next);
    const showVis = (next: Vis | null) => {
      vis.current = next;
      place(visBox.current, next);
      setVisSize((size) => {
        if (next == null) return null;
        const same = size?.width === next.width && size.height === next.height;
        return same ? size : { width: next.width, height: next.height };
      });
    };
    const desktop = new Desktop(
      root.current!,
      store,
      analyser,
      openMenu,
      showVis
    );
    return () => desktop.dispose();
  }, [store, analyser]);

  useEffect(() => {
    if (menu == null) return;
    const inMenu = (e: Event) =>
      (e.target as Element).closest?.("#webamp-context-menu") != null;
    // a press anywhere else closes the menu, as in Winamp, so a press on another button opens
    // its own menu at once; the click a tap sends late then lands nowhere
    const press = (e: PointerEvent) => {
      if (!inMenu(e)) setMenu(null);
    };
    // an item closes the menu; a submenu's item, a separator or the menu's edge keep it open
    const pick = (e: MouseEvent) => {
      const t = e.target as Element;
      if (inMenu(e) && t.closest("li:not(.parent):not(.hr)")) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("click", pick);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("click", pick);
      document.removeEventListener("keydown", escape);
    };
  }, [menu]);

  // after the menu's portal is on the page
  useEffect(() => {
    const list = menuList.current;
    if (menu == null || !list) return;
    fitMenu(list);
    list.addEventListener("mouseover", fitSubmenu);
    return () => list.removeEventListener("mouseover", fitSubmenu);
  }, [menu]);

  return (
    <>
      <div style={{ position: "absolute", left: 0, top: 0 }}>
        <div ref={root} />
        {visSize && milkdrop && !desktopMode && (
          <HostedMilkdrop analyser={analyser} size={visSize} box={box} />
        )}
      </div>
      <ContextMenu
        selected={menu != null}
        offsetTop={menu?.y ?? 0}
        offsetLeft={menu?.x ?? 0}
        listRef={menuList}
        className={classnames({
          above: menu?.above,
          end: menu?.alignRight,
        })}
      >
        {menu && <MenuItems kind={menu.kind} filePickers={filePickers} />}
      </ContextMenu>
    </>
  );
}

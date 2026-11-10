import { useEffect, useRef } from "react";
import { useStore } from "react-redux";
import { AppState } from "../types";
import { Desktop } from "./desktop";

interface Props {
  analyser: AnalyserNode;
}

export default function WalkitDesktop({ analyser }: Props) {
  const store = useStore<AppState>();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const desktop = new Desktop(root.current!, store, analyser);
    return () => desktop.dispose();
  }, [store, analyser]);

  return (
    <div style={{ position: "absolute", left: 0, top: 0 }}>
      <div ref={root} />
    </div>
  );
}

// What modern skins need besides themselves, next to the page when it has them: Winamp's
// wasabi base and the stand-in fonts their text is laid out with. Relative, so the page works
// under any path. Fetched once, all at the same time, and as soon as a modern skin is on its
// way, so they arrive together with it.

export type ModernFiles = {
  wasabi: Uint8Array | null;
  fonts: Map<string, Uint8Array>;
};

let files: Promise<ModernFiles> | null = null;

async function bytes(url: string): Promise<Uint8Array | null> {
  try {
    const r = await fetch(url);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function fonts(): Promise<Map<string, Uint8Array>> {
  const names: string[] = await fetch("walkit/fonts.json")
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  const loaded = await Promise.all(
    names.map(async (name) => {
      const b = await bytes(`walkit/fonts/${encodeURIComponent(name)}`);
      return [`fonts/${name}`, b] as const;
    })
  );
  const out = new Map<string, Uint8Array>();
  for (const [path, b] of loaded) if (b) out.set(path, b);
  return out;
}

export function modernFiles(): Promise<ModernFiles> {
  files ??= Promise.all([bytes("walkit/wasabi.zip"), fonts()]).then(
    ([wasabi, f]) => ({ wasabi, fonts: f })
  );
  return files;
}

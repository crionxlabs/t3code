/**
 * AdelisOne: the Imported Library — reference content (not conversations)
 * brought in from a Claude export. Memory, artifacts, and project docs each get
 * their own view here, kept out of the thread list. Opened from a sidebar
 * header button; reads adelisone/server/importChatsRoute.ts's GET /api/a1/library.
 */
import { useCallback, useEffect, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../../apps/web/src/environments/primary/desktopAuth";
import { SidebarHeaderIconButton } from "../../apps/web/src/components/sidebar/SidebarThreadHeader";
import { Button } from "../../apps/web/src/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../apps/web/src/components/ui/dialog";

type Item = { id: string; title: string; date: string; content: string; group?: string };
type Library = { memory: Item[]; artifacts: Item[]; docs: Item[] };
type Tab = "memory" | "artifacts" | "docs";

const TAB_LABELS: Record<Tab, string> = {
  memory: "Memory",
  artifacts: "Artifacts",
  docs: "Project docs",
};

// Inline so this file needs no bare "lucide-react" import (it lives outside apps/web).
function BookIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

export function ImportedLibraryButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <SidebarHeaderIconButton label="Library" onClick={() => setOpen(true)}>
        <BookIcon />
      </SidebarHeaderIconButton>
      {open ? <LibraryDialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}

function LibraryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [library, setLibrary] = useState<Library | null>(null);
  const [tab, setTab] = useState<Tab>("memory");
  const [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  const openItem = useCallback((item: Item) => {
    setSelected(item);
    setDraft(item.content);
    setSaveState("idle");
  }, []);

  const save = useCallback(async () => {
    if (!selected) return;
    setSaveState("saving");
    try {
      const token = await readDesktopPrimaryBearerToken().catch(() => null);
      const response = await fetch("/api/a1/library/update", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ bucket: tab, id: selected.id, content: draft }),
      });
      if (!response.ok) {
        setError(`Could not save (${response.status}).`);
        setSaveState("idle");
        return;
      }
      // Reflect the edit in local state so the list/reader stay in sync.
      setLibrary((prev) =>
        prev
          ? {
              ...prev,
              [tab]: prev[tab].map((it) =>
                it.id === selected.id ? { ...it, content: draft } : it,
              ),
            }
          : prev,
      );
      setSelected((prev) => (prev ? { ...prev, content: draft } : prev));
      setSaveState("saved");
    } catch (cause) {
      setError(String(cause));
      setSaveState("idle");
    }
  }, [selected, tab, draft]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const token = await readDesktopPrimaryBearerToken().catch(() => null);
      const response = await fetch("/api/a1/library", {
        credentials: "include",
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        setError(`Could not load the library (${response.status}).`);
        return;
      }
      const data = (await response.json()) as Library;
      setLibrary({
        memory: data.memory ?? [],
        artifacts: data.artifacts ?? [],
        docs: data.docs ?? [],
      });
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const items = library ? library[tab] : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup
        className="flex flex-col"
        // Inline maxWidth/maxHeight override the component's max-w-lg clamp
        // (the dialog grid column is auto-sized, so a width class alone won't grow it).
        style={{ width: "48rem", maxWidth: "90vw", height: "80vh", maxHeight: "90vh" }}
      >
        {selected ? (
          // Editor: one item, full width, with a way back to the list.
          <>
            <DialogHeader>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="w-fit text-sm text-muted-foreground hover:text-foreground"
              >
                ← Back to {TAB_LABELS[tab]}
              </button>
              <DialogTitle>
                {selected.group ? `${selected.group}: ` : ""}
                {selected.title}
              </DialogTitle>
            </DialogHeader>
            <textarea
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaveState("idle");
              }}
              spellCheck={false}
              className="min-h-0 flex-1 resize-none rounded-md border border-border bg-background p-3 font-mono text-sm outline-none focus:border-primary"
            />
            <div className="flex items-center justify-end gap-3 pt-2">
              {saveState === "saved" ? (
                <span className="text-sm text-muted-foreground">Saved</span>
              ) : null}
              <Button
                size="sm"
                disabled={saveState === "saving" || draft === selected.content}
                onClick={() => void save()}
              >
                {saveState === "saving" ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Library</DialogTitle>
              <DialogDescription>
                Memory, artifacts, and project documents imported from Claude — kept separate from
                your conversations.
              </DialogDescription>
            </DialogHeader>

            <div className="flex gap-1 border-b border-border">
              {(["memory", "artifacts", "docs"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-sm ${
                    tab === t
                      ? "border-b-2 border-primary font-medium text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {TAB_LABELS[t]} ({library ? library[t].length : 0})
                </button>
              ))}
            </div>

            {error ? <p className="py-2 text-sm text-destructive">{error}</p> : null}

            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pt-2">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => openItem(item)}
                    className="block w-full truncate rounded px-2 py-1.5 text-left text-sm text-foreground hover:bg-primary/10"
                    title={item.group ? `${item.group}: ${item.title}` : item.title}
                  >
                    {item.group ? `${item.group}: ` : ""}
                    {item.title}
                  </button>
                </li>
              ))}
              {library && items.length === 0 ? (
                <li className="px-2 py-1 text-sm text-muted-foreground">Nothing imported yet.</li>
              ) : null}
            </ul>
          </>
        )}
      </DialogPopup>
    </Dialog>
  );
}

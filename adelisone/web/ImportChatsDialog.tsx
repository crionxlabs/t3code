/**
 * AdelisOne: Settings → General → "Import conversations". Drop a claude.ai or
 * ChatGPT data export (zip or conversations.json); the server converts it into
 * importable sessions (adelisone/server/importChatsRoute.ts), then this dialog
 * creates a project for them and imports the threads — so uploading is the only
 * step a person takes.
 */
import { useCallback, useRef, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../../apps/web/src/environments/primary/desktopAuth";
import { useScratchProject } from "../../apps/web/src/hooks/useScratchProject";
import { agentSessionImport } from "../../apps/web/src/state/agentSessions";
import { usePrimaryEnvironmentId } from "../../apps/web/src/state/environments";
import { useAtomCommand } from "../../apps/web/src/state/use-atom-command";
import { Button } from "../../apps/web/src/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../../apps/web/src/components/ui/dialog";

type SkipDetail = { title: string; reason: string };

type LibraryCounts = { memory: number; artifacts: number; docs: number };

type UploadState =
  | { phase: "idle" }
  | { phase: "working"; label: string }
  | {
      phase: "done";
      imported: number;
      library: LibraryCounts;
      skippedDetails: ReadonlyArray<SkipDetail>;
    }
  | { phase: "error"; message: string };

export function ImportChatsButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const environmentId = usePrimaryEnvironmentId();
  const { scratchEnvironmentId, openScratchProject } = useScratchProject();
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });

  const run = useCallback(
    async (files: ReadonlyArray<File>) => {
      const library: LibraryCounts = { memory: 0, artifacts: 0, docs: 0 };
      const skippedDetails: SkipDetail[] = [];

      // Imported chats go into the no-project (scratch) home so they show as
      // loose conversations, not under a named "Imported Conversations" project.
      const scratchEnvId = environmentId ? scratchEnvironmentId(environmentId) : null;
      const scratchProject = scratchEnvId ? await openScratchProject(scratchEnvId) : null;
      const convDir = scratchProject?.workspaceRoot ?? null;
      const convQuery = convDir ? `?convDir=${encodeURIComponent(convDir)}` : "";

      // Desktop renders over a custom protocol, so it authenticates HTTP with a
      // bearer token from the desktop bridge; the same-origin browser uses its
      // session cookie instead.
      const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
      for (const file of files) {
        setState({ phase: "working", label: `Converting ${file.name}…` });
        try {
          const response = await fetch(`/api/a1/import-chats${convQuery}`, {
            method: "POST",
            body: file,
            credentials: "include",
            headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
          });
          const result = (await response.json()) as {
            library?: LibraryCounts;
            skippedDetails?: SkipDetail[];
            error?: string;
          };
          if (!response.ok) {
            setState({
              phase: "error",
              message: result.error ?? `Upload failed (${response.status}).`,
            });
            return;
          }
          library.memory += result.library?.memory ?? 0;
          library.artifacts += result.library?.artifacts ?? 0;
          library.docs += result.library?.docs ?? 0;
          skippedDetails.push(...(result.skippedDetails ?? []));
        } catch (error) {
          setState({ phase: "error", message: String(error) });
          return;
        }
      }

      // Memory / artifacts / docs are stored server-side for the Library views;
      // only conversations become threads, so only they need the import step.
      let imported = 0;
      if (scratchProject && convDir && environmentId) {
        // The importer takes at most 100 transcripts per call, so loop until the
        // running total stops growing.
        let previous = -1;
        for (let pass = 0; pass < 25 && imported !== previous; pass++) {
          previous = imported;
          setState({ phase: "working", label: `Adding conversations to AdelisOne… (${imported})` });
          const importResult = await importThreads({
            environmentId,
            input: { projectId: scratchProject.id, expectedWorkspaceRoot: convDir },
          });
          if (importResult._tag !== "Success") break;
          imported = Math.max(imported, Number(importResult.value?.importedCount ?? 0));
        }
      }
      setState({ phase: "done", imported, library, skippedDetails });
    },
    [environmentId, scratchEnvironmentId, openScratchProject, importThreads],
  );

  const onFiles = useCallback(
    (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length > 0) void run(files);
    },
    [run],
  );

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Upload export…
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>Import conversations</DialogTitle>
            <DialogDescription>
              Drop the files from a claude.ai or ChatGPT data export here — the zips you downloaded
              from Settings → Export data. Drop all of them at once (conversations, projects,
              memories, and frames) to import everything.
            </DialogDescription>
          </DialogHeader>
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              onFiles(event.dataTransfer.files);
            }}
            className={`flex min-h-28 cursor-pointer items-center justify-center rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground ${
              dragging ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            {state.phase === "working"
              ? state.label
              : "Drop the export here, or click to choose a file"}
          </div>
          <input
            ref={inputRef}
            type="file"
            accept=".zip,.json,application/zip,application/json"
            multiple
            hidden
            onChange={(event) => {
              onFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          {state.phase === "done" ? (
            <>
              <p className="text-sm">
                Imported {state.imported} conversation{state.imported === 1 ? "" : "s"}. Added{" "}
                {state.library.memory} memory, {state.library.artifacts} artifact, and{" "}
                {state.library.docs} document items to the Library (open it from the book icon in
                the sidebar header)
                {(state.skippedDetails ?? []).length > 0
                  ? ` — ${(state.skippedDetails ?? []).length} skipped`
                  : ""}
                .
              </p>
              {(state.skippedDetails ?? []).length > 0 ? (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">
                    Show skipped ({(state.skippedDetails ?? []).length})
                  </summary>
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                    {(state.skippedDetails ?? []).map((entry, index) => (
                      <li key={index} className="flex flex-col border-b border-border/50 pb-1">
                        <span className="truncate font-medium">{entry.title}</span>
                        <span className="text-xs text-muted-foreground">{entry.reason}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : null}
          {state.phase === "error" ? (
            <p className="text-sm text-destructive">{state.message}</p>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}

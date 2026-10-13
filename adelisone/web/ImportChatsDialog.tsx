/**
 * AdelisOne: Settings → General → "Import conversations". Drop a claude.ai or
 * ChatGPT data export (zip or conversations.json); the server converts it into
 * importable sessions (adelisone/server/importChatsRoute.ts), then this dialog
 * creates a project for them and imports the threads — so uploading is the only
 * step a person takes.
 */
import { useCallback, useRef, useState } from "react";

import { readDesktopPrimaryBearerToken } from "../../apps/web/src/environments/primary/desktopAuth";
import { newProjectId } from "../../apps/web/src/lib/utils";
import { agentSessionImport } from "../../apps/web/src/state/agentSessions";
import { useProjects } from "../../apps/web/src/state/entities";
import { usePrimaryEnvironmentId } from "../../apps/web/src/state/environments";
import { projectEnvironment } from "../../apps/web/src/state/projects";
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

type LibraryCounts = { memory: number; artifacts: number };

type ImportedProject = { title: string; workspaceRoot: string; files: number };

type ConversationBucket = { provider: string; workspaceRoot: string; count: number };

type UploadState =
  | { phase: "idle" }
  | { phase: "working"; label: string }
  | {
      phase: "done";
      imported: number;
      projects: number;
      library: LibraryCounts;
      skippedDetails: ReadonlyArray<SkipDetail>;
    }
  | { phase: "error"; message: string };

export function ImportChatsButton() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<UploadState>({ phase: "idle" });
  const [dragging, setDragging] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const environmentId = usePrimaryEnvironmentId();
  const importThreads = useAtomCommand(agentSessionImport, { reportFailure: false });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const projects = useProjects();

  const run = useCallback(
    async (sources: ReadonlyArray<File | { path: string }>) => {
      const library: LibraryCounts = { memory: 0, artifacts: 0 };
      const importedProjects: ImportedProject[] = [];
      const conversationBuckets: ConversationBucket[] = [];
      const skippedDetails: SkipDetail[] = [];

      // Desktop renders over a custom protocol, so it authenticates HTTP with a
      // bearer token from the desktop bridge; the same-origin browser uses its
      // session cookie instead.
      const bearerToken = await readDesktopPrimaryBearerToken().catch(() => null);
      for (const source of sources) {
        const folder = source instanceof File ? null : source.path;
        setState({
          phase: "working",
          label: folder ? "Reading export folder…" : `Converting ${(source as File).name}…`,
        });
        try {
          // Folder sources pass ?path= and no body; file sources upload the body.
          const query = folder ? `?path=${encodeURIComponent(folder)}` : "";
          const response = await fetch(`/api/a1/import-chats${query}`, {
            method: "POST",
            ...(folder ? {} : { body: source as File }),
            credentials: "include",
            headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {},
          });
          const result = (await response.json()) as {
            library?: LibraryCounts;
            importedProjects?: ImportedProject[];
            conversationBuckets?: ConversationBucket[];
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
          importedProjects.push(...(result.importedProjects ?? []));
          conversationBuckets.push(...(result.conversationBuckets ?? []));
          skippedDetails.push(...(result.skippedDetails ?? []));
        } catch (error) {
          setState({ phase: "error", message: String(error) });
          return;
        }
      }

      if (!environmentId) {
        setState({ phase: "done", imported: 0, projects: 0, library, skippedDetails });
        return;
      }

      // Projects (both the imported content projects and the per-provider chat
      // buckets) are created by workspaceRoot; skip any folder already a project.
      const existingRootToId = new Map(
        projects.map((project) => [
          (project.workspaceRoot ?? "").replace(/[/\\]+$/, "").toLowerCase(),
          project.id,
        ]),
      );
      const ensureProject = async (title: string, workspaceRoot: string) => {
        const normalized = workspaceRoot.replace(/[/\\]+$/, "").toLowerCase();
        const existing = existingRootToId.get(normalized);
        if (existing !== undefined) return existing;
        const newId = newProjectId();
        const created = await createProject({
          environmentId,
          input: {
            projectId: newId,
            title,
            workspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: null,
          },
        });
        if (created._tag !== "Success") return null;
        existingRootToId.set(normalized, newId);
        return newId;
      };

      // Memory / artifacts are stored server-side for their own views. Claude
      // content projects (docs only) become real projects.
      let projectsCreated = 0;
      const createdCount = existingRootToId.size;
      for (const project of importedProjects) {
        setState({ phase: "working", label: `Adding project “${project.title}”…` });
        await ensureProject(project.title, project.workspaceRoot);
      }

      // Conversation buckets → one project per provider, with its chats imported.
      let imported = 0;
      for (const bucket of conversationBuckets) {
        setState({ phase: "working", label: `Adding ${bucket.provider} chats…` });
        const projectId = await ensureProject(bucket.provider, bucket.workspaceRoot);
        if (projectId === null) continue;
        // The importer takes at most 100 transcripts per call, so loop until the
        // running total for this bucket stops growing.
        let previous = -1;
        let bucketImported = 0;
        for (let pass = 0; pass < 25 && bucketImported !== previous; pass++) {
          previous = bucketImported;
          setState({
            phase: "working",
            label: `Adding ${bucket.provider} chats to AdelisOne… (${imported + bucketImported})`,
          });
          const importResult = await importThreads({
            environmentId,
            input: { projectId, expectedWorkspaceRoot: bucket.workspaceRoot },
          });
          if (importResult._tag !== "Success") break;
          bucketImported = Math.max(bucketImported, Number(importResult.value?.importedCount ?? 0));
        }
        imported += bucketImported;
      }
      projectsCreated = existingRootToId.size - createdCount;

      setState({ phase: "done", imported, projects: projectsCreated, library, skippedDetails });
    },
    [environmentId, importThreads, createProject, projects],
  );

  const onFiles = useCallback(
    (list: FileList | null) => {
      const files = Array.from(list ?? []);
      if (files.length > 0) void run(files);
    },
    [run],
  );

  const onFolder = useCallback(() => {
    const path = folderPath.trim();
    if (path.length > 0) void run([{ path }]);
  }, [folderPath, run]);

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
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              For a large export (like ChatGPT's), paste the full path to the unzipped export folder
              on this computer instead of uploading — it's read directly off disk.
            </p>
            <div className="flex gap-2">
              <input
                type="text"
                value={folderPath}
                onChange={(event) => setFolderPath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") onFolder();
                }}
                placeholder="/Users/you/Downloads/export-folder"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-primary"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={folderPath.trim().length === 0 || state.phase === "working"}
                onClick={onFolder}
              >
                Import folder
              </Button>
            </div>
          </div>
          {state.phase === "done" ? (
            <>
              <p className="text-sm">
                Imported {state.imported} conversation{state.imported === 1 ? "" : "s"} and{" "}
                {state.projects} project{state.projects === 1 ? "" : "s"} (in the project picker).
                Added {state.library.memory} to Memory and {state.library.artifacts} to Artifacts
                (open them from the book icon in the sidebar header)
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

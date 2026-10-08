import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import {
  planWorkspaceOpenTargets,
  resolveParentDirectoryOpenInput,
} from "@/workspace/open-in-editor/planner";

interface UseOpenDirectoryInEditorInput {
  serverId: string;
  workspaceDirectory: string;
}

interface OpenDirectoryInEditorAction {
  targetName: string;
  open: (directoryPath: string) => void;
  openFile: (file: WorkspaceFileLocation) => void;
  /** Opens the folder containing `path` (a file or folder) in the editor. */
  openParent: (path: string) => void;
}

export function useOpenDirectoryInEditor({
  serverId,
  workspaceDirectory,
}: UseOpenDirectoryInEditorInput): OpenDirectoryInEditorAction | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { preferredEditorId } = usePreferredEditor();
  const { targets, isAvailable } = useDesktopOpenTargets({ isLocalExecution });
  const editorTargets = useMemo(
    () => targets.filter((target) => target.kind === "editor"),
    [targets],
  );
  const preferredTarget = useMemo(() => {
    const preferredId = resolvePreferredEditorId(
      editorTargets.map((target) => target.id),
      preferredEditorId,
    );
    return editorTargets.find((target) => target.id === preferredId) ?? null;
  }, [editorTargets, preferredEditorId]);

  const openTarget = useCallback(
    (input: { directoryPath?: string; activeFile?: WorkspaceFileLocation }) => {
      if (!preferredTarget) {
        return;
      }
      const target = planWorkspaceOpenTargets({
        workspaceDirectory,
        ...input,
        desktopTargets: [preferredTarget],
        canUseDesktopBridge: isAvailable,
        isLocalExecution,
      }).find((candidate) => candidate.source === "desktop");
      if (!target) {
        return;
      }
      void openDesktopTarget(target.openInput).catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : t("sidebar.project.actions.openFolderFailed"),
        );
      });
    },
    [isAvailable, isLocalExecution, preferredTarget, t, toast, workspaceDirectory],
  );

  const open = useCallback(
    (directoryPath: string) => {
      openTarget({ directoryPath });
    },
    [openTarget],
  );
  const openFile = useCallback(
    (file: WorkspaceFileLocation) => {
      openTarget({ activeFile: file });
    },
    [openTarget],
  );

  const openParent = useCallback(
    (path: string) => {
      const input = resolveParentDirectoryOpenInput({ path, workspaceDirectory });
      if (input) {
        openTarget(input);
      }
    },
    [openTarget, workspaceDirectory],
  );

  return useMemo(
    () =>
      preferredTarget ? { targetName: preferredTarget.label, open, openFile, openParent } : null,
    [open, openFile, openParent, preferredTarget],
  );
}

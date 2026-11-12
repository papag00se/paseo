import type { ComponentType } from "react";

export interface CrossnotePreviewProps {
  filePath: string;
  workspaceId: string;
  workspaceRoot: string | null;
  serverId: string;
}

/**
 * The Markdown Preview plugin's Crossnote renderer runs on a loopback origin of the daemon
 * machine, so only the desktop app can show it. Other clients use the built-in renderer.
 */
export const CrossnotePreview: ComponentType<CrossnotePreviewProps> | null = null;

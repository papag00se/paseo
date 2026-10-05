import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

// Crossnote is served from a separate loopback origin. Same-origin access inside
// that frame is needed for its revision-checked edits; it cannot access Paseo's DOM.
const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const frameStyle = { flex: 1, width: "100%", height: "100%", minHeight: 0, border: 0 } as const;
const frameTheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
const previewResponse = z.object({ url: z.string().url(), hostname: z.string() });
const navigationMessage = z.object({
  type: z.literal("paseo.markdown.open"),
  path: z.string().min(1),
});
type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; url: string }
  | { kind: "error"; message: string };

function CrossnoteFrame({ url, colorScheme }: { url: string; colorScheme: "light" | "dark" }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { openFileInWorkspace } = usePaneContext();
  const source = new URL(url);
  source.searchParams.set("theme", colorScheme);
  useEffect(() => {
    const origin = new URL(url).origin;
    function navigate(event: MessageEvent<unknown>) {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const message = navigationMessage.safeParse(event.data);
      if (message.success)
        openFileInWorkspace({ location: { path: message.data.path }, disposition: "preferred" });
    }
    window.addEventListener("message", navigate);
    return () => window.removeEventListener("message", navigate);
  }, [url, openFileInWorkspace]);
  return (
    <iframe
      ref={frame}
      title="Markdown Preview Enhanced"
      src={source.toString()}
      sandbox={PREVIEW_SANDBOX}
      referrerPolicy="no-referrer"
      style={frameStyle}
    />
  );
}
const ThemedCrossnoteFrame = withUnistyles(CrossnoteFrame);

export function FileMarkdownPreview(_props: { source: string }) {
  const { serverId, workspaceId, target } = usePaneContext();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const root = useWorkspaceDirectory(serverId, workspaceId);
  const filePath =
    target.kind === "file" && root
      ? resolveWorkspaceFilePaths({ path: target.path, workspaceRoot: root })?.relativePath
      : null;
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({ kind: "loading" });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  useEffect(() => {
    let cancelled = false;
    let sessionUrl: string | null = null;
    function release(url: string) {
      void client
        ?.invokePluginRpc("markdown-preview", "preview.close", { url })
        .catch(() => undefined);
    }
    setPreview({ kind: "loading" });
    async function open() {
      try {
        if (!client) throw new Error("The Markdown preview host is disconnected.");
        if (!filePath)
          throw new Error("Crossnote preview requires a Markdown file inside this workspace.");
        const response = previewResponse.parse(
          await client.invokePluginRpc("markdown-preview", "preview.open", {
            workspaceId,
            filePath,
            embedded: true,
          }),
        );
        sessionUrl = response.url;
        if (cancelled) {
          release(response.url);
          return;
        }
        const url = new URL(response.url);
        if (url.searchParams.get("embedded") !== "1" || url.searchParams.get("file") !== filePath)
          throw new Error("Update the Markdown Preview plugin to enable file-tab previews.");
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
          throw new Error("Invalid Crossnote preview address.");
        if (!cancelled) setPreview({ kind: "ready", url: response.url });
      } catch (error) {
        if (!cancelled)
          setPreview({
            kind: "error",
            message: error instanceof Error ? error.message : "Crossnote preview failed.",
          });
      }
    }
    void open();
    return () => {
      cancelled = true;
      if (sessionUrl) release(sessionUrl);
    };
  }, [client, workspaceId, filePath, attempt]);
  if (preview.kind === "ready")
    return <ThemedCrossnoteFrame url={preview.url} uniProps={frameTheme} />;
  return (
    <View style={styles.state}>
      <Text style={styles.message}>
        {preview.kind === "loading" ? "Opening Markdown preview…" : preview.message}
      </Text>
      {preview.kind === "error" ? (
        <>
          <Text style={styles.message}>
            Install the updated Markdown Preview plugin on the local desktop host, then retry.
            Source remains available in the file toolbar.
          </Text>
          <Button variant="outline" size="sm" onPress={retry}>
            Retry preview
          </Button>
        </>
      ) : null}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  message: { color: theme.colors.foregroundMuted, textAlign: "center" },
}));

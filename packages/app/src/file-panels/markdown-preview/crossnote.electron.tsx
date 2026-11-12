import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { usePaneContext } from "@/panels/pane-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { CrossnotePreviewProps } from "./crossnote";
import { openMarkdownFilePreview } from "./request";

// Crossnote is served from a separate loopback origin. Same-origin access inside
// that frame is needed for its revision-checked edits; it cannot access Paseo's DOM.
const PREVIEW_SANDBOX =
  "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox";
const frameStyle = { flex: 1, width: "100%", height: "100%", minHeight: 0, border: 0 } as const;
const frameTheme = (theme: Theme) => ({ colorScheme: theme.colorScheme });
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

/** The Markdown panel's Preview through the Markdown Preview plugin (Crossnote). */
function ElectronCrossnotePreview({
  filePath,
  workspaceId,
  workspaceRoot,
  serverId,
}: CrossnotePreviewProps) {
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
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
        const url = await openMarkdownFilePreview(client, {
          workspaceId,
          workspaceRoot,
          path: filePath,
        });
        sessionUrl = url;
        if (cancelled) {
          release(url);
          return;
        }
        setPreview({ kind: "ready", url });
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
  }, [client, workspaceId, workspaceRoot, filePath, attempt]);
  if (preview.kind === "ready")
    return <ThemedCrossnoteFrame url={preview.url} uniProps={frameTheme} />;
  return (
    <View style={styles.state}>
      <Text style={styles.message}>
        {preview.kind === "loading" ? "Opening Markdown preview…" : preview.message}
      </Text>
      {preview.kind === "error" ? (
        <>
          <Text style={styles.message}>Source remains available in the file toolbar.</Text>
          <Button variant="outline" size="sm" onPress={retry}>
            Retry preview
          </Button>
        </>
      ) : null}
    </View>
  );
}

export const CrossnotePreview = ElectronCrossnotePreview;

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

import { Text } from "react-native";
import {
  forwardRef,
  useCallback,
  useMemo,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactElement,
} from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ExternalLink, FolderOpen } from "lucide-react-native";
import { useFileLink } from "@/assistant-file-links";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  useContextMenu,
} from "@/components/ui/context-menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedExternalLink = withUnistyles(ExternalLink);
const openInEditorLeading = <ThemedExternalLink size={14} uniProps={mutedColorMapping} />;
const ThemedFolderOpen = withUnistyles(FolderOpen);
const openParentInEditorLeading = <ThemedFolderOpen size={14} uniProps={mutedColorMapping} />;

// File links keep the library's inline anchor; a right click opens editor actions at the pointer.
function WebLink(props: LinkRendererProps) {
  const fileLink = useFileLink(markdownLinkSource(props.link.url, props.link.sourceType));
  if (!fileLink.target) return <WebLinkAnchor {...props} fileLink={fileLink} />;
  return (
    <ContextMenu>
      <WebLinkAnchor {...props} fileLink={fileLink} />
      <ContextMenuContent align="start" width={220}>
        <ContextMenuItem leading={openInEditorLeading} onSelect={fileLink.onOpenInEditor}>
          Open in Editor…
        </ContextMenuItem>
        <ContextMenuItem
          leading={openParentInEditorLeading}
          onSelect={fileLink.onOpenParentInEditor}
        >
          Open Parent in Editor…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function WebLinkContextMenuOpener({
  children,
}: {
  children: (open: (event: MouseEvent) => void) => ReactElement;
}) {
  const menu = useContextMenu();
  const open = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      menu.setAnchorRect({ x: event.pageX, y: event.pageY, width: 0, height: 0 });
      menu.setOpen(true);
    },
    [menu],
  );
  return children(open);
}

function WebLinkAnchor({
  anchorProps,
  children,
  fileLink,
}: LinkRendererProps & { fileLink: ReturnType<typeof useFileLink> }) {
  const { tooltipPath, onHoverIn } = fileLink;
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  const renderAnchor = (onContextMenu?: (event: MouseEvent) => void) => (
    <a
      {...anchorProps}
      style={anchorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onContextMenu={onContextMenu}
    >
      {children}
    </a>
  );
  const anchor = fileLink.target ? (
    <WebLinkContextMenuOpener>{(open) => renderAnchor(open)}</WebLinkContextMenuOpener>
  ) : (
    renderAnchor()
  );
  return (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild onHoverIn={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltipPath ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltipPath}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };

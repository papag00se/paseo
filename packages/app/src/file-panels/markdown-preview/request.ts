import { z } from "zod";
import { isAbsolutePath } from "@/utils/path";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

export interface PreviewClient {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

const previewResponse = z.object({ url: z.string().url(), hostname: z.string() });
const filePreviewResponse = previewResponse.extend({ filePath: z.string().min(1) });

/** The caller owns a returned session, including releasing late responses after unmount. */
export async function openMarkdownFilePreview(
  client: PreviewClient,
  input: { path: string; workspaceRoot: string | null; workspaceId: string },
): Promise<string> {
  if (!input.workspaceRoot && !isAbsolutePath(input.path)) {
    throw new Error("An absolute Markdown file path is required without a workspace directory.");
  }
  const paths = resolveWorkspaceFilePaths({
    path: input.path,
    workspaceRoot: input.workspaceRoot ?? "/",
  });
  if (!paths) throw new Error("Choose a Markdown file to preview.");
  const relativePath = input.workspaceRoot ? paths.relativePath : null;
  const raw = relativePath
    ? await client.invokePluginRpc("markdown-preview", "preview.open", {
        workspaceId: input.workspaceId,
        filePath: relativePath,
        embedded: true,
      })
    : await client.invokePluginRpc("markdown-preview", "preview.file.open", {
        filePath: paths.absolutePath,
      });
  const response = previewResponse.parse(raw);
  try {
    const selected = relativePath ?? filePreviewResponse.parse(raw).filePath;
    const url = new URL(response.url);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      throw new Error("Invalid Markdown preview address.");
    }
    if (url.searchParams.get("embedded") !== "1" || url.searchParams.get("file") !== selected) {
      throw new Error("The Markdown Preview plugin returned a preview for a different file.");
    }
    return response.url;
  } catch (error) {
    // A malformed response must not strand a session already allocated by the host.
    await client
      .invokePluginRpc("markdown-preview", "preview.close", { url: response.url })
      .catch(() => undefined);
    throw error;
  }
}

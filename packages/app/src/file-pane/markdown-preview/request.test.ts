import { describe, expect, it } from "vitest";
import { openMarkdownFilePreview, type PreviewClient } from "./request";

class PreviewHost implements PreviewClient {
  calls: { method: string; input: unknown }[] = [];
  response: unknown = {
    url: "http://127.0.0.1:3210/preview/session?file=Notes%20%26%20ideas.md&embedded=1",
    hostname: "local",
    filePath: "Notes & ideas.md",
  };
  async invokePluginRpc(_plugin: string, method: string, input: unknown) {
    this.calls.push({ method, input });
    return this.response;
  }
}

describe("Markdown file-tab preview requests", () => {
  it("opens an external tab through a single-file grant, not its parent directory", async () => {
    const host = new PreviewHost();
    const url = await openMarkdownFilePreview(host, {
      path: "/notes/Notes & ideas.md",
      workspaceRoot: "/repo",
      workspaceId: "work",
    });
    expect(new URL(url).searchParams.get("file")).toBe("Notes & ideas.md");
    expect(host.calls).toEqual([
      { method: "preview.file.open", input: { filePath: "/notes/Notes & ideas.md" } },
    ]);
  });

  it("preserves workspace-relative preview behavior", async () => {
    const host = new PreviewHost();
    host.response = {
      url: "http://127.0.0.1:3210/preview/session?file=docs%2Fguide.md&embedded=1",
      hostname: "local",
    };
    await openMarkdownFilePreview(host, {
      path: "docs/guide.md",
      workspaceRoot: "/repo",
      workspaceId: "work",
    });
    expect(host.calls).toEqual([
      {
        method: "preview.open",
        input: { workspaceId: "work", filePath: "docs/guide.md", embedded: true },
      },
    ]);
  });

  it("supports absolute tabs without a workspace directory but rejects unanchored relative paths", async () => {
    const host = new PreviewHost();
    await openMarkdownFilePreview(host, {
      path: "/notes/Notes & ideas.md",
      workspaceRoot: null,
      workspaceId: "work",
    });
    expect(host.calls[0]).toEqual({
      method: "preview.file.open",
      input: { filePath: "/notes/Notes & ideas.md" },
    });
    await expect(
      openMarkdownFilePreview(host, { path: "notes.md", workspaceRoot: null, workspaceId: "work" }),
    ).rejects.toThrow("absolute");
    expect(host.calls).toHaveLength(1);
  });

  it("releases allocated sessions when the host returns the wrong file or an unsafe address", async () => {
    for (const url of [
      "http://127.0.0.1:3210/preview/session?file=wrong.md&embedded=1",
      "http://example.com/preview/session?file=docs%2Fguide.md&embedded=1",
    ]) {
      const host = new PreviewHost();
      host.response = { url, hostname: "local" };
      await expect(
        openMarkdownFilePreview(host, {
          path: "docs/guide.md",
          workspaceRoot: "/repo",
          workspaceId: "work",
        }),
      ).rejects.toThrow();
      expect(host.calls.at(-1)).toEqual({ method: "preview.close", input: { url } });
    }
  });
});

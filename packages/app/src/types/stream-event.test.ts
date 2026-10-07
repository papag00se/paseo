import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { ThoughtItem } from "@/types/stream";
import { applyStreamEvent } from "@/types/stream";

const baseTimestamp = new Date(0);

const assistantChunk = (text: string, messageId?: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "assistant_message",
    text,
    ...(messageId ? { messageId } : {}),
  },
});

const toolCallEvent = (): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "tool_call",
    callId: "head-tail-tool-call",
    name: "run",
    status: "running",
    detail: {
      type: "unknown",
      input: { command: "echo hi" },
      output: null,
    },
    error: null,
  },
});

const completionEvent = (): AgentStreamEventPayload => ({
  type: "turn_completed",
  provider: "codex",
});

const permissionEvent = (): AgentStreamEventPayload => ({
  type: "permission_requested",
  provider: "codex",
  request: {
    id: "perm-1",
    provider: "codex",
    name: "test",
    kind: "tool",
  },
});

const reasoningChunk = (text: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "claude",
  item: {
    type: "reasoning",
    text,
  },
});

describe("applyStreamEvent", () => {
  it("buffers reasoning chunks in head", () => {
    const result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("thought");
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
    expect((result.head[0] as ThoughtItem).status).toBe("loading");
  });

  it("accumulates reasoning chunks in head", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me "),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: reasoningChunk("think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
  });

  it("continues a hydrated reasoning prefix without adding a second scrolling row", () => {
    const prefix: ThoughtItem = {
      kind: "thought",
      id: "hydrated-thought",
      text: "Let me ",
      status: "ready",
      timestamp: baseTimestamp,
      timelineCursor: { epoch: "epoch-a", seq: 10 },
    };
    const result = applyStreamEvent({
      tail: [prefix],
      head: [],
      event: reasoningChunk("think..."),
      timestamp: baseTimestamp,
      timelineCursor: { epoch: "epoch-a", seq: 11 },
    });
    expect(result.tail).toEqual([]);
    expect(result.head).toEqual([
      expect.objectContaining({
        id: prefix.id,
        text: "Let me think...",
        status: "loading",
        timelineCursor: { epoch: "epoch-a", seq: 11 },
      }),
    ]);
  });

  it("does not resume reasoning across a sequence gap or epoch replacement", () => {
    const prefix: ThoughtItem = {
      kind: "thought",
      id: "old-thought",
      text: "Previous turn",
      status: "ready",
      timestamp: baseTimestamp,
      timelineCursor: { epoch: "epoch-a", seq: 10 },
    };
    for (const cursor of [
      { epoch: "epoch-a", seq: 12 },
      { epoch: "epoch-b", seq: 11 },
    ]) {
      const result = applyStreamEvent({
        tail: [prefix],
        head: [],
        event: reasoningChunk("New thought"),
        timestamp: baseTimestamp,
        timelineCursor: cursor,
      });
      expect(result.tail).toEqual([prefix]);
      expect(result.head).toHaveLength(1);
      expect((result.head[0] as ThoughtItem).text).toBe("New thought");
    }
  });

  it("flushes reasoning to tail when tool call arrives", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: toolCallEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(2);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.tail[1].kind).toBe("tool_call");
  });

  it("flushes head on turn completion", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: assistantChunk("Hello"),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: completionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("assistant_message");
  });

  it("does not continue a tail assistant message when the incoming message id differs", () => {
    const result = applyStreamEvent({
      tail: [
        {
          kind: "assistant_message",
          id: "msg-first",
          messageId: "msg-first",
          text: "First answer.",
          timestamp: baseTimestamp,
        },
      ],
      head: [],
      event: assistantChunk("Second answer.", "msg-second"),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(1);
    expect(result.head).toHaveLength(1);
    expect(result.tail[0].kind).toBe("assistant_message");
    expect(result.head[0].kind).toBe("assistant_message");
    if (
      result.tail[0].kind === "assistant_message" &&
      result.head[0].kind === "assistant_message"
    ) {
      expect(result.tail[0].text).toBe("First answer.");
      expect(result.head[0].text).toBe("Second answer.");
      expect(result.head[0].messageId).toBe("msg-second");
    }
  });

  it("flushes reasoning when assistant message starts", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: assistantChunk("Here's my answer"),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("assistant_message");
  });

  it("keeps references stable for no-op events", () => {
    const tail: ReturnType<typeof applyStreamEvent>["tail"] = [];
    const head: ReturnType<typeof applyStreamEvent>["head"] = [];

    const result = applyStreamEvent({
      tail,
      head,
      event: permissionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toBe(tail);
    expect(result.head).toBe(head);
    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);
  });
});

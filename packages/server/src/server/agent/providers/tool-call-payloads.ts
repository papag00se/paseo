// Shared normalization for Pi-family (Pi, OMP) tool calls before they become timeline items.

// Models routinely send `null` for optional tool arguments (e.g. read offset/limit); the
// runtimes treat that as omitted, so the mappers must too or the call degrades to an
// unknown card that carries the raw result.
export function omitNullArgs(rawArgs: unknown): unknown {
  if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
    return rawArgs;
  }
  return Object.fromEntries(Object.entries(rawArgs).filter(([, value]) => value !== null));
}

// Inline base64 images (screenshots, renders) can be megabytes each. A timeline card only
// needs to know an image was returned; shipping the bytes overflows the client socket.
export function withoutInlineImageData<T>(result: T): T {
  if (!result || typeof result !== "object") {
    return result;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return result;
  }
  return {
    ...result,
    content: content.map((block: unknown) => {
      if (
        !block ||
        typeof block !== "object" ||
        (block as { type?: unknown }).type !== "image" ||
        typeof (block as { data?: unknown }).data !== "string"
      ) {
        return block;
      }
      // Copy, never mutate: the block belongs to the provider's stored history.
      const copy: Record<string, unknown> = Object.assign({}, block as Record<string, unknown>);
      copy.omittedBase64Chars = (copy.data as string).length;
      delete copy.data;
      return copy;
    }),
  };
}

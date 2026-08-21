// Shared by GET /session/start and GET /messages/unread. Bounded separately
// once, and only one of them got fixed, hence one file.

// Truncation is always declared. An agent that cannot tell a clipped body from
// a whole one will quote the clipped one as if it were complete.
export function clip(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: text.slice(0, limit) + "…", truncated: true };
}

// Small metadata passes through untouched. That is the common case, and a
// follow-up call to recover `{ branchName, roundNumber }` would be absurd.
export function clipMetadata(metadata: unknown, limit: number): unknown {
  if (!metadata || typeof metadata !== "object") return metadata;
  if (JSON.stringify(metadata).length <= limit) return metadata;
  return { _truncated: true, keys: Object.keys(metadata as Record<string, unknown>) };
}

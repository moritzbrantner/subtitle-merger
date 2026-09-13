const MAX_HISTORY_ENTRIES = 20;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

export type DocumentHistory = {
  undo: Uint8Array[];
  redo: Uint8Array[];
};

function trimHistory(entries: Uint8Array[]): Uint8Array[] {
  let start = entries.length;
  let bytes = 0;
  let count = 0;

  while (start > 0 && count < MAX_HISTORY_ENTRIES) {
    const entry = entries[start - 1];
    if (count > 0 && bytes + entry.byteLength > MAX_HISTORY_BYTES) {
      break;
    }
    start -= 1;
    count += 1;
    bytes += entry.byteLength;
    if (bytes >= MAX_HISTORY_BYTES) {
      break;
    }
  }

  return entries.slice(start);
}

export function recordAcceptedDocument(
  history: DocumentHistory | undefined,
  currentSource: Uint8Array,
): DocumentHistory {
  return {
    undo: trimHistory([...(history?.undo ?? []), currentSource]),
    redo: [],
  };
}

export function undoAcceptedDocument(
  history: DocumentHistory | undefined,
  currentSource: Uint8Array,
): { source: Uint8Array; history: DocumentHistory } | undefined {
  if (!history || history.undo.length === 0) {
    return undefined;
  }
  const source = history.undo[history.undo.length - 1];
  return {
    source,
    history: {
      undo: history.undo.slice(0, -1),
      redo: trimHistory([...history.redo, currentSource]),
    },
  };
}

export function redoAcceptedDocument(
  history: DocumentHistory | undefined,
  currentSource: Uint8Array,
): { source: Uint8Array; history: DocumentHistory } | undefined {
  if (!history || history.redo.length === 0) {
    return undefined;
  }
  const source = history.redo[history.redo.length - 1];
  return {
    source,
    history: {
      undo: trimHistory([...history.undo, currentSource]),
      redo: history.redo.slice(0, -1),
    },
  };
}

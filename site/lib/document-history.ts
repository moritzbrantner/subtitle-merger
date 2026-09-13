const MAX_HISTORY_ENTRIES = 20;

export type DocumentHistory = {
  undo: Uint8Array[];
  redo: Uint8Array[];
};

export function emptyDocumentHistory(): DocumentHistory {
  return { undo: [], redo: [] };
}

export function recordAcceptedDocument(
  history: DocumentHistory | undefined,
  currentSource: Uint8Array,
): DocumentHistory {
  const undo = [...(history?.undo ?? []), currentSource];
  return {
    undo: undo.slice(-MAX_HISTORY_ENTRIES),
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
      redo: [...history.redo, currentSource].slice(-MAX_HISTORY_ENTRIES),
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
      undo: [...history.undo, currentSource].slice(-MAX_HISTORY_ENTRIES),
      redo: history.redo.slice(0, -1),
    },
  };
}

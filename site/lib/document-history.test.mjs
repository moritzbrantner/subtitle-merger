import { expect, test } from "bun:test";

import {
  recordAcceptedDocument,
  redoAcceptedDocument,
  undoAcceptedDocument,
} from "./document-history.ts";

function bytes(value) {
  return new TextEncoder().encode(value);
}

function text(value) {
  return new TextDecoder().decode(value);
}

test("undo and redo traverse accepted document states deterministically", () => {
  const a = bytes("A");
  const b = bytes("B");
  const c = bytes("C");

  let history = recordAcceptedDocument(undefined, a);
  history = recordAcceptedDocument(history, b);

  const undo = undoAcceptedDocument(history, c);
  expect(undo).toBeDefined();
  expect(text(undo.source)).toBe("B");

  const undoAgain = undoAcceptedDocument(undo.history, undo.source);
  expect(undoAgain).toBeDefined();
  expect(text(undoAgain.source)).toBe("A");

  const redo = redoAcceptedDocument(undoAgain.history, undoAgain.source);
  expect(redo).toBeDefined();
  expect(text(redo.source)).toBe("B");
});

test("a new accepted edit clears the redo branch", () => {
  const a = bytes("A");
  const b = bytes("B");
  const c = bytes("C");

  const history = recordAcceptedDocument(recordAcceptedDocument(undefined, a), b);
  const undo = undoAcceptedDocument(history, c);
  expect(undo).toBeDefined();
  expect(undo.history.redo).toHaveLength(1);

  const branched = recordAcceptedDocument(undo.history, undo.source);
  expect(branched.redo).toHaveLength(0);
});

test("history keeps only the newest twenty accepted states", () => {
  let history;
  for (let index = 0; index < 25; index += 1) {
    history = recordAcceptedDocument(history, bytes(String(index)));
  }

  expect(history.undo).toHaveLength(20);
  expect(text(history.undo[0])).toBe("5");
  expect(text(history.undo[19])).toBe("24");
});

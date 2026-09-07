let wasmPromise;

async function loadWasm(url) {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load the Rust WebAssembly module (${response.status}).`);
      }
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })();
  }
  return wasmPromise;
}

function decodePackedJson(wasm, packed) {
  const outputPtr = Number(packed & 0xffff_ffffn);
  const outputLen = Number(packed >> 32n);
  if (outputLen === 0) {
    throw new Error("Rust returned an empty response.");
  }
  try {
    const bytes = new Uint8Array(wasm.memory.buffer, outputPtr, outputLen);
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    wasm.deallocate(outputPtr, outputLen);
  }
}

async function inspect(file, wasmUrl) {
  const wasm = await loadWasm(wasmUrl);
  const handle = wasm.inspection_create(BigInt(file.size));
  if (!handle) {
    throw new Error("Rust could not create a video inspection session.");
  }

  let transferred = 0;
  try {
    for (;;) {
      const status = decodePackedJson(wasm, wasm.inspection_poll(handle));
      if (status.status === "done") {
        self.postMessage({ type: "result", inspection: status.inspection });
        return;
      }
      if (status.status === "error") {
        throw new Error(status.message || "Rust video inspection failed.");
      }
      if (status.status !== "read") {
        throw new Error("Rust returned an unknown video inspection state.");
      }

      const offset = Number(status.offset);
      const length = Number(status.length);
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
        throw new Error("Rust requested an invalid file range.");
      }
      const end = Math.min(file.size, offset + length);
      const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
      if (bytes.byteLength !== length) {
        throw new Error(`Could not read the requested video range ${offset}..${end}.`);
      }

      const inputPtr = wasm.allocate(bytes.byteLength);
      if (bytes.byteLength > 0 && inputPtr === 0) {
        throw new Error("WebAssembly could not allocate memory for a video range.");
      }
      try {
        new Uint8Array(wasm.memory.buffer, inputPtr, bytes.byteLength).set(bytes);
        const accepted = wasm.inspection_supply(
          handle,
          BigInt(offset),
          inputPtr,
          bytes.byteLength,
        );
        if (!accepted) {
          throw new Error("Rust rejected the supplied video range.");
        }
      } finally {
        wasm.deallocate(inputPtr, bytes.byteLength);
      }

      transferred += bytes.byteLength;
      self.postMessage({
        type: "progress",
        phase: status.phase || "Inspecting video",
        transferred,
        fileSize: file.size,
      });
    }
  } finally {
    wasm.inspection_destroy(handle);
  }
}

self.onmessage = async (event) => {
  const message = event.data;
  if (!message || message.type !== "inspect" || !(message.file instanceof File)) {
    return;
  }
  try {
    await inspect(message.file, message.wasmUrl);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "The video could not be inspected.",
    });
  }
};

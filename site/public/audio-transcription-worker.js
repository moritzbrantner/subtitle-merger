import * as transcription from "./vendor/audio-analysis-transcription.js";

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
    throw new Error("Rust returned an empty audio-demux response.");
  }
  try {
    const bytes = new Uint8Array(wasm.memory.buffer, outputPtr, outputLen);
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    wasm.deallocate(outputPtr, outputLen);
  }
}

function decodeHex(value) {
  if (!value) {
    return undefined;
  }
  if (typeof value !== "string" || value.length % 2 !== 0) {
    throw new Error("Rust returned invalid audio decoder metadata.");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    const parsed = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isFinite(parsed)) {
      throw new Error("Rust returned invalid audio decoder metadata.");
    }
    bytes[index] = parsed;
  }
  return bytes;
}

function decoderConfig(status) {
  const config = {
    codec: status.codec,
    sampleRate: status.sampleRate,
    numberOfChannels: status.numberOfChannels,
  };
  const description = decodeHex(status.descriptionHex);
  if (description?.byteLength) {
    config.description = description;
  }
  return config;
}

function assertSafeRange(offset, length, fileSize) {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset + length > fileSize
  ) {
    throw new Error(`Rust requested an invalid audio file range ${offset}..${offset + length}.`);
  }
}

async function readRange(file, offset, length) {
  assertSafeRange(offset, length, file.size);
  const end = offset + length;
  const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
  if (bytes.byteLength !== length) {
    throw new Error(`Could not read the requested audio range ${offset}..${end}.`);
  }
  return bytes;
}

function supplyRange(wasm, handle, offset, bytes) {
  const inputPtr = wasm.allocate(bytes.byteLength);
  if (bytes.byteLength > 0 && inputPtr === 0) {
    throw new Error("WebAssembly could not allocate memory for audio metadata.");
  }
  try {
    new Uint8Array(wasm.memory.buffer, inputPtr, bytes.byteLength).set(bytes);
    if (!wasm.audio_demux_supply(handle, BigInt(offset), inputPtr, bytes.byteLength)) {
      throw new Error("Rust rejected the supplied audio metadata range.");
    }
  } finally {
    wasm.deallocate(inputPtr, bytes.byteLength);
  }
}

function acknowledge(wasm, handle, label) {
  if (!wasm.audio_demux_acknowledge(handle)) {
    throw new Error(`Rust rejected the ${label} acknowledgement.`);
  }
}

async function transcribeFile(file, wasmUrl, modelId) {
  if (typeof AudioDecoder !== "function" || typeof EncodedAudioChunk !== "function") {
    throw new Error("Browser subtitle generation requires WebCodecs AudioDecoder support.");
  }
  if (!(await transcription.supportsBrowserTranscription())) {
    throw new Error("WebGPU is required for browser subtitle generation.");
  }
  if (typeof transcription.createBrowserDecodedAudioTranscriptionSession !== "function") {
    throw new Error("The browser transcription runtime does not expose decoded-audio transcription.");
  }

  const wasm = await loadWasm(wasmUrl);
  const handle = wasm.audio_demux_create(BigInt(file.size));
  if (!handle) {
    throw new Error("Rust could not create an audio demux session.");
  }

  const session = transcription.createBrowserDecodedAudioTranscriptionSession({
    source: file.name,
    modelId,
    onProgress: (progress) => self.postMessage({ type: "progress", progress }),
  });

  let decoder;
  let decoderFailure;
  let processing = Promise.resolve();
  let transferred = 0;

  const queueDecodedAudio = (audioData) => {
    processing = processing.then(async () => {
      if (decoderFailure) {
        audioData.close();
        return;
      }
      try {
        await session.push(audioData);
      } catch (error) {
        decoderFailure = error instanceof Error ? error : new Error(String(error));
      }
    });
  };

  try {
    for (;;) {
      const status = decodePackedJson(wasm, wasm.audio_demux_poll(handle));

      if (status.status === "done") {
        if (!decoder) {
          throw new Error("Rust finished audio demux without a decoder configuration.");
        }
        await decoder.flush();
        await processing;
        if (decoderFailure) {
          throw decoderFailure;
        }
        const result = await session.flush();
        self.postMessage({
          type: "result",
          result: {
            ...result,
            attributes: {
              ...(result.attributes ?? {}),
              mediaAcquisition: "wasm-range",
              audioDecode: "webcodecs",
            },
          },
        });
        return;
      }

      if (status.status === "error") {
        throw new Error(status.message || "Rust audio demux failed.");
      }

      if (status.status === "config") {
        const config = decoderConfig(status);
        const support = await AudioDecoder.isConfigSupported(config);
        if (!support.supported) {
          throw new Error(
            `This browser cannot decode the selected audio track (${config.codec}, ${config.sampleRate} Hz, ${config.numberOfChannels} channels).`,
          );
        }
        decoder = new AudioDecoder({
          output: queueDecodedAudio,
          error(error) {
            decoderFailure ??= error instanceof Error ? error : new Error(String(error));
          },
        });
        decoder.configure(support.config ?? config);
        acknowledge(wasm, handle, "audio decoder configuration");
        self.postMessage({
          type: "progress",
          progress: {
            stage: "decode",
            message: `Decoding ${config.codec} audio from bounded local file ranges…`,
          },
        });
        continue;
      }

      if (status.status === "read") {
        const offset = Number(status.offset);
        const length = Number(status.length);
        const bytes = await readRange(file, offset, length);
        supplyRange(wasm, handle, offset, bytes);
        transferred += bytes.byteLength;
        self.postMessage({
          type: "progress",
          progress: {
            stage: "decode",
            message: status.phase || "Reading local audio metadata…",
            detail: {
              transferred,
              fileSize: file.size,
            },
          },
        });
        continue;
      }

      if (status.status === "batch") {
        if (!decoder) {
          throw new Error("Rust emitted encoded audio before configuring the decoder.");
        }
        const offset = Number(status.offset);
        const length = Number(status.length);
        const bytes = await readRange(file, offset, length);
        transferred += bytes.byteLength;

        for (const chunk of status.chunks ?? []) {
          const chunkOffset = Number(chunk.offset);
          const chunkLength = Number(chunk.length);
          const relative = chunkOffset - offset;
          if (
            !Number.isSafeInteger(relative)
            || relative < 0
            || chunkLength <= 0
            || relative + chunkLength > bytes.byteLength
          ) {
            throw new Error("Rust emitted an encoded audio chunk outside its requested range.");
          }
          const timestamp = Number(chunk.timestampUs);
          const duration =
            chunk.durationUs === undefined ? undefined : Number(chunk.durationUs);
          if (
            !Number.isSafeInteger(timestamp)
            || timestamp < 0
            || (duration !== undefined && (!Number.isSafeInteger(duration) || duration < 0))
          ) {
            throw new Error("Rust emitted invalid encoded audio timing.");
          }
          decoder.decode(
            new EncodedAudioChunk({
              type: "key",
              timestamp,
              ...(duration === undefined ? {} : { duration }),
              data: bytes.slice(relative, relative + chunkLength),
            }),
          );
        }

        await decoder.flush();
        await processing;
        if (decoderFailure) {
          throw decoderFailure;
        }
        acknowledge(wasm, handle, "audio batch");
        self.postMessage({
          type: "progress",
          progress: {
            stage: "decode",
            message: "Decoded bounded audio ranges locally…",
            detail: {
              transferred,
              fileSize: file.size,
              bufferedSeconds: session.bufferedSeconds,
            },
          },
        });
        continue;
      }

      throw new Error("Rust returned an unknown audio-demux state.");
    }
  } finally {
    if (decoder && decoder.state !== "closed") {
      decoder.close();
    }
    wasm.audio_demux_destroy(handle);
  }
}

self.onmessage = async (event) => {
  const message = event.data;
  if (
    !message
    || message.type !== "transcribe"
    || !(message.file instanceof File)
    || typeof message.modelId !== "string"
  ) {
    return;
  }

  try {
    await transcribeFile(message.file, message.wasmUrl, message.modelId);
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Browser subtitle generation failed.",
      name: error instanceof DOMException ? error.name : undefined,
    });
  }
};

// open-sse/services/compression/engines/llmlingua/onnxWorker.ts
import { parentPort } from "node:worker_threads";

// open-sse/services/compression/engines/llmlingua/modelStore.ts
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// open-sse/services/compression/engines/llmlingua/constants.ts
var DEFAULT_LLMLINGUA_MODEL = "tinybert";
var LLMLINGUA_MODELS = {
  tinybert: {
    id: "tinybert",
    hfRepo: "atjsh/llmlingua-2-js-tinybert-meetingbank",
    factory: "WithBERTMultilingual",
    dtype: "fp32",
    subfolder: "",
    sizeMB: 57,
    label: "TinyBERT (57MB, fast \u2014 default)"
  },
  "bert-base": {
    id: "bert-base",
    hfRepo: "Arcoldd/llmlingua4j-bert-base-onnx",
    factory: "WithBERTMultilingual",
    dtype: "fp32",
    subfolder: "",
    sizeMB: 710,
    label: "BERT-base (710MB, higher accuracy)"
  }
};

// open-sse/services/compression/engines/llmlingua/modelStore.ts
function getDataDir() {
  return process.env.DATA_DIR || path.join(os.homedir(), ".omniroute");
}
function getLlmlinguaModelCacheDir() {
  const dir = path.join(getDataDir(), "models", "llmlingua");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
  return dir;
}
function resolveLlmlinguaModel(modelId) {
  if (typeof modelId === "string" && modelId.length > 0 && LLMLINGUA_MODELS[modelId]) {
    return LLMLINGUA_MODELS[modelId];
  }
  return LLMLINGUA_MODELS[DEFAULT_LLMLINGUA_MODEL];
}
function configureTransformersEnv(env, opts) {
  env.cacheDir = getLlmlinguaModelCacheDir();
  if (typeof opts.modelPath === "string" && opts.modelPath.length > 0) {
    env.localModelPath = opts.modelPath;
    env.allowRemoteModels = false;
  } else {
    env.allowRemoteModels = true;
  }
}

// open-sse/services/compression/engines/llmlingua/onnxWorker.ts
function dynamicImport(specifier) {
  return import(
    /* @vite-ignore */
    specifier
  );
}
var compressorCache = /* @__PURE__ */ new Map();
function cacheKey(entry, modelPath) {
  return `${entry.factory}:${entry.hfRepo}:${modelPath || ""}`;
}
async function getCompressor(entry, modelPath) {
  const { env } = await dynamicImport("@huggingface/transformers");
  configureTransformersEnv(env, { modelPath });
  const { LLMLingua2 } = await dynamicImport("@atjsh/llmlingua-2");
  const { Tiktoken } = await dynamicImport("js-tiktoken/lite");
  const o200k_base = (await dynamicImport("js-tiktoken/ranks/o200k_base")).default;
  const oai = new Tiktoken(o200k_base);
  const { promptCompressor } = await LLMLingua2[entry.factory](entry.hfRepo, {
    transformerJSConfig: { device: "cpu", dtype: entry.dtype },
    oaiTokenizer: oai,
    modelSpecificOptions: { subfolder: entry.subfolder },
    // MUST silence — the lib console.logs huge objects otherwise.
    logger: () => {
    }
  });
  return { compressor: promptCompressor, oai };
}
var MAX_SEG_TOKENS = 450;
async function compressSegmented(compressor, oai, text, rate) {
  const tokens = oai.encode(text);
  if (tokens.length <= MAX_SEG_TOKENS) {
    return compressor.compress(text, { rate });
  }
  const segments = [];
  const END_TOKENS = /* @__PURE__ */ new Set([".", "\n", "!", "?", ";"]);
  let st = 0;
  while (st < tokens.length) {
    let ed = Math.min(st + MAX_SEG_TOKENS, tokens.length);
    for (let j = 0; j < Math.min(80, ed - st); j++) {
      const tok = oai.decode(tokens.slice(ed - 1 - j, ed - j));
      if (END_TOKENS.has(tok)) {
        ed = ed - j;
        break;
      }
    }
    if (ed <= st) ed = Math.min(st + MAX_SEG_TOKENS, tokens.length);
    segments.push(oai.decode(tokens.slice(st, ed)));
    st = ed;
  }
  const out = [];
  for (const seg of segments) {
    out.push(await compressor.compress(seg, { rate }));
  }
  return out.join("\n");
}
if (parentPort) {
  parentPort.on("message", async (msg) => {
    const { id, text } = msg;
    try {
      const entry = resolveLlmlinguaModel(msg.model);
      const key = cacheKey(entry, msg.modelPath);
      let pending = compressorCache.get(key);
      if (!pending) {
        pending = getCompressor(entry, msg.modelPath);
        compressorCache.set(key, pending);
        pending.catch(() => {
          compressorCache.delete(key);
        });
      }
      const { compressor, oai } = await pending;
      const rate = typeof msg.compressionRate === "number" ? msg.compressionRate : 0.5;
      const out = await compressSegmented(compressor, oai, text, rate);
      parentPort.postMessage({ id, ok: true, text: out });
    } catch {
      parentPort.postMessage({ id, ok: false, text });
    }
  });
}

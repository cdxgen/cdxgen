const AI_MODEL_VARIANT_PATTERNS = [
  {
    variant: "fine-tuned",
    patterns: [/\bfine[-_\s]?tun(?:e|ed|ing)\b/iu, /\bfinetun(?:e|ed|ing)\b/iu],
  },
  {
    variant: "distilled",
    patterns: [/\bdistill(?:ed|ation)?\b/iu],
  },
  {
    variant: "quantized",
    patterns: [
      /\bquantiz(?:e|ed|ation)\b/iu,
      /\b(?:awq|gptq|gguf|bnb|int4|int8|4-bit|8-bit|fp8)\b/iu,
      /\bq\d(?:_[a-z0-9]+)*\b/iu,
    ],
  },
  {
    variant: "adapter",
    patterns: [/\badapter\b/iu, /\blora\b/iu, /\bqlora\b/iu, /\bpeft\b/iu],
  },
  {
    variant: "merged",
    patterns: [/\bmerge[dr]?\b/iu, /\bmergekit\b/iu],
  },
  {
    variant: "abliterated",
    patterns: [/\babliterat(?:e|ed|ion)\b/iu],
  },
  {
    variant: "unlocked",
    patterns: [
      /\bunlocked\b/iu,
      /\buncensored\b/iu,
      /\bunfiltered\b/iu,
      /\bde-?aligned\b/iu,
      /\bjailbreak(?:ed)?\b/iu,
    ],
  },
];

const AI_MODEL_RELATION_VARIANTS = new Map([
  ["adapter", "adapter"],
  ["distillation", "distilled"],
  ["distilled", "distilled"],
  ["finetune", "fine-tuned"],
  ["fine-tune", "fine-tuned"],
  ["fine_tune", "fine-tuned"],
  ["finetuned", "fine-tuned"],
  ["merge", "merged"],
  ["merged", "merged"],
  ["quantized", "quantized"],
]);

const toSignalStrings = (value) =>
  (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .flatMap((entry) =>
      typeof entry === "string"
        ? [entry]
        : entry && typeof entry === "object"
          ? Object.values(entry)
          : [],
    )
    .filter(Boolean)
    .map((entry) => String(entry));

/**
 * Normalize a list of detected AI model variant labels into a unique string array.
 *
 * @param {unknown[]} [variants=[]] detected variant candidates
 * @returns {string[]} normalized variant labels
 */
export function normalizeDetectedVariants(variants = []) {
  return [
    ...new Set(
      (variants || []).filter(Boolean).map((variant) => String(variant)),
    ),
  ];
}

/**
 * Detect normalized AI model variant labels from names, metadata, and notes.
 *
 * @param {{
 *   description?: string,
 *   metadata?: unknown[],
 *   modelName?: string,
 *   notes?: unknown[],
 *   quantization?: string,
 *   relation?: string,
 *   tags?: unknown[],
 * }} [signals] variant detection signals
 * @returns {string[]} normalized variant labels
 */
export function detectAiModelVariants(signals = {}) {
  const detected = new Set();
  const relation = String(signals?.relation || "")
    .trim()
    .toLowerCase();
  if (relation && AI_MODEL_RELATION_VARIANTS.has(relation)) {
    detected.add(AI_MODEL_RELATION_VARIANTS.get(relation));
  }
  if (signals?.quantization) {
    detected.add("quantized");
  }
  const texts = [
    ...toSignalStrings(signals?.modelName),
    ...toSignalStrings(signals?.description),
    ...toSignalStrings(signals?.tags),
    ...toSignalStrings(signals?.notes),
    ...toSignalStrings(signals?.metadata),
  ];
  for (const { variant, patterns } of AI_MODEL_VARIANT_PATTERNS) {
    if (texts.some((text) => patterns.some((pattern) => pattern.test(text)))) {
      detected.add(variant);
    }
  }
  return AI_MODEL_VARIANT_PATTERNS.map(({ variant }) => variant).filter(
    (variant) => detected.has(variant),
  );
}

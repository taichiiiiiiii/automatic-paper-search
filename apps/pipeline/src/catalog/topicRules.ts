/**
 * Fine-grained topic taxonomy — TS port of `TOPIC_RULES` in
 * `paperpilot/scripts/build_summary_csv.py` (CAT-25..27 of
 * docs/migration/safety-contracts.md). A paper gets EVERY tag whose
 * pattern matches its title+abstract, so categories overlap freely.
 *
 * Ported verbatim (same patterns, same order — order matters for
 * `classifyTags`'s stable "first match" iteration, which feeds
 * `tagCounts`' insertion order). Each pattern string is the literal JS
 * string equivalent of the Python raw string it was copied from (e.g.
 * Python `r"\bllms?\b"` -> JS `"\\bllms?\\b"` — same two characters
 * `\` `b`, just escaped for a JS string literal instead of a Python raw
 * one) and is compiled with {@link pyRegex} for Python-`\b` parity.
 *
 * Do NOT reorder, add, or edit a pattern here without also updating
 * `paperpilot/scripts/build_summary_csv.py`'s `TOPIC_RULES` — until P5
 * cutover the two must keep producing the same tags for the same
 * title+abstract text (design doc §7.1 "一致した段の Python は...変更を凍結する").
 */

import { pyRegex } from "./pyRegex.js";

export const TOPIC_RULES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // ---- Model families / architectures ----
  ["LLM", ["\\bllms?\\b", "large language model", "language model"]],
  ["VLM", ["\\bvlms?\\b", "\\bmllms?\\b", "vision[- ]language", "multimodal"]],
  [
    "Diffusion",
    ["diffusion model", "\\bdiffusion\\b", "score[- ]based", "flow matching", "\\bddpm\\b"],
  ],
  ["Transformer", ["\\btransformers?\\b", "self[- ]attention", "attention mechanism"]],
  ["MoE", ["mixture[- ]of[- ]experts", "\\bmoe\\b"]],
  ["GAN", ["\\bgans?\\b", "generative adversarial"]],
  ["SSM", ["state[- ]space model", "\\bmamba\\b", "\\bssms?\\b"]],
  ["GNN", ["graph neural", "\\bgnns?\\b", "message passing"]],
  // ---- Computer-vision tasks (the old "Vision" bucket, split) ----
  ["Detection", ["object detection", "\\bdetection\\b", "\\bdetector"]],
  ["Segmentation", ["segmentation", "\\bsegment\\b"]],
  [
    "3D",
    [
      "\\b3d\\b",
      "\\bnerf\\b",
      "gaussian splat",
      "point cloud",
      "\\bmesh\\b",
      "depth estimation",
      "\\bslam\\b",
      "novel view",
    ],
  ],
  ["ImageGen", ["image generation", "image synthesis", "text[- ]to[- ]image", "\\bt2i\\b"]],
  ["VideoGen", ["video generation", "text[- ]to[- ]video", "\\bt2v\\b"]],
  ["Pose", ["pose estimation", "keypoint", "human pose", "6[- ]?dof"]],
  ["Tracking", ["object tracking", "\\bmot\\b", "re[- ]identification", "\\bre[- ]id\\b"]],
  [
    "Restoration",
    ["super[- ]resolution", "denois", "deblur", "inpaint", "image restoration", "dehaz"],
  ],
  // #356: bare \bface\b matched the English verb ("methods face the
  // challenge of ...") — 60.6% of 1,322 hits were certain verb-only false
  // positives. Require face-domain context instead. Bare "deepfake" is NOT
  // a face signal (audio deepfakes exist), so it stays out.
  [
    "Face",
    [
      "\\bfacial\\b",
      "\\bface (?:recognition|verification|identification|detection|generation" +
        "|synthesis|swap(?:ping)?|reenactment|editing|restoration" +
        "|anti-spoofing|alignment|parsing|attributes?|landmarks?" +
        "|forgery|clustering|images?|videos?)",
      "(?:human|3d|talking) faces?\\b",
      "\\bfaces? (?:datasets?|benchmarks?)",
      "talking[ -]head",
      "head[ -]avatars?\\b",
      "portrait (?:animation|generation)",
    ],
  ],
  ["OCR", ["\\bocr\\b", "text recognition", "document understanding", "scene text"]],
  [
    "VideoUnderstanding",
    ["action recognition", "video understanding", "temporal action", "video question"],
  ],
  ["Rendering", ["rendering", "radiance field", "neural render"]],
  // ---- NLP tasks ----
  ["QA", ["question answering", "\\bvqa\\b", "\\bqa\\b"]],
  ["Summarization", ["summari[sz]"]],
  ["Translation", ["machine translation", "\\bnmt\\b", "multilingual"]],
  ["Dialogue", ["\\bdialog", "conversational", "chatbot"]],
  ["IE", ["named entity", "\\bner\\b", "information extraction", "relation extraction"]],
  ["Reasoning", ["reasoning", "chain[- ]of[- ]thought", "\\bcot\\b"]],
  ["Code", ["code generation", "program synthesis", "code model", "\\bcoding\\b"]],
  ["RAG", ["\\brag\\b", "retrieval[- ]augmented"]],
  ["Agent", ["\\bagents?\\b", "tool use", "tool[- ]calling"]],
  // ---- Learning paradigms / techniques ----
  ["RL", ["reinforcement learning", "\\brl\\b", "policy gradient", "\\brlhf\\b"]],
  ["SSL", ["self[- ]supervised", "contrastive learning"]],
  ["FewShot", ["few[- ]shot", "zero[- ]shot", "in[- ]context learning"]],
  ["Meta", ["meta[- ]learning"]],
  [
    "Continual",
    ["continual", "lifelong learning", "catastrophic forgetting", "incremental learning"],
  ],
  ["Transfer", ["transfer learning", "domain adaptation", "domain generalization"]],
  ["Distillation", ["knowledge distillation", "\\bdistillation\\b"]],
  ["Quantization", ["quantiz", "low[- ]bit", "\\bint8\\b", "\\bint4\\b"]],
  ["Pruning", ["\\bpruning\\b", "sparsit"]],
  ["NAS", ["neural architecture search", "\\bnas\\b"]],
  ["Federated", ["federated"]],
  // ---- Trustworthy / safety ----
  [
    "Robustness",
    ["\\brobustness\\b", "out[- ]of[- ]distribution", "\\bood\\b", "distribution shift"],
  ],
  ["Adversarial", ["adversarial (attack|example|robust|perturbation|training)"]],
  ["Fairness", ["\\bfairness\\b", "debias"]],
  ["Privacy", ["\\bprivacy\\b", "differential privacy"]],
  ["Interpretability", ["interpretab", "explainab", "\\bxai\\b"]],
  [
    "Safety",
    [
      "\\bsafety\\b",
      "jailbreak",
      "hallucinat",
      "harmful",
      "\\btoxic",
      "guardrail",
      "preference align",
      "value align",
    ],
  ],
  ["Uncertainty", ["uncertainty", "calibrat", "\\bbayesian\\b"]],
  // ---- Domains ----
  ["Medical", ["medical", "clinical", "\\behr\\b", "radiolog", "patholog", "diagnosis"]],
  ["Bio", ["\\bprotein", "molecul", "drug discovery", "genomic"]],
  ["Audio", ["\\baudio\\b", "\\bspeech\\b", "\\basr\\b", "\\btts\\b", "\\bmusic\\b"]],
  ["Robotics", ["\\brobot", "manipulation", "locomotion", "navigation"]],
  ["Autonomous", ["autonomous driving", "self[- ]driving"]],
  // #356: bare "recommend" matched the prose verb ("we recommend careful
  // evaluation"). Noun forms cover every recommender-systems paper.
  ["Recommendation", ["recommendation", "recommender", "collaborative filtering"]],
  ["TimeSeries", ["time series", "forecast"]],
  ["Graph", ["graph representation", "graph learning"]],
  // ---- Theory / optimization / data ----
  ["Theory", ["theorem", "convergence", "theoretical", "\\bpac[- ]", "generalization bound"]],
  ["Optim", ["\\boptimizer\\b", "\\badam\\b", "\\bsgd\\b", "optimization algorithm"]],
  ["Causal", ["causal", "counterfactual"]],
  // benchmark/dataset only when the paper INTRODUCES one (not the
  // ubiquitous "we benchmark …" verb or "on the X dataset" mention).
  [
    "Benchmark",
    [
      "new benchmark",
      "\\bbenchmark (dataset|suite|for)",
      "comprehensive benchmark",
      "\\bbenchmarking\\b",
      "leaderboard",
    ],
  ],
  [
    "Dataset",
    [
      "new dataset",
      "large[- ]scale dataset",
      "(introduce|present|construct|collect|curat)\\w*\\s+(a\\s+)?(new\\s+)?dataset",
      "data curation",
    ],
  ],
] as const;

/** `TOPIC_RULES`, pre-compiled once at module load (Python-`\b`-correct, `u`-flagged). */
export const TOPIC_RULES_COMPILED: ReadonlyArray<readonly [string, readonly RegExp[]]> =
  TOPIC_RULES.map(([tag, patterns]) => [tag, patterns.map((p) => pyRegex(p))] as const);

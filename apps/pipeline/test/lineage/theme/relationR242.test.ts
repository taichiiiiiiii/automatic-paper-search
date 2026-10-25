/**
 * R2-42: precision read of the strong relations published on ICCV 2025 and
 * EMNLP 2025 (2026-10-22, read by hand: 9 of 13 right). The wrong ones are
 * pinned here as `baseline_only`; the right ones must stay strong.
 *
 * Wrong types:
 *  - building on / extending a *dataset or its tasks* the cited paper
 *    introduced (“an extended version of ReasonSeg [2]”, “build upon
 *    high-quality, human-verified tasks from WebArena-Lite”);
 *  - “Different from the above baselines, X …” — a contrast between two
 *    baselines in a baseline list, not with the citing paper.
 * Known gap (not fixable without a name→paper alias table): an algorithm
 * named in the cue object whose citation marker is the cited paper
 * (“an extension of GRPO (Qi et al., 2025)”, cited = WebRL).
 */

import { describe, expect, it } from "vitest";
import {
  classifyS2Pair,
  type PairSignals,
  usageReason,
  v1RelationFor,
} from "../../../src/lineage/classify/apiRelations.js";
import { isSurveyLike } from "../../../src/lineage/shared/surveyLike.js";

interface Case {
  name: string;
  cited: { title: string; year: number; authors: string[] };
  citing: string;
  sentence: string;
  /** All S2 contexts of the pair (some rules resolve the marker only with the full set). */
  contexts?: string[];
  /** S2 pair signals, when the case depends on them. */
  intents?: string[];
  influential?: boolean;
  expect: "extends" | "contrasts" | "baseline_only";
  knownGap?: boolean;
}

const CASES: Case[] = [
  {
    name: "SpatialVID builds on ReCamMaster",
    cited: {
      title: "ReCamMaster: Camera-Controlled Generative Rendering From a Single Video",
      year: 2025,
      authors: ["Jianhong Bai", "Menghan Xia"],
    },
    citing: "SpatialVID: A Large-Scale Video Dataset with Spatial Annotations",
    sentence:
      "We build upon the camera-control injection mechanism introduced in ReCamMaster [4] (excluding intrinsic parameters), adopting the Wan2.",
    expect: "extends",
  },
  {
    name: "WorldStereo extends the retrieval of Context as Memory",
    cited: {
      title: "Context as Memory: Scene-Consistent Interactive Long Video Generation",
      year: 2025,
      authors: ["Jiwen Yu"],
    },
    citing: "WorldStereo: Bridging Camera-Guided Video Generation and Scene Reconstruction",
    sentence:
      "We extend the retrieval strategy of [105] from 2D planes to 3D spaces, selecting views where the volumetric overlapping fields-of-view (FoV) between the target and reference camera frustums are maximized.",
    expect: "extends",
  },
  {
    name: "EditReward extends the HPSv3 ranking framework",
    cited: {
      title: "HPSv3: Towards Wide-Spectrum Human Preference Score",
      year: 2025,
      authors: ["Yuhang Ma"],
    },
    citing: "EditReward: A Human-Aligned Reward Model for Instruction-Guided Image Editing",
    sentence:
      "This approach extends the probabilistic ranking framework of HPSv3 (Sun et al., 2025) to our multi-dimensional task.",
    expect: "extends",
  },
  {
    name: "driving world model contrasts with image-space forecasting",
    cited: {
      title: "Driving Into the Future: Multiview Visual Forecasting and Planning with World Model",
      year: 2023,
      authors: ["Yuqi Wang"],
    },
    citing: "End-to-End Driving with Online Trajectory Evaluation via BEV World Model",
    sentence:
      "In contrast to prior work [40], which predict the future in image space, we build a world model in BEV space as it is much more efﬁcient.",
    expect: "contrasts",
  },
  {
    name: "AdaptThink contrast with an operator search",
    cited: {
      title: "AdaptThink: Reasoning Models Can Learn When to Think",
      year: 2025,
      authors: ["Jiajie Zhang"],
    },
    citing: "Neural Chain-of-Thought Search: Searching the Optimal Reasoning Path",
    sentence:
      "Unlike our fine-grained operator search which structures the internal steps of the reasoning chain, AdaptThink makes a binary, high-level decision on whether to engage the reasoning engine at all.",
    expect: "contrasts",
  },
  {
    name: "Memento contrasts with prior agents",
    cited: {
      title:
        "DeepResearcher: Scaling Deep Research via Reinforcement Learning in Real-world Environments",
      year: 2025,
      authors: ["Yuxiang Zheng"],
    },
    citing: "Memento: Fine-tuning LLM Agents without Fine-tuning LLMs",
    sentence:
      "Unlike prior agents (Zheng et al., 2025, Weng et al., 2025), Memento ’s executor supports rich reasoning and flexible tool composition.",
    expect: "contrasts",
  },
  {
    name: "EO-1 contrasts with prior VLA models",
    cited: {
      title: "π0: A Vision-Language-Action Flow Model for General Robot Control",
      year: 2024,
      authors: ["Kevin Black"],
    },
    citing: "EO-1: An Open Unified Embodied Foundation Model for General Robot Control",
    sentence:
      "Unlike prior VLA models (Black et al., 2024, 2025, Driess et al., 2025) that introduce extra action-specific modules to learn action generation, our design enables easier alignment between vision/language and action modalities through circ…",
    expect: "contrasts",
  },
  // ---- wrong in the published ICCV 2025 / EMNLP 2025 lineages
  {
    name: "PixelThink: extended version of the ReasonSeg dataset is not LISA",
    cited: {
      title: "LISA: Reasoning Segmentation via Large Language Model",
      year: 2023,
      authors: ["Xin Lai"],
    },
    citing: "PixelThink: Towards Efficient Chain-of-Pixel Reasoning",
    sentence:
      "To facilitate systematic evaluation, we introduce ReasonSeg-D IFF , an extended version of ReasonSeg [2], enriched with task difficulty annotations and dual-mode reasoning references ( short and long ).",
    expect: "baseline_only",
  },
  {
    name: "Think Right: a contrast inside a baseline list",
    cited: {
      title: "AdaptThink: Reasoning Models Can Learn When to Think",
      year: 2025,
      authors: ["Jiajie Zhang"],
    },
    citing:
      "Think Right: Learning to Mitigate Under-Over Thinking via Adaptive, Attentive Compression",
    sentence:
      "We compare TRAAC with 5 strong baselines: (5) AdaptThink: Different from the above baselines, AdaptThink is an adaptive RL framework described by Zhang et al. (2025b), that enables reasoning models to choose between “thinking” and “no-thin…",
    expect: "baseline_only",
  },
  {
    name: "WebArena-Lite tasks are a resource, not a method",
    cited: {
      title: "WebArena: A Realistic Web Environment for Building Autonomous Agents",
      year: 2023,
      authors: ["Shuyan Zhou"],
    },
    citing: "When Users Change Their Mind: Evaluating Interruptible Agents",
    sentence:
      "To enable rigorous evaluation, we build upon high-quality, human-verified tasks from WebArena-Lite (Zhou et al., 2024; Koh et al., 2024; Wei et al., 2025) and develop a systematic synthesis pipeline to generate realistic interruption scena…",
    expect: "baseline_only",
  },
  {
    name: "SVDiff: Stable Diffusion, the model we experiment with, is a tool not a build-on",
    cited: {
      title: "High-Resolution Image Synthesis with Latent Diffusion Models",
      year: 2022,
      authors: ["Robin Rombach"],
    },
    citing: "SVDiff: Compact Parameter Space for Diffusion Fine-Tuning",
    sentence:
      "Our main experiments were conducted using StableDiffu-sion [51], which is a popular variant of latent diffusion models (LDMs) [51] that operates on a latent space of a pre-trained autoencoder to reduce the dimensionality of the data samples, allowing the diffusion model to utilize the…",
    contexts: [
      "We discovered that when training the StableDiffu-sion [51] model with multiple concepts simultaneously (randomly choosing one concept at each data sampling iteration), the model tends to mix their styles when rendering them in one image for difficult compositions or subjects of similar categories…",
      "Recent years have witnessed the rapid advancement of diffusion-based text-to-image generative models [19, 53, 20, 47, 51], which have enabled the generation of high-quality images through simple text prompts.",
      "Our main experiments were conducted using StableDiffu-sion [51], which is a popular variant of latent diffusion models (LDMs) [51] that operates on a latent space of a pre-trained autoencoder to reduce the dimensionality of the data samples, allowing the diffusion model to utilize the…",
      "Diffusion models StableDiffusion [51], the model we ex-periment with, is a variant of latent diffusion models (LDMs) [51].",
      "The original DreamBooth was implemented on Imagen [53] and we conduct our experiments based on its StableDiffusion [51] implementation [75, 69].",
      "In particular, the field of text-guided image synthesis has seen significant growth with the introduction of diffusion models, achieving state-of-the-art results in large-scale text-to-image synthesis tasks [39, 47, 53, 51, 4].",
      "In summary, our main contributions are: • We present a compact ( ≈ 2,200 × fewer parameters compared with vanilla DreamBooth [52], measured on StableDiffusion [51]) yet efficient parameter space for diffusion model fine-tuning based on singular-value decomposition of weight kernels.",
      "1.7MB for StableDiffusion [51, 15, 69], full weight checkpoint consumes 3.66GB of storage).",
    ],
    expect: "baseline_only",
  },
  {
    name: "Multi-Concept Customization: Stable Diffusion used as the backbone, built on LDM, is a tool",
    cited: {
      title: "High-Resolution Image Synthesis with Latent Diffusion Models",
      year: 2022,
      authors: ["Robin Rombach"],
    },
    citing: "Multi-Concept Customization of Text-to-Image Diffusion",
    sentence:
      "In our experiments, we use Stable Diffusion [1] as our backbone model, which is built on the Latent Diffusion Model (LDM) [57].",
    contexts: [
      "To improve controllability, these models can be conditioned on a class [9,62], image [27,43,73,86], or text prompt [45,67,87].",
    ],
    intents: ["result", "methodology", "background"],
    influential: true,
    expect: "baseline_only",
  },
  {
    name: "a first-person extension inside an experiment sentence still builds on",
    cited: {
      title: "High-Resolution Image Synthesis with Latent Diffusion Models",
      year: 2022,
      authors: ["Robin Rombach"],
    },
    citing: "Some Method",
    sentence:
      "In our experiments we extend latent diffusion models (Rombach et al., 2022) with a learned noise schedule.",
    expect: "extends",
  },
  {
    name: "WebAgent-R1: GRPO extension is attributed to WebRL (known gap)",
    cited: {
      title:
        "WebRL: Training LLM Web Agents via Self-Evolving Online Curriculum Reinforcement Learning",
      year: 2024,
      authors: ["Zehan Qi"],
    },
    citing: "WebAgent-R1: Training Web Agents via End-to-End Multi-Turn Reinforcement Learning",
    sentence:
      "Based on the BC-trained policy, we further fine-tune the agent using an extension of GRPO (Qi et al., 2025) t .",
    expect: "baseline_only",
    knownGap: true,
  },
];

function predict(c: Case): string {
  const child = { title: c.citing };
  const s: PairSignals = {
    found: true,
    intents: c.intents ?? [],
    contexts: c.contexts ?? [c.sentence],
    isInfluential: c.influential ?? false,
    citingTitle: c.citing,
    citingSurvey: isSurveyLike(child),
    cited: { title: c.cited.title, year: c.cited.year, authors: c.cited.authors } as never,
    citingAbstract: null,
  };
  const r = classifyS2Pair(s);
  return (
    v1RelationFor(r.relation, { contrast: r.contrast, targetsCited: r.singleTarget }) ??
    "baseline_only"
  );
}

describe("R2-42 ICCV/EMNLP 2025 strong-relation read", () => {
  for (const c of CASES) {
    const run = c.knownGap ? it.fails : it;
    run(c.name, () => {
      expect(predict(c)).toBe(c.expect);
    });
  }
});

describe("usageReason: a backbone the experiments use is a tool (R2-46)", () => {
  const facts = { citedResource: false };
  it("flags 'we use X as our backbone, which is built on Y'", () => {
    expect(
      usageReason(
        "In our experiments, we use Stable Diffusion [1] as our backbone model, which is built on the Latent Diffusion Model (LDM) [57].",
        facts,
      ),
    ).not.toBeNull();
  });
  it("keeps 'we build on Y' and 'we extend Y' as build-ons", () => {
    expect(
      usageReason("We build on the Latent Diffusion Model (LDM) [57] and add a new loss.", facts),
    ).toBeNull();
    expect(
      usageReason(
        "In our experiments we extend latent diffusion models (Rombach et al., 2022) with a learned noise schedule.",
        facts,
      ),
    ).toBeNull();
  });
});

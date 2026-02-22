export const BENCHMARK_PROFILES = {
  swebench_lite_curated: {
    aliases: ['swebench-lite', 'swebench_lite', 'swebench_lite_curated'],
    defaultDataset: '.lab/experiments/data/swebench_lite_curated.task_boundary_v1.jsonl',
    defaultOutput: '.lab/experiments/swebench_lite_curated_glm5_vs_codex_spark.yaml',
    defaultImage: 'rex-harness:swebench-lite',
    timeoutMs: 1_800_000,
    experiment: {
      id: 'swebench_lite_curated_glm5_vs_codex_spark',
      name: 'SWE-bench Lite Curated: GLM-5 vs GPT-5.3 Codex Spark',
      tags: ['swebench-lite', 'curated', 'ab-test', 'glm-5', 'gpt-5.3-codex-spark'],
      description: 'A/B evaluation over curated SWE-bench Lite task-boundary dataset.',
    },
    dataset: {
      suiteId: 'swebench_lite_curated',
      schemaVersion: 'task_boundary_v1',
      splitId: 'test',
    },
    evaluator: {
      datasetName: 'princeton-nlp/SWE-bench_Lite',
    },
  },
};

export const DEFAULT_BENCHMARK = 'swebench_lite_curated';

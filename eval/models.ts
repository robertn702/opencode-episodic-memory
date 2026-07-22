// Candidate model configs for the embedding eval. Prefixes/pooling per each
// model's official card. See docs/embedding-model-eval.md for results.
export interface ModelConfig {
  key: string;
  repo: string;
  dtype: "q8" | "fp32" | "q4" | "fp16";
  pooling: "mean" | "cls" | "none";
  docPrefix: string;
  queryPrefix: string;
  // embeddinggemma exports a pre-pooled `sentence_embedding` output; use
  // AutoModel directly instead of the feature-extraction pipeline.
  autoModelSentenceEmbedding?: boolean;
}

export const MODELS: ModelConfig[] = [
  {
    key: "bge-small",
    repo: "Xenova/bge-small-en-v1.5",
    dtype: "q8",
    pooling: "mean",
    docPrefix: "",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  {
    key: "bge-small-cls", // control: BGE's canonical pooling (loses to mean on our corpus)
    repo: "Xenova/bge-small-en-v1.5",
    dtype: "q8",
    pooling: "cls",
    docPrefix: "",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  {
    key: "snowflake-m-v1.5",
    repo: "Snowflake/snowflake-arctic-embed-m-v1.5",
    dtype: "q8",
    pooling: "cls", // card: CLS pooling
    docPrefix: "",
    queryPrefix: "Represent this sentence for searching relevant passages: ",
  },
  {
    key: "nomic-v1.5",
    repo: "nomic-ai/nomic-embed-text-v1.5",
    dtype: "q8",
    pooling: "mean",
    docPrefix: "search_document: ",
    queryPrefix: "search_query: ",
  },
  {
    key: "gte-modernbert",
    repo: "Alibaba-NLP/gte-modernbert-base",
    dtype: "q8",
    pooling: "cls", // 1_Pooling config: CLS
    docPrefix: "",
    queryPrefix: "",
  },
  {
    key: "granite-r2",
    repo: "onnx-community/granite-embedding-english-r2-ONNX",
    dtype: "q8",
    pooling: "cls", // card: CLS pooling
    docPrefix: "",
    queryPrefix: "",
  },
  {
    key: "embeddinggemma",
    repo: "onnx-community/embeddinggemma-300m-ONNX",
    dtype: "q8",
    pooling: "none",
    docPrefix: "title: none | text: ",
    queryPrefix: "task: search result | query: ",
    autoModelSentenceEmbedding: true,
  },
];

export const MAX_CHARS = 2000; // match src/embed.ts

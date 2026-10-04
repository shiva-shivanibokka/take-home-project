# External data (raw files are git-ignored, not committed)

| Dataset | Source | Revision | File | sha256 | Licence | Fetched |
|---|---|---|---|---|---|---|
| FRAMES | https://huggingface.co/datasets/google/frames-benchmark | 58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef | frames/test.tsv (484,887 bytes, 824 rows) | 4255093c93b595b5b04c7c8dde290b48ec87d72ca0fb0b760d9dd02740d669ff | Apache-2.0 | 2026-10-02, with user approval |
| RAGTruth (test) | https://huggingface.co/datasets/wandb/RAGTruth-processed `data/test-00000-of-00001.parquet` (branch main; commit not recorded by the copier) - copied read-only from the Multimodal-RAG worktree `eval_sop/cache/ragtruth/test.parquet` | unknown | ragtruth/test.parquet (3,882,700 bytes, 2700 rows) | 2fc4fb703ea47ee0d4ab6110b86312f94fdf0bda157bc6ee67c7e61fb90d3bbd | see dataset card (MIT per upstream RAGTruth repo - not re-verified) | copied 2026-10-02 |
| SimpleQA | Hugging Face mirror `basicv8vc/SimpleQA` (local HF cache, snapshot e319282a), original: OpenAI simple-evals | e319282ab125c3dbd0c7fd00be2e4dd54e7e8f94 | simple_qa_test_set.csv (not copied; read from HF cache) | - | MIT (per the cached dataset card `license: mit`) | cached before 2026-10-01 |
| PopQA | Hugging Face `akariasai/PopQA` (local HF cache, snapshot 098765c7) | 098765c79ea10a2cb19c828324e33281b8336ec0 | test.tsv (not copied; read from HF cache) | - | NOT stated in the cached dataset card; not verified - check before redistribution | cached before 2026-10-01 |

Licence note for RAGTruth (row above): the copier's card was not inspected; upstream licence NOT verified.

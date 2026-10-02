# RESULTS: Does the Reviewer's confidence predict wrong briefs?

Branch `sop-eval`. This file covers an evaluation of the Multi-Agent Research Desk (collector, writer, reviewer).

**Status (2026-10-02, evening): DONE. The calibration study ran locally on Ollama (§4). Every number below was measured.**

**Headline.** The reviewer's self-reported confidence ranks wrong briefs better than chance and better than the length and source-count baselines:
- Pooled AUROC is 0.70–0.77 across three question sets (n = 47–100). Per-seed values are 0.67–0.73 ± ≤0.014.
- The confidence is poorly calibrated: ECE 0.25–0.42, and it is overconfident.
- At the production threshold of 0.70, escalation catches only 30–55% of wrong briefs.

**Labels.** The primary label is a deterministic match against the gold answer. An LLM-grader label is used only as a robustness check, and under it the FRAMES signal weakens (§4).

**NLI judge.** It failed validation on human RAGTruth labels (§3a) and is not used.

## 1. What is evaluated, and the main design decision

- **System under test.** The pipeline has three fixed stages, and the eval runs the real stage scripts the way the orchestrator does: `node agents-openclaw/workspaces/<stage>/skills/run.mjs --job <id>`. A preload (`eval_sop/harness/`) changes three things:
  - `@supabase/supabase-js` is swapped for a local JSON-file mock, so there are **no writes to Supabase** and the stages get no hosted credentials.
  - Tavily calls are answered from cached DuckDuckGo results (see Deviations).
  - LLM calls go to local Ollama, using the native `/api/chat` with a pinned `seed` and `num_ctx`. Every call is logged raw.
- **Objective "wrong brief" label, no human labels needed.** Each research topic is a question with a public, human-written reference answer. A brief counts as *wrong* when it does not contain the reference answer. This is a deterministic, normalised, word-boundary match of the answer or any alias (`eval_sop/grade_match.py`, unit-tested in `eval_sop/tests/test_grade_match.py`).
  - LLM graders are used only as **robustness labels**, and they are marked as LLM-created.
  - No headline depends on human labelling. The optional ~150-claim CSV for humans is **not** produced, because no human labelling is planned.
- **Question set: `eval_sop/questions.json`, 100 questions, seed 0.** Built from datasets already cached locally:
  - **SimpleQA**: 50 questions. Human-written, single indisputable answer.
  - **PopQA**: 25 high-popularity and 25 low-popularity questions. Relations are limited to names and places, because occupation and genre aliases like "pol" break string matching.
- **FRAMES question set: `eval_sop/questions_frames.json`. This is the planned PRIMARY calibration set.**
  - Size: 60 questions, sampled with seed 0.
  - Source: FRAMES (google/frames-benchmark), downloaded with the user's approval at revision `58d9fb63`. The raw file is git-ignored. Its source and sha256 are recorded in `eval_sop/external/SOURCES.md`.
  - Eligibility: the intent was gold answers of 5 words or fewer (652 of 824), but **the filter was not applied** (C7). 13 of the 60 questions have long answers. Results are reported for all 60 and for the 47 short-answer ones.
  - Strata: 12 questions per first-listed reasoning type (multiple constraints, numerical, tabular, temporal, post-processing).
  - Search results are cached in `eval_sop/data/search/`.
  - SimpleQA/PopQA is the secondary set.
- **Claim-level NLI judge: validated on human-labelled RAGTruth, and it FAILED (§3a), so it is not used for any result.** LLM-AggreFact was not approved and was not used.

## 2. Deviations from the production configuration (threats to validity)

| Production | Eval | Why |
|---|---|---|
| Tavily search | DuckDuckGo via `ddgs` metasearch, 10 results, cached in `eval_sop/data/search/` and retrieved 2026-10-01 | The project `.env` has no Tavily key. Snippets ≈ Tavily `content`, but they are shorter (about 200–300 chars). |
| Groq `llama-3.1-8b-instant` (all stages; `WRITER_MODEL` is unset in `.env`, so the writer also uses 8B even though the README says 70B) | Local Ollama `llama3.1:8b` (Q4) for all stages in §4. The §3 pilot used Groq gpt-oss/qwen and is reported separately, never mixed. | **Both Groq Llama model ids now return HTTP 404 (model not found)** (checked 2026-10-01), so production as configured would currently fail. `llama3.1:8b` is the same weights family, quantised. |
| Orchestrator retries a failed stage up to 3 times | 1 attempt; failures are logged and counted (a failed review is scored as confidence 0, i.e. escalate) | Simpler. Seeded decoding makes a retry mostly redundant. |
| Agent timeouts | none | Local inference is slower. |
| `max_tokens`, temperatures, prompts | unchanged | — |

Other threats:
- SimpleQA and PopQA facts are not "fast-moving", so they under-represent the time-sensitive topics the desk is for.
- PopQA has some ambiguous questions (e.g. "In what country is hundred?").
- String matching undercounts paraphrased correct answers. The LLM-grader agreement in §4 is planned to measure this.
- The reviewer prompt asks whether a brief is accurate and publishable, **not** whether it answers the question. A brief that dodges the question is "wrong" by our label but can still be faithful to its sources.

## 3. Pilot (Groq free tier, 2026-10-01), complete deterministic measurements only

Before the user's `.env` was declared off-limits, a 60-question pilot ran on the Groq free tier. The pilot used the key already in the project `.env`, which was allowed by the original rules ("if a key already exists"). It cost $0: about 204k free-tier tokens in total. Note for the coordinator: a Groq key *does* exist in that `.env`. It is not used any further, per the new instruction.

- Pilot models:
  - Collector: `qwen/qwen3.8-27b`
  - Writer: `openai/gpt-oss-120b`
  - Reviewer: `openai/gpt-oss-20b`, with `reasoning_effort` set by the harness (§5, C5).
- All raw outputs are in `eval_sop/runs/pilot_groq/`.
- **Pilot reviews (5 of 60) and LLM grades (15 of 60) are incomplete, because the processes were killed. They are not analysed and must not be cited.**

Complete, deterministic pilot measurements (n = 60 briefs, one writer seed, so there is no seed variance):

| Quantity | Value |
|---|---|
| Brief contains gold answer (overall) | 35/60 = 0.58 (bootstrap 95% CI 0.47–0.70) |
| by stratum: SimpleQA / PopQA-high / PopQA-low | 12/30 = 0.40 · 13/15 = 0.87 · 10/15 = 0.67 |
| Gold answer appears in some selected snippet (writer's evidence) | 30/60 |
| Gold answer in the 150-char truncations the reviewer sees | 26/60 |
| Correct when gold is in snippets / when it is not | 28/30 = 0.93 / 7/30 = 0.23 |
| **Ablation (c)** claim sentences carrying an inline `[n]` marker, raw writer output (kept) | 294/2192 = 13.4% (per brief 13.7% ± 9.1%) |
| ... after the writer's own stripping regex (`writer/run.mjs:147`) | 0/2192 = 0% |
| Answer-bearing sentence cites a source / cites a source whose snippet contains the gold | 22/34 / 18/34 |

Interpretation:
- Stripping the markers removes all explicit attribution. With markers kept, only 13% of sentences are attributable at all for this writer model.
- Most errors happen where retrieval missed the answer: 23 of the 25 wrong briefs had no gold answer in their snippets.

## 3a. NLI-judge validation on RAGTruth (human labels): FAILED

**Setup**
- Judge: `cross-encoder/nli-deberta-v3-large`, run on CPU with 2 threads. A sentence counts as supported if P(entailment) ≥ t, taking the max over context windows of about 350 words.
- Data: the RAGTruth test set (wandb/RAGTruth-processed), which has human span-level hallucination labels. It is a local copy; its sha256 is in `external/SOURCES.md`.
- Sample: 20 responses per task (QA / Summary / Data2txt), seed 0. That gives 60 responses and 397 sentences.
- A sentence's human label is "unsupported" if it overlaps a human-marked hallucination span.
- 30% of responses form a dev split, used only to choose t.
- The protocol was fixed in `eval_sop/validate_nli.py` before running. Raw per-sentence scores are in `runs/nli_validation/sentence_scores.csv`.

**Results**

| Split | n sentences | human-unsupported | threshold | balanced accuracy | Cohen's κ | AUROC |
|---|---|---|---|---|---|---|
| dev (picks t) | 122 | 4 (3.3%) | 0.10 | 0.78 | 0.08 | 0.73 |
| **test** | **275** | **15 (5.5%)** | 0.10 | **0.46** (95% CI 0.35–0.60) | **−0.02** (−0.07 to 0.03) | **0.44** (0.33–0.55) |
| test, fixed t = 0.5 | 275 | 15 | 0.50 | 0.51 | 0.00 | 0.44 |

**Reading.** On held-out human labels, the judge does no better than chance at flagging unsupported sentences: AUROC is below 0.5 and κ is about 0. Likely contributors:
- Sentence-level hallucinations are rare in RAGTruth.
- Data2txt contexts are JSON-like.
- Taking the max over chunks rewards sentences that merely share the topic.

**Limitation.** The test split contains only 15 unsupported sentences, so the CIs are wide. An enriched sample would tighten them, but this run already took 54 CPU-minutes.

**Consequence.** This file reports no claim-level "unsupported-claim rate". Ablation (c) uses only the deterministic attribution measures in §3.

## 3b. Groq Llama route (approved 2026-10-02): not usable

- `GET /openai/v1/models` on 2026-10-02 lists no Llama chat or instruct model. The only Llama entries are `meta-llama/llama-prompt-guard-2-22m` and `-86m`, each with a 512-token context.
- One probe call to `llama-prompt-guard-2-22m` returned a bare probability (`"0.0031..."`) rather than text. These are prompt-injection classifiers.
- The stage prompts need about 0.6k–2.4k tokens and free-text or JSON output, so this family cannot run any stage.
- The probe's headers were `x-ratelimit-limit-requests: 14400` and `x-ratelimit-limit-tokens: 15000`. No billing or payment message appeared.
- To stay inside the assigned family, **no other Groq model was used**, and no further Groq calls are planned.

## 4. Main results (local Ollama, 2026-10-02)

### Setup

**Models.** Every pipeline stage ran on local `llama3.1:8b` via Ollama, with `num_ctx` 8192, one request at a time, and each model unloaded before switching. This is the same model family as the production configuration (`llama-3.1-8b-instant`). The writer is that same 8B model, which matches `.env`, where `WRITER_MODEL` is unset.

**Seeds.** The writer ran with seed 0. The reviewer ran with seeds 0, 1 and 2, at the production temperature of 0.1.

**Label.** A brief is *wrong* when it does not contain the gold answer (deterministic match, no LLM).
- As a robustness check, an LLM grader (`qwen2.5:7b`, a different model family) re-labelled every brief. Those labels are LLM-created.
- No run failed. `reviewer_failures` is 0 in every condition.

**Statistics.**
- AUROC is computed with (1 − confidence) as the score for "wrong".
- ECE uses 10 equal-width bins and treats confidence as P(correct).
- Escalation follows the production rule, `confidence < 0.70`.
- "Per seed" means mean ± SD over the 3 reviewer seeds.
- "Pooled" means each brief's confidence is averaged over the 3 seeds, with a 2000-sample bootstrap 95% CI over questions.

**Sets.**
- **FRAMES-60** is the set as actually run.
- **FRAMES-short** (n = 47) restricts FRAMES-60 to gold answers of 5 words or fewer. This restriction was intended before the run but applied only at analysis time (see C7).
- **SQA/PopQA-100** is the 100-question SimpleQA/PopQA set.

### Primary reviewer (llama3.1:8b, 150-char snippets, as in production), label = gold-answer match

| Set | n | wrong rate | AUROC per seed | AUROC pooled [95% CI] | ECE pooled [CI] | mean conf | Escalation @0.70: rate · precision [CI] · recall [CI] |
|---|---|---|---|---|---|---|---|
| FRAMES-short | 47 | 0.66 | 0.733 ± 0.014 | **0.765** [0.637, 0.878] | 0.329 [0.208, 0.444] | 0.67 | 0.38 · **0.94** [0.82, 1.00] · **0.55** [0.37, 0.72] |
| FRAMES-60 | 60 | 0.73 | 0.674 ± 0.014 | **0.707** [0.584, 0.824] | 0.423 [0.316, 0.526] | 0.69 | 0.32 · 0.95 [0.83, 1.00] · 0.41 [0.26, 0.56] |
| SQA/PopQA-100 | 100 | 0.46 | 0.705 ± 0.006 | **0.701** [0.594, 0.801] | 0.245 [0.166, 0.336] | 0.77 | 0.26 · **0.54** [0.33, 0.74] · **0.30** [0.18, 0.45] |

### Baselines (same briefs and labels; AUROC for predicting "wrong")

| Set | random escalation: AUROC (95% range of 1000 draws) · precision | fewer sources = riskier | shorter brief = riskier |
|---|---|---|---|
| FRAMES-short | 0.50 (0.32–0.67) · 0.66 (= base rate) | 0.43 [0.27, 0.58] | 0.43 [0.27, 0.61] |
| FRAMES-60 | 0.50 (0.34–0.65) · 0.73 | 0.45 [0.30, 0.60] | 0.45 [0.29, 0.62] |
| SQA/PopQA-100 | 0.50 (0.39–0.61) · 0.46 | 0.50 [0.42, 0.57] | 0.48 [0.37, 0.61] |

- The source-count baseline is nearly constant: the collector almost always selects 7 sources, so there are only 4–5 distinct values.
- Neither heuristic baseline beats chance.
- Random escalation has an expected precision equal to the wrong-rate at any escalation rate.

### Robustness to the label (LLM grader qwen2.5:7b, LLM-created labels)

- Agreement between the grader and the string match is moderate to substantial:
  - FRAMES-short: κ = 0.55 (raw agreement 0.79).
  - FRAMES-60: κ = 0.41 (0.72).
  - SQA/PopQA-100: κ = 0.72 (0.86).
- With grader labels, pooled AUROC is:
  - FRAMES-short: 0.638 [0.487, 0.791].
  - FRAMES-60: 0.622 [0.480, 0.761].
  - SQA/PopQA-100: 0.727 [0.632, 0.822].
- The FRAMES signal is therefore weaker, and its CI includes 0.5, under the LLM label. Several grader "CORRECT" calls on FRAMES are visibly wrong: for gold "Wausau" the brief says "Waukesha", and for gold "15" it says "31" (`runs/frames/labels_llm_qwen2.5-7b.jsonl`). So the grader is not a better label than string match, only a different one.

### Ablations (FRAMES; paired bootstrap of the pooled-AUROC difference vs the primary reviewer, same 47/60 briefs)

| Ablation | FRAMES-short AUROC | Δ vs primary [95% CI] | FRAMES-60 Δ [CI] | Escalation @0.70 (short): precision · recall |
|---|---|---|---|---|
| (primary) 8B, 150 chars | 0.765 | — | — | 0.94 · 0.55 |
| (a) 8B, **350**-char snippets | 0.743 | −0.022 [−0.104, 0.067] | +0.001 [−0.091, 0.093] | 1.00 · 0.42 |
| (b) **3B** reviewer (`llama3.2`), 150 chars | 0.684 | −0.081 [−0.215, 0.047] | −0.058 [−0.192, 0.078] | 0.75 · 0.48 |

- **(a)** Showing the reviewer the full 350-char snippets did not change discrimination. It made the reviewer slightly *more* confident (mean 0.71 vs 0.67) and less calibrated (ECE 0.37 vs 0.33).
- **(b)** The 3B reviewer is lower on every metric, but every CI includes 0. n = 47–60 cannot resolve differences this small.
- **(c) Inline citations kept vs stripped** (deterministic, from the writer's raw output):

| Set | claim sentences | carrying an `[n]` marker, kept | after the writer's stripping | answer-bearing sentence cites a source / cites a source whose snippet contains the gold |
|---|---|---|---|---|
| FRAMES-60 | 2203 | 15.0% (per brief 15.8% ± 13.0%) | 0% | 9/17 · 5/17 |
| SQA/PopQA-100 | 3689 | 18.1% (per brief 18.5% ± 10.5%) | 0% | 41/54 · 34/54 |

### Other measured facts

- **The reviewer's confidence is coarse.** It takes only 5–7 distinct values (mostly 0.6 / 0.8 / 0.9).
- **It is fairly stable across seeds.** The 0.70 verdict flips between seeds for 8.5% of FRAMES-short briefs and 9% of SQA/PopQA briefs.
- **The threshold sweep is a step function.** On SQA/PopQA, escalating below 0.85 instead of 0.70 raises recall from 0.31 to 0.83, with precision 0.67 and an escalation rate of 0.57. Full sweep: `runs/*/threshold_sweep*.csv`.
- **The dead `anyCheckFailed` rule.** If it were wired in (escalate when confidence < 0.70 *or* any check fails), recall would rise to 0.78–0.87. But 54–83% of briefs would be escalated, at a precision of 0.67–0.76 (base rates 0.46–0.73).
- **Retrieval drives correctness.** When the gold answer is in a selected snippet, the brief is right 0.94 (SQA/PopQA) and 0.77 (FRAMES-short) of the time. When it is not, those figures fall to 0.14 and 0.18.
- **Overconfidence.** The reviewer is overconfident everywhere, with mean confidence 0.67–0.77 against accuracy 0.27–0.54. Reliability diagrams: `runs/frames/reliability_short.png`, `runs/frames/reliability.png`, `runs/local/reliability.png`.

### What the numbers support

- On all three sets, the reviewer's self-reported confidence carries real but modest ranking signal for wrong briefs, with pooled AUROC 0.70–0.77 and lower CI bounds of 0.58–0.64. That is better than random and better than both heuristic baselines, whose AUROC is at most 0.50.
- The confidence is badly calibrated, with ECE between 0.25 and 0.42.
- At the production threshold of 0.70, escalation **misses most wrong briefs**: recall is 0.30–0.55.
- Escalation precision depends on the set. It is high on FRAMES (0.94), where most briefs are wrong anyway. On SQA/PopQA it is 0.54, barely above the 0.46 base rate.

### What they do not support

- Any claim that the confidence is "calibrated".
- Any claim that 350-char snippets or the 8B reviewer *improves* on its alternative (CIs include 0).
- Any claim about the production Groq deployment, whose models are no longer served.
- Generalisation beyond short-answer factual questions answered from search snippets.
- The writer and the reviewer are the same model, so the self-review confound is not separated out.

## 5. Change log

Every app-code change has a test. Test outputs are committed.

- **C1, `reviewer/skills/run.mjs`: `REVIEWER_SNIPPET_CHARS` env hook** (commit 8becb11).
  - Why: ablation (a).
  - What changed: `s.snippet?.slice(0, 150)` became `slice(0, REVIEWER_SNIPPET_CHARS)`, with a default of 150.
  - Evidence: `eval_sop/tests/reviewer.test.mjs` shows that the default prompt is byte-identical to the reviewer at 417589b, and that a value of 350 exposes the full snippet.
  - Preserved: all comments and the default behaviour.
- **C2, tests reproducing a crash** (commit e356e13).
  - At 417589b, `run.mjs:168` calls `confidence.toFixed(2)`. This throws when the LLM returns `"confidence": "0.85"` (string) or omits the field. 2 tests fail: `eval_sop/tests/output_before_fix.txt`.
- **C3, fix: coerce confidence to a number** (commit 85fad0a).
  - Non-numeric values become 0.0, which escalates. This mirrors the existing parse-failure fallback.
  - 6/6 tests pass: `eval_sop/tests/output_after_fix.txt`.
  - Preserved: the original rationale comment about checks no longer overriding the verdict.
  - Effect on the eval: it only matters in runs where the LLM emits a non-numeric confidence, and those runs are counted in `results.json → reviewer_failures` / logs.
- **C4, eval harness** (commit d578eaf, plus later commits): mock DB, cached search, seeded Ollama transport, question set. No app code.
- **C5, harness transport** (this prep commit):
  - Local Ollama calls are sent with `node:http` and no client timeout. Under GPU contention, undici's 300 s header timeout made the collector fail (`fetch failed` after 1257 s on 2026-10-01; that aborted run's log is kept in the session scratchpad, not committed).
  - The Groq path adds `seed` and `reasoning_effort` (`low` for gpt-oss, `none` for qwen3). Without it, gpt-oss spent the collector's 128 `max_tokens` on hidden reasoning and returned empty content (probe on 2026-10-01). It is used for the pilot only.
  - Each run has its own directory (`EVAL_RUN`), plus an interleaved stratum order and a `list` phase.
- **C6, eval code only (2026-10-02).** These are not changes to the app.
  - `validate_nli.py` now reads RAGTruth instead of LLM-AggreFact. Reason: AggreFact was not approved, and a local RAGTruth copy was supplied.
  - The NLI judge is now loaded with plain `transformers`. Reason: importing `sentence_transformers` failed with an h5py/numpy binary mismatch in the anaconda env.
  - `build_questions_frames.py` now restricts FRAMES to short answers. This restriction was fixed before any FRAMES output existed.
- **C7: FRAMES short-answer filter was never applied (my error, found 2026-10-02 after the run).**
  - The ≤5-word gold-answer filter described for `build_questions_frames.py` was never inserted, because a scripted string replacement silently failed to match. As a result, `questions_frames.json`, which was used for the run, contains 13/60 questions with long gold answers.
  - Evidence: `meta.long_answer` is true for 13 entries, and these labels are unreliable. Example: f006's gold is a full sentence, so string match always says "wrong".
  - Handling: I did not regenerate anything. Results are reported for the set as run (FRAMES-60) **and** for the intended restriction (FRAMES-short, n = 47, via `EVAL_SHORT_ONLY=1 python eval_sop/analyze.py`).
  - The builder's docstring now documents this, and the builder still reproduces the file that was used, byte for byte.
  - The earlier statement in this file that the filter was applied was wrong and has been corrected.
- **C8: analysis additions (eval code only).**
  - Paired bootstrap of AUROC differences for the ablations.
  - The `EVAL_SHORT_ONLY` subset option.
  - A Windows-safe grader file name (no `:`).
  - The `eval_sop/run_all.sh` driver.
  - Reviewer raw logs are gzip-compressed to keep committed data small.
- **Verified but not changed** (design findings, see §8):
  - `anyCheckFailed` is computed but unused, so a brief with all checks false and confidence 0.95 is published. A test documents this (`reviewer.test.mjs`).
  - The writer strips `[n]` markers and `citations` is every source URL.
  - The reviewer sees title + 150 chars per source.

## 6. Exact commands (these produced §4; one-shot driver: `bash eval_sop/run_all.sh frames` then `bash eval_sop/run_all.sh local`)

Rules for these runs:
- Run one heavy process at a time, with `OMP_NUM_THREADS=2`.
- Do not start an extra `ollama serve`.
- Use one model per comparison: every stage and every reviewer condition runs on local `llama3.1:8b`. The one exception is the small arm of ablation (b), which uses `llama3.2` 3B, because that comparison is about model size.
- Run everything from the worktree root in Git Bash.

```bash
export OMP_NUM_THREADS=2 EVAL_NUM_CTX=8192 PYTHONIOENCODING=utf-8
# ---- Tier 1 (primary): FRAMES, n=60 ------------------------------------------------ est. ~2.4 h
export EVAL_RUN=frames EVAL_QUESTIONS=questions_frames.json
node eval_sop/run_pipeline.mjs gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0 --limit 4   # speed check
node eval_sop/run_pipeline.mjs gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0             # 60 x ~40 s
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.1:8b     --snip 150 --seed $s; done  # primary
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.1:8b     --snip 350 --seed $s; done  # ablation (a)
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.2:latest --snip 150 --seed $s; done  # ablation (b)
python eval_sop/grade_llm.py --model qwen2.5:7b      # LLM-created robustness labels
python eval_sop/grade_match.py && python eval_sop/analyze.py
# ---- Tier 2 (secondary, if time remains): SimpleQA/PopQA, n=100, primary reviewer only ---- est. ~2 h
export EVAL_RUN=local EVAL_QUESTIONS=questions.json
node eval_sop/run_pipeline.mjs gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0 --limit 100
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.1:8b --snip 150 --seed $s --limit 100; done
python eval_sop/grade_match.py && python eval_sop/analyze.py
python eval_sop/tests/test_grade_match.py && node --test eval_sop/tests/reviewer.test.mjs
```

**Budget**
- Tier 1 is about 600 Ollama calls, roughly 2.4 h. Tiers 1 and 2 together are about 1,100 calls, roughly 4.4 h.
- These durations are *estimates*. They come from one uncontended speed check of `llama3.1:8b` (about 32 tokens/s). The `--limit 4` speed-check step measures the real rate.

**Risk.** FRAMES questions are multi-hop, so an 8B writer that only sees snippets may get few of them right. AUROC is still defined in that case, but its CI will be wide. Tier 2 is the hedge: the pilot's accuracy on that set was 0.58.

All runs are resumable.

## 7. Pending actions

- None for the runs in §4.
- Possible follow-ups:
  - Larger n, to resolve the ablation differences.
  - A writer from a different family than the reviewer, to separate out self-review.
  - Human spot-checks of the LLM grader.
- Paid APIs: **none used, none needed.**

## 8. Proposed, not done

- Make `anyCheckFailed` part of the verdict (`confidence < 0.70 || anyCheckFailed`). This is a design choice, not a bug: the comment at `reviewer/run.mjs:159-162` explains why it was removed. `analyze.py` reports this rule as an alternative instead.
- Keep `[n]` markers in the stored brief and map them to `citations`. Ablation (c) quantifies what this would buy.
- Writer: when all 4 LLM retries return 429, `ollamaChat` returns `undefined` and the stage crashes with `Cannot destructure property 'content'` (seen on 2026-10-01 in an aborted run whose writer was `qwen/qwen3.8-27b`; log kept in the scratchpad, not committed). The orchestrator retries, so this is harmless but noisy. It is not fixed and has no test yet.
- `05-research-desk.html` (the assignment brief) is committed to the repo. If the assignment is confidential, it probably should not be public. It was left untouched.

## 9. SOP-ready sentences (strictly true as of this commit)

- "I evaluated whether an LLM reviewer's self-reported confidence predicts errors in a three-agent research pipeline. On 160 objectively graded briefs (60 FRAMES, 100 SimpleQA/PopQA questions), its confidence ranked wrong briefs above chance (AUROC 0.70–0.77, lower 95% bounds ≥ 0.58), but it was poorly calibrated (ECE 0.25–0.42). At the deployed 0.70 threshold it escalated only 30–55% of wrong briefs."
- "Before using an NLI model as an automatic support judge, I validated it against human hallucination labels (RAGTruth). It performed at chance on held-out data (AUROC 0.44), so I excluded it and grounded the evaluation in reference-answer matching instead."
- "I found that most errors traced to retrieval rather than generation: briefs were correct 77–94% of the time when a retrieved snippet contained the answer, and 14–18% of the time when none did."

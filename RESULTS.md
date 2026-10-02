# RESULTS: Does the Reviewer's confidence predict wrong briefs?

Branch `sop-eval`. This file covers an evaluation of the Multi-Agent Research Desk (collector, writer, reviewer).

**Status (2026-10-02): PREP DONE, MAIN RUN NOT DONE YET.** The calibration headline (AUROC, ECE, escalation precision/recall) **has not been measured yet**. It needs the local Ollama runs listed in §6, and those are waiting for the shared GPU slot. This file has no calibration numbers. The only numbers here are deterministic, complete measurements on a 60-brief **pilot**, each labelled as such. Do not cite anything from this file as a calibration result until §4 is filled in.

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
  - The user's first choice was **FRAMES**, which allowed "or a similar QA set". FRAMES is not on this machine, and downloading it needs the user's explicit permission (§7). `eval_sop/build_questions_frames.py` is ready for when it is allowed.
- **Claim-level NLI judge.** It is not used in any headline. `eval_sop/validate_nli.py` validates it on human-labelled **LLM-AggreFact** before any use. That dataset is also not on the machine (§7). Only a 4-pair code smoke test has run (`runs/nli_validation/smoke.json`), and it is **not** a validation result.

## 2. Deviations from the production configuration (threats to validity)

| Production | Eval | Why |
|---|---|---|
| Tavily search | DuckDuckGo via `ddgs` metasearch, 10 results, cached in `eval_sop/data/search/` and retrieved 2026-10-01 | The project `.env` has no Tavily key. Snippets ≈ Tavily `content`, but they are shorter (about 200–300 chars). |
| Groq `llama-3.1-8b-instant` (all stages; `WRITER_MODEL` is unset in `.env`, so the writer also uses 8B even though the README says 70B) | Local Ollama `llama3.1:8b` (Q4) for all stages | **Both Groq Llama model ids now return HTTP 404 (model not found)** (checked 2026-10-01), so production as configured would currently fail. `llama3.1:8b` is the same weights family, quantised. |
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

## 4. Main results (local Ollama): NOT YET RUN

These are filled in from `eval_sop/runs/local/results.json` after §6. Planned table:
- Reviewer AUROC (confidence predicting a wrong brief), ECE (10 bins) and escalation precision/recall at 0.70, each with n, mean ± std over 3 seeds, and a 2000-sample bootstrap 95% CI.
- Baselines: random escalation, fewer-sources-is-riskier, shorter-brief-is-riskier.
- Ablations: (a) snippet 150 vs 350, (b) 8B vs 3B reviewer, (c) as in §3.
- Reliability diagram: `runs/local/reliability.png`. Threshold sweep: `runs/local/threshold_sweep.csv`.

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
- **Verified but not changed** (design findings, see §8):
  - `anyCheckFailed` is computed but unused, so a brief with all checks false and confidence 0.95 is published. A test documents this (`reviewer.test.mjs`).
  - The writer strips `[n]` markers and `citations` is every source URL.
  - The reviewer sees title + 150 chars per source.

## 6. Exact commands for the local Ollama run (to start once the slot is free)

Rules: one heavy process at a time, `OMP_NUM_THREADS=2`, and no additional `ollama serve`. The commands run from the worktree root in Git Bash.

```bash
export EVAL_RUN=local OMP_NUM_THREADS=2 EVAL_NUM_CTX=8192 PYTHONIOENCODING=utf-8
# 0. calibrate speed on 4 questions (~4 min); proceed with --limit 100 if gen <= 60 s/question, else --limit 60
node eval_sop/run_pipeline.mjs gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0 --limit 4
# 1. generation, n=100                                         est. 100 x ~40 s   ~ 65 min
node eval_sop/run_pipeline.mjs gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0 --limit 100
# 2. primary reviewer, 3 seeds                                 est. 300 x ~10 s   ~ 50 min
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.1:8b --snip 150 --seed $s --limit 100; done
# 3. ablation (a): 350-char snippets, 3 seeds                  est. 300 x ~10 s   ~ 50 min
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.1:8b --snip 350 --seed $s --limit 100; done
# 4. ablation (b): 3B reviewer (code default llama3.2:3b), 3 seeds   est. 300 x ~5 s ~ 25 min
for s in 0 1 2; do node eval_sop/run_pipeline.mjs review --base ollama --model llama3.2:latest --snip 150 --seed $s --limit 100; done
# 5. robustness grader, different family (LLM labels)          est. 100 x ~4 s    ~ 7 min
python eval_sop/grade_llm.py --model qwen2.5:7b
# 6. labels + analysis (CPU, seconds)
python eval_sop/grade_match.py && python eval_sop/analyze.py
python eval_sop/tests/test_grade_match.py && node --test eval_sop/tests/reviewer.test.mjs
```

- Planned load: about 1,300 Ollama calls, roughly 3.3 h of 8B-class inference plus model loads. That is inside the 3–5 h budget.
- The per-call estimates come from one uncontended measurement of `llama3.1:8b` (about 32 tok/s generation, 2026-10-01). They are **not** measured end to end. Step 0 checks them.
- Fallbacks if step 0 shows the run will not fit:
  - Use `--limit 60`, which keeps the stratum mix.
  - Drop to seeds {0,1}.
- All runs are resumable: they skip jobs already done.

## 7. Pending user actions (permission needed; nothing was downloaded)

1. **FRAMES** (google/frames-benchmark, `test.tsv`, Apache-2.0; size not verified). It is needed only if the user wants FRAMES in addition to SimpleQA/PopQA. The command is in `eval_sop/build_questions_frames.py`.
2. **LLM-AggreFact** (lytang/LLM-AggreFact on Hugging Face; size not verified; it may need the dataset terms accepted on HF). It is needed to validate the NLI judge. The command is in `eval_sop/validate_nli.py`, and it runs on CPU in about 10–20 min for ~400 items (estimate).
3. Paid APIs: **none needed.**

## 8. Proposed, not done

- Make `anyCheckFailed` part of the verdict (`confidence < 0.70 || anyCheckFailed`). This is a design choice, not a bug: the comment at `reviewer/run.mjs:159-162` explains why it was removed. `analyze.py` reports this rule as an alternative instead.
- Keep `[n]` markers in the stored brief and map them to `citations`. Ablation (c) quantifies what this would buy.
- Writer: when all 4 LLM retries return 429, `ollamaChat` returns `undefined` and the stage crashes with `Cannot destructure property 'content'` (seen on 2026-10-01 in an aborted run whose writer was `qwen/qwen3.8-27b`; log kept in the scratchpad, not committed). The orchestrator retries, so this is harmless but noisy. It is not fixed and has no test yet.
- `05-research-desk.html` (the assignment brief) is committed to the repo. If the assignment is confidential, it probably should not be public. It was left untouched.

## 9. SOP-ready sentences (true as of this commit)

- "I built a reproducible, label-free evaluation harness for a three-agent research pipeline. It runs the real stage code (plus two small, tested reviewer changes) against a local database mock and scores briefs against public reference answers (SimpleQA/PopQA), so the primary labels need no human or LLM judgement."
- "In a 60-question pilot, I found that the writer's citation post-processing removes all sentence-level attribution (13.4% of sentences cited → 0%), and that 23 of 25 incorrect briefs came from retrieval failing to surface the answer."
- (Do not write any sentence about calibration until §4 is measured.)

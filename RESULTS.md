# RESULTS: Does the Reviewer's confidence predict wrong briefs?

Branch `sop-eval`. This file covers an evaluation of the Multi-Agent Research Desk (collector, writer, reviewer).

**Status (2026-10-04, after the fix phase and round-2 review).** The calibration study ran locally on Ollama. An adversarial review then found label errors and benchmark leakage. **§4b reports the corrected numbers and supersedes §4**, which keeps the original-label numbers for the record. No LLM or API call was made in the fix phase; everything was recomputed from committed outputs.

**Headline (corrected; primary metric = single-call AUROC, mean over 3 reviewer seeds, 95% bootstrap CI over questions).**
- **SimpleQA/PopQA (n = 98)**
  - Single-call AUROC is **0.778 [0.682, 0.864]** for predicting a wrong brief.
  - The reviewer is overconfident: ECE 0.28.
  - At the deployed 0.70 threshold it escalates 26% of briefs and catches **35%** of the wrong ones. Precision is 0.68, against a base rate of 0.50.
  - With the 5 answer-leaked items excluded (n = 93), AUROC is 0.792 [0.696, 0.879].
- **FRAMES (n = 59)**: the signal is weaker and depends on the label.
  - Single-call AUROC is 0.644 [0.517, 0.760] with adjudicated labels.
  - Under the alternative labels it ranges from 0.54 to 0.68.
  - With the 11 answer-leaked items excluded, it is 0.681 [0.547, 0.851] (n = 48).
- **Baselines.** Random escalation, "fewer sources is riskier" and "shorter brief is riskier" all sit at chance level, with AUROC between 0.48 and 0.52.

**Labels (§4b).**
- The primary label is **adjudicated by Claude (an LLM), not by a human**. It covers all 60 FRAMES briefs and the 26 disputed SimpleQA/PopQA briefs (`eval_sop/adjudication/adjudicated_labels.csv`). Undisputed briefs keep the matcher label.
- Five adjudications (f001, f011, q024, q065, q083) were revised to *wrong* after the round-2 review.
- Flipping the remaining low-confidence adjudications leaves the AUROC unchanged (0.778 on SimpleQA/PopQA, 0.644 on FRAMES).
- The original deterministic labels (v1), the improved matcher (v2) and the `qwen2.5:7b` grader are all reported alongside.
- **No result here is validated by a human.**

**NLI judge.** It failed validation on human RAGTruth labels (§3a) and is not used.

## 1. What is evaluated, and the main design decision

- **System under test.** The pipeline has three fixed stages, and the eval runs the real stage scripts the way the orchestrator does: `node agents-openclaw/workspaces/<stage>/skills/run.mjs --job <id>`. A preload (`eval_sop/harness/`) changes three things:
  - `@supabase/supabase-js` is swapped for a local JSON-file mock, so there are **no writes to Supabase** and the stages get no hosted credentials.
  - Tavily calls are answered from cached DuckDuckGo results (see Deviations).
  - LLM calls go to local Ollama, using the native `/api/chat` with a pinned `seed` and `num_ctx`. Every call is logged raw.
- **Objective "wrong brief" label, no human labels needed.** Each research topic is a question with a public, human-written reference answer. A brief counts as *wrong* when it does not contain the reference answer. This is a deterministic, normalised, word-boundary match of the answer or any alias (`eval_sop/grade_match.py`, unit-tested in `eval_sop/tests/test_grade_match.py`).
  - LLM graders are used only as **robustness labels**, and they are marked as LLM-created.
  - *Fix phase:* the matcher had errors in both directions. The primary label in §4b is the Claude-adjudicated label (LLM, not human).
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

Before the user's `.env` was declared off-limits, a 60-question pilot ran on the Groq free tier. The pilot used the key already in the project `.env`, which was allowed by the original rules ("if a key already exists"). It cost $0: about 204k free-tier tokens in total.

- Pilot models:
  - Collector: `qwen/qwen3.8-27b`
  - Writer: `openai/gpt-oss-120b`
  - Reviewer: `openai/gpt-oss-20b`, with `reasoning_effort` set by the harness (§5, C5).
- All raw outputs are in `eval_sop/runs/pilot_groq/`.
- The pilot's reviews (5 of 60) and LLM grades (15 of 60) are incomplete, because the processes were killed. They were moved to `eval_sop/runs/pilot_groq/incomplete_not_analysed/` in the fix phase (C13), are not analysed, and must not be cited.
- Pilot numbers below use the v1 matcher and are **not** leak-filtered. The pilot search cache contains the same benchmark mirrors as §4b, so the retrieval split is likely inflated.

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
- 23 of the 25 wrong briefs had no gold answer in their snippets. This is correlational and not leak-filtered (see §4b).

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

## 4b. Corrected results (fix phase + round-2 review, 2026-10-04): these supersede §4

### What changed and why

An independent adversarial review found that the deterministic matcher (v1) erred in both directions. It also found that the cached search results contained benchmark mirrors that revealed the answers.

**Label errors the review reported, all of which I confirmed by reading the briefs:**
- FRAMES false positives: f008, f016, f025, f039.
- SimpleQA/PopQA false negatives: q010 ("eight" vs 8), q021 (Moussa/Mousa), q028 (middle initial), q036 (two parts in reverse order).
- SimpleQA/PopQA false positives: q056, q080.
- Gold answer contained in the question: q057, q072 (dropped), and aliases of q051 and q067.
- A typo in the gold answer of q022.

**What I did:**
1. **Matcher v2** (`eval_sop/labels_v2.py`, tests in `eval_sop/tests/test_labels_v2.py`) adds:
   - number words;
   - middle initials;
   - a doubled-letter spelling tolerance for tokens of 5 or more letters (narrowed in round 2: a general one-edit tolerance also matched Hansen/Hanson; no label changed);
   - order-free multi-part answers;
   - a positional check: the gold must appear in the title, the Summary, or a bold Key-Findings headline;
   - dropping questions whose primary gold appears in the question (f025, q057, q072);
   - dropping aliases that share a content word with the question;
   - a fix for the gold typo in q022.

   The positional rule and the leak-threshold choice (below) were made **after** seeing the review's examples, so they are post hoc. The v2 matcher is only marginally closer to the adjudicated FRAMES labels than v1 (κ 0.60 vs 0.57), and it degenerates on the leak-excluded FRAMES subset. It is reported, but it is not the primary label.
2. **Adjudication** (`eval_sop/adjudication/adjudicated_labels.csv`, built by `build_adjudication_csv.py`).
   - I read and labelled every FRAMES brief (60) and every disputed SimpleQA/PopQA brief (26). A brief counts as disputed when v1, v2 and the qwen grader disagreed, or when the review flagged it.
   - Each row has a reason and a confidence (high/low).
   - **Round 2:** the second reviewer flagged five rows marked correct that break my own rule (f001, f011, q024, q065, q083). I re-read all five, agreed, and relabelled them as wrong; each row's reason now says "revised after round-2 review". 4 rows remain low-confidence (f002, q003, q030, q072).
   - The rule: a brief is correct only if it *commits* to an answer equivalent to the gold. Hedged, contradicted and passing mentions are wrong.
   - **These labels are LLM-created (Claude), not human.**
   - Undisputed SimpleQA/PopQA briefs, where v1, v2 and the grader agree, keep that shared label.
3. **Leak detection** (`labels_v2.py`, programmatic).
   - A selected source is *exposed* if it comes from a benchmark mirror (huggingface.co) or contains the question verbatim. The verbatim test applies only to questions of 12 or more words, because q068's 10-word question appears verbatim on an ordinary travel page.
   - It is an **answer-revealing leak** if that exposed snippet also contains the gold answer.
   - Results:

     | Set | Answer-revealing leaks | Exposed |
     |---|---|---|
     | FRAMES | 11/60: f008, f009, f020, f023, f029, f033, f048, f049, f052, f053, f054 | 26/60 |
     | SimpleQA/PopQA | 5/100: q009, q016, q038, q076, q083 | 14/100 |

   - The lists match the review's exactly.
   - **Every result below is also reported with these items excluded.**

### Primary reviewer (8B, 150 chars), label = adjudicated, single-call metrics (mean over seeds 0–2) [95% bootstrap CI]

| Set | n | wrong rate | single-call AUROC (± SD over seeds) | single-call ECE | @0.70: escalation rate · precision · recall | pooled AUROC (secondary) |
|---|---|---|---|---|---|---|
| SimpleQA/PopQA, all | 98 | 0.50 | **0.778 ± 0.008** [0.682, 0.864] | 0.276 [0.193, 0.368] | 0.26 · 0.68 [0.49, 0.85] · **0.35** [0.23, 0.48] | 0.775 |
| SimpleQA/PopQA, leaks excluded | 93 | 0.52 | **0.792 ± 0.007** [0.696, 0.879] | 0.296 [0.211, 0.387] | 0.24 · 0.72 [0.54, 0.89] · 0.34 [0.22, 0.47] | 0.789 |
| SimpleQA/PopQA, all exposed excluded | 84 | 0.51 | 0.803 ± 0.013 [0.709, 0.892] | 0.296 | 0.23 · 0.76 · 0.33 | 0.801 |
| FRAMES, all | 59 | 0.80 | **0.644 ± 0.013** [0.517, 0.760] | 0.485 [0.372, 0.585] | 0.32 · 0.95 [0.83, 1.00] · 0.38 [0.25, 0.52] | 0.661 |
| FRAMES, leaks excluded | 48 | 0.90 | **0.681 ± 0.017** [0.547, 0.851] | 0.565 [0.461, 0.654] | 0.35 · 1.00 · 0.39 [0.24, 0.52] | 0.700 |
| FRAMES, all exposed excluded | 33 | 0.88 | 0.695 ± 0.025 [0.522, 0.898] | 0.528 | 0.35 · 1.00 · 0.40 | 0.711 |
| *Sensitivity: remaining low-confidence labels flipped* — SimpleQA/PopQA | 98 | 0.50 | 0.778 [0.682, 0.865] | 0.276 | 0.26 · 0.68 · 0.35 | 0.775 |
| *Sensitivity: remaining low-confidence labels flipped* — FRAMES | 59 | 0.78 | 0.644 [0.519, 0.755] | 0.468 | 0.32 · 0.95 · 0.39 | 0.662 |

**Old vs new (primary condition)**

| Set | Old (v1 label, pooled AUROC, §4) | New (adjudicated, single-call AUROC) |
|---|---|---|
| SimpleQA/PopQA | 0.701 [0.594, 0.801], n = 100 | 0.778 [0.682, 0.864], n = 98 (0.733 before the round-2 relabelling) |
| FRAMES | 0.707 [0.584, 0.824], n = 60 (or 0.765 on the 47-question short subset) | 0.644 [0.517, 0.760], n = 59 (0.645 before round 2) |

**Sensitivity to the label (single-call AUROC, primary condition)**

| Set | v1 matcher | v2 matcher | qwen2.5:7b grader (LLM) | adjudicated (Claude, LLM) |
|---|---|---|---|---|
| SimpleQA/PopQA (n = 98) | 0.718 | 0.726 | 0.735 | 0.778 |
| FRAMES (n = 59) | 0.677 | 0.542 | 0.615 | 0.644 |
| FRAMES, leaks excluded (n = 48) | 0.698 | 0.437 (v2 leaves only 2 correct briefs; degenerate) | 0.616 | 0.681 |

The SimpleQA/PopQA result is above chance under every label (0.72–0.78). **The FRAMES result is label-sensitive**: it ranges from 0.54 to 0.68 on all 59 briefs and from 0.44 to 0.70 with leaks excluded (n = 48), and several of its CIs reach close to 0.5.

**Label agreement (Cohen's κ)**

| Comparison | κ | Note |
|---|---|---|
| FRAMES, fully adjudicated: v1 vs adjudicated | 0.57 | |
| FRAMES, fully adjudicated: v2 vs adjudicated | 0.60 | |
| FRAMES, fully adjudicated: qwen grader vs adjudicated | 0.47 | |
| SimpleQA/PopQA: v1 vs adjudicated | 0.78 | |
| SimpleQA/PopQA: qwen vs adjudicated | 0.92 | Inflated by construction: undisputed items are ones where qwen already agreed |

**Baselines (adjudicated label; AUROC [CI])**

| Set | random escalation | fewer sources = riskier | shorter brief = riskier |
|---|---|---|---|
| SimpleQA/PopQA (n = 98) | 0.50 (0.39–0.61); precision = base rate 0.50 | 0.52 [0.44, 0.60] | 0.50 [0.38, 0.61] |
| FRAMES (n = 59) | 0.50 (0.32–0.68); precision = 0.80 | 0.48 [0.31, 0.64] | 0.48 [0.29, 0.67] |

The reviewer beats all three baselines on SimpleQA/PopQA. On FRAMES its CI lower bound (0.52) only just clears chance.

**Ablations (FRAMES, adjudicated, single-call AUROC; paired pooled-AUROC difference vs primary [CI])**

| Ablation | All (n = 59) | Leaks excluded (n = 48) |
|---|---|---|
| (a) 350-char snippets | 0.682, Δ +0.04 [−0.06, 0.15] | 0.734, Δ +0.05 [−0.06, 0.21] |
| (b) 3B reviewer | 0.684, Δ +0.04 [−0.11, 0.18] | 0.664, Δ −0.02 [−0.27, 0.25] |

- All CIs include 0, so neither ablation is resolved. The 3B difference even changed sign after the round-2 relabelling, which shows how fragile it is.
- The 3B reviewer produced **2 unparseable JSON outputs out of 180** (seeds 0 and 2). The reviewer's own fallback scores these as confidence 0 and escalates them. They are counted in `results_v2*.json → reviewer_parse_failures`. Every other run returned valid JSON with a numeric confidence (checked in the raw logs), so the C3 and C9 coercion fixes did not change any result.
- Ablation (c) (citations) is unchanged; see §4.

### Retrieval vs correctness (correlational, leaks excluded, adjudicated label)

| Set | Gold in a selected snippet | Gold in no selected snippet |
|---|---|---|
| SimpleQA/PopQA (n = 93) | correct 37/43 = 0.86 | correct 8/50 = 0.16 |
| FRAMES (n = 48) | correct 1/4 | correct 4/44 = 0.09 |

- On FRAMES, almost every brief with the answer in a snippet was a leaked item, so the earlier "77–94% vs 14–18%" split relied heavily on leaked items. **It is withdrawn.**
- This is an association. It does not decompose errors into retrieval vs generation causes.
- "Gold in snippet" uses the v1 matcher on the 350-char snippets.

### What the corrected numbers support / do not support

**Supported:**
- On SimpleQA/PopQA, single-call reviewer confidence ranks wrong briefs above chance, with a CI lower bound of 0.68 under the adjudicated label; it stays above chance under every label and with leaks excluded.
- It is overconfident (ECE 0.28–0.30).
- At 0.70 it escalates only about 35% of wrong briefs.

**Not supported:**
- A FRAMES-specific claim stronger than "weaker and label-sensitive".
- Any ablation effect.
- Anything validated by human labels: the primary labels are Claude-adjudicated.

## 4. ORIGINAL-label results (2026-10-02) - SUPERSEDED by §4b

The numbers in this section use the v1 matcher and include leaked and gold-in-question items. They are kept unchanged for the record. Do not cite them; use §4b.

### Setup

**Models.** Every pipeline stage ran on local `llama3.1:8b` via Ollama, with `num_ctx` 8192, one request at a time, and each model unloaded before switching. This is the same model family as the production configuration (`llama-3.1-8b-instant`). The writer is that same 8B model, which matches `.env`, where `WRITER_MODEL` is unset.

**Seeds.** The writer ran with seed 0. The reviewer ran with seeds 0, 1 and 2, at the production temperature of 0.1.

**Label.** A brief is *wrong* when it does not contain the gold answer (deterministic match, no LLM).
- As a robustness check, an LLM grader (`qwen2.5:7b`, a different model family) re-labelled every brief. Those labels are LLM-created.
- No stage process failed: `reviewer_failures` is 0. *Correction (fix phase):* the 3B reviewer did return 2 unparseable JSON outputs (out of 180), which its fallback scores as confidence 0 (§4b).

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
- **C9: reviewer coercion edge cases (reproduce, then fix).**
  - `confidence: true` became 1.0 and published; `REVIEWER_SNIPPET_CHARS=""` became 0 chars.
  - Two failing tests: commit add391c, `eval_sop/tests/output_before_fix2.txt`.
  - Fix: commit cabb99e, 8/8 tests pass, `output_after_fix2.txt`.
  - All raw reviewer outputs had numeric confidences, so no result changes.
- **C10: no hardcoded `.env` paths.** `grade_llm.py` and `run_pipeline.mjs` now read `EVAL_KEY_FILE` from the environment. It has no default and is only needed for the Groq path (commit 5f55f02).
- **C11: corrected labels.** Matcher v2, gold-in-question drop, leak flags, and the adjudication CSV (Claude, not human). Also `analyze.py` single-call metrics, parse-failure counting, `EVAL_EXCLUDE_LEAKED`, and a faster exact AUROC (equal to sklearn, `tests/test_analyze_auroc.py`). Commits 55d5318, df1b580, 3fe275f.
  - Verification: with `EVAL_KEEP_GIQ=1`, the new code reproduces the original v1 numbers exactly (e.g. SimpleQA/PopQA pooled AUROC 0.70149, CI [0.5941, 0.8007]).
  - The original `results*.json` files are untouched; new outputs use `_v2`.
- **C12: `run_all.sh`** now also produces `results_short.json` (FRAMES) and the `_v2` results.
- **C13: incomplete pilot reviews and grades** moved to `runs/pilot_groq/incomplete_not_analysed/` (commit a400d08). I chose to move them rather than delete them, to keep provenance.
- **C14: gzip raw writer logs.** `gen_w0.jsonl` became `.gz` in all three runs. `grade_match.py` reads `.gz`, and the regenerated `labels_match.jsonl` is byte-identical (commit c819d9f).
- **C15: `SOURCES.md` licence lines** (commit f0b10c9):
  - SimpleQA: MIT, per its dataset card.
  - PopQA: not stated in the cached card.
  - RAGTruth: not verified.
- **C16 (round 2): FRAMES label-sensitivity range** corrected to 0.54–0.68 (all 59). 0.70 belongs to the leak-excluded range, 0.44–0.70 (commit 7073049).
- **C17 (round 2): leak SOP sentence** now says "the main results" (commit cd8fc4d).
- **C18 (round 2): adjudication.**
  - f001, f011, q024, q065 and q083 relabelled as wrong after re-reading; I agreed with the reviewer on all five (commit 48b25b5).
  - Added an `adjudicated_lowflip` sensitivity label (commit 0687f45).
  - Re-ran all analyses. Effect: SimpleQA/PopQA single-call AUROC 0.733 → 0.778; FRAMES 0.645 → 0.644.
- **C19 (round 2): test outputs.**
  - Local paths redacted to `<WORKTREE>` in `output_before_fix*.txt` (commit 0b37910).
  - Also in `output_fuzzy_before_fix.txt`, which I first committed unredacted in 56085f2 and fixed in 84c3fe5. The path is still present in 56085f2's history, because no history rewrite was allowed.
- **C20 (round 2): spelling tolerance.**
  - A new test reproduced false positives (Hansen/Hanson, Janson/Jansen, Morris/Morrie, Lakers/Bakers, Smithe/Smythe): commit 56085f2.
  - Fix: tolerance narrowed to doubled-letter variants (commit f169730). Test passes.
  - No label changed in either run.
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

## 8b. Confer material: for the user to decide (not touched)

- `05-research-desk.html`: the committed assignment brief from Confer Inc. It may be confidential.
- `README.md` line 3: the header "Confer Inc. · AI/ML Engineering Take-Home · Assignment 5 of 5".
- `README.md` §"A+ rubric mapping" (line 440 onward): a table mapping the assignment's rubric signals.

None of these were modified on this branch.

## 9. SOP-ready sentences (strictly true as of the fix phase; never mixing subsets in one sentence)

- "On 98 SimpleQA/PopQA research briefs, the reviewer agent's self-reported confidence ranked wrong briefs above chance (single-call AUROC 0.78, 95% CI 0.68–0.86) but was overconfident (ECE 0.28); at the deployed 0.70 threshold it escalated only about 35% of wrong briefs."
- "On harder multi-hop FRAMES questions the signal was weaker and depended on how answers were labelled (single-call AUROC 0.54–0.68 across four labelings)."
- "Before using an NLI model as an automatic support judge, I validated it against human hallucination labels (RAGTruth); it performed at chance on held-out data (AUROC 0.44), so I excluded it."
- "I found that the web-search cache contained public copies of the benchmarks, flagged answer-revealing leaks programmatically (11 of 60 FRAMES and 5 of 100 SimpleQA/PopQA questions), and report the main results with them excluded."
- "With leaked items excluded, SimpleQA/PopQA briefs were correct 86% of the time when a retrieved snippet contained the answer versus 16% when none did (n = 43 / 50); this is a correlation, not a causal attribution."
- Caveat to keep with any of these: correctness labels are deterministic matching plus adjudication by an LLM (Claude), not human annotation.

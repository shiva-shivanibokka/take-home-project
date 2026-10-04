#!/usr/bin/env bash
# Full local reproduction (Git Bash, from the repo root). One Ollama request at a time,
# num_ctx 8192, each model explicitly unloaded (keep_alive 0) before switching.
#   bash eval_sop/run_all.sh frames     # Tier 1: FRAMES n=60, all conditions
#   bash eval_sop/run_all.sh local      # Tier 2: SimpleQA/PopQA n=100, primary reviewer only
set -euo pipefail
export OMP_NUM_THREADS=2 EVAL_NUM_CTX=8192 PYTHONIOENCODING=utf-8
unload() { curl -s http://127.0.0.1:11434/api/generate -d "{\"model\":\"$1\",\"keep_alive\":0}" > /dev/null; echo "unloaded $1"; }
R=node; P=eval_sop/run_pipeline.mjs
case "$1" in
  frames)
    export EVAL_RUN=frames EVAL_QUESTIONS=questions_frames.json
    $R $P gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0
    for s in 0 1 2; do $R $P review --base ollama --model llama3.1:8b --snip 150 --seed $s; done
    for s in 0 1 2; do $R $P review --base ollama --model llama3.1:8b --snip 350 --seed $s; done
    unload llama3.1:8b
    for s in 0 1 2; do $R $P review --base ollama --model llama3.2:latest --snip 150 --seed $s; done
    unload llama3.2:latest
    python eval_sop/grade_llm.py --model qwen2.5:7b
    unload qwen2.5:7b ;;
  local)
    export EVAL_RUN=local EVAL_QUESTIONS=questions.json
    $R $P gen --base ollama --cmodel llama3.1:8b --wmodel llama3.1:8b --seed 0 --limit 100
    for s in 0 1 2; do $R $P review --base ollama --model llama3.1:8b --snip 150 --seed $s --limit 100; done
    unload llama3.1:8b
    python eval_sop/grade_llm.py --model qwen2.5:7b
    unload qwen2.5:7b ;;
esac
python eval_sop/grade_match.py
# original (v1-label) results: results.json [+ results_short.json for FRAMES]; labels_v2.jsonl is
# moved aside for this step so analyze.py runs in its original mode
[ -f "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl" ] && mv "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl" "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl.hold"
python eval_sop/analyze.py
[ "$1" = frames ] && EVAL_SHORT_ONLY=1 python eval_sop/analyze.py
[ -f "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl.hold" ] && mv "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl.hold" "eval_sop/runs/$EVAL_RUN/labels_v2.jsonl"
# corrected labels (fix phase): v2 matcher + adjudication CSV (Claude, not human) + leak flags
python eval_sop/labels_v2.py
python eval_sop/analyze.py                                # results_v2.json
EVAL_EXCLUDE_LEAKED=answer   python eval_sop/analyze.py   # results_v2_noleak.json
EVAL_EXCLUDE_LEAKED=exposure python eval_sop/analyze.py   # results_v2_noexposure.json

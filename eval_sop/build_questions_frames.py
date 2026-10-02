"""OPTIONAL question set from FRAMES (google/frames-benchmark, Apache-2.0; 824 multi-hop
questions with human-written gold answers). Downloaded with the user's approval (2026-10-02); raw file is not committed
(see eval_sop/external/SOURCES.md for revision + sha256). To reproduce:
    hf download google/frames-benchmark test.tsv --repo-type dataset --revision 58d9fb6330f3ab1316d1eca12e5e8ef23dcc22ef --local-dir eval_sop/external/frames
    python eval_sop/build_questions_frames.py --n 60
    EVAL_QUESTIONS=questions_frames.json python eval_sop/search_ddg.py
    EVAL_RUN=frames EVAL_QUESTIONS=questions_frames.json node eval_sop/run_pipeline.mjs gen ...
Strata = first listed reasoning type (12 per type, seed 0).
NOTE (2026-10-02): a filter restricting the pool to gold answers of <= 5 words was
INTENDED but never inserted (a scripted string replacement silently failed), so
questions_frames.json - the file actually used for the run - contains 13/60
long-answer questions (meta.long_answer = true). This script is left as-is so that it
reproduces that file exactly. The pre-intended restriction is applied at analysis time
instead:  EVAL_SHORT_ONLY=1 python eval_sop/analyze.py  (n = 47). See RESULTS.md."""
import argparse, json, os
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "external", "frames", "test.tsv")


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--n", type=int, default=60); a = ap.parse_args()
    if not os.path.exists(SRC):
        raise SystemExit(f"{SRC} missing - FRAMES download needs the user's permission (see docstring).")
    df = pd.read_csv(SRC, sep="\t")
    df["stratum"] = df["reasoning_types"].astype(str).str.split("|").str[0].str.strip().str.lower().str.replace(" ", "_")
    k = max(1, a.n // df.stratum.nunique())
    s = pd.concat([g.sample(min(k, len(g)), random_state=0) for _, g in df.groupby("stratum")])
    if len(s) < a.n:
        s = pd.concat([s, df.drop(s.index).sample(a.n - len(s), random_state=0)])
    out = [{"id": f"f{j + 1:03d}", "source": "frames", "row": int(i), "stratum": "frames_" + r.stratum,
            "question": r.Prompt, "answers": [str(r.Answer)], "meta": {"reasoning_types": r.reasoning_types,
            "long_answer": len(str(r.Answer).split()) > 5}} for j, (i, r) in enumerate(s.head(a.n).iterrows())]
    json.dump(out, open(os.path.join(HERE, "questions_frames.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
    print(len(out), pd.Series([q["stratum"] for q in out]).value_counts().to_dict())


if __name__ == "__main__":
    main()

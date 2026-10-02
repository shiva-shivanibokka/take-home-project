"""OPTIONAL question set from FRAMES (google/frames-benchmark, Apache-2.0; 824 multi-hop
questions with human-written gold answers). NOT on this machine: downloading it needs the
user's explicit permission. After that:
    hf download google/frames-benchmark test.tsv --repo-type dataset --local-dir eval_sop/external/frames
    python eval_sop/build_questions_frames.py --n 60
    EVAL_QUESTIONS=questions_frames.json python eval_sop/search_ddg.py
    EVAL_RUN=frames EVAL_QUESTIONS=questions_frames.json node eval_sop/run_pipeline.mjs gen ...
Strata = first listed reasoning type. Answers longer than 5 words are flagged
`long_answer`; string-match labels are unreliable for those, so analyses report the
short-answer subset separately."""
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

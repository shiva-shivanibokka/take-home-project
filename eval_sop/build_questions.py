"""Build the question set from LOCALLY CACHED public QA datasets (no download):
  - SimpleQA (OpenAI; basicv8vc/SimpleQA mirror, MIT): 50 random questions.
  - PopQA (akariasai/PopQA): 25 high-popularity (s_pop top quartile) + 25 low-popularity
    (bottom quartile) questions, restricted to relations whose answers are names/places
    (free-text relations like occupation/genre are excluded: aliases such as "pol"
    make string matching unreliable). Aliases < 3 chars are dropped.
FRAMES (google/frames-benchmark) was the user's first choice but is not cached locally
and downloading needs the user's explicit permission; see RESULTS.md."""
import pandas as pd, glob, json, os, ast
SEED = 0
HUB = os.path.expanduser("~/.cache/huggingface/hub")
HERE = os.path.dirname(os.path.abspath(__file__))
s = pd.read_csv(glob.glob(f"{HUB}/datasets--basicv8vc--SimpleQA/snapshots/*/simple_qa_test_set.csv")[0])
p = pd.read_csv(glob.glob(f"{HUB}/datasets--akariasai--PopQA/snapshots/*/test.tsv")[0], sep="\t")
out = []
for i, r in s.sample(50, random_state=SEED).iterrows():
    md = ast.literal_eval(r.metadata)
    out.append({"source": "simpleqa", "row": int(i), "stratum": "simpleqa", "question": r.problem,
                "answers": [str(r.answer)], "meta": {"topic": md.get("topic"), "answer_type": md.get("answer_type")}})
KEEP = {"place of birth", "capital", "country", "director", "author", "composer", "producer",
        "screenwriter", "father", "mother", "capital of"}
p = p[p.prop.isin(KEEP)]
q1, q3 = p.s_pop.quantile(0.25), p.s_pop.quantile(0.75)
for name, sub in [("popqa_high", p[p.s_pop >= q3]), ("popqa_low", p[p.s_pop <= q1])]:
    for i, r in sub.sample(25, random_state=SEED).iterrows():
        ans = [a for a in json.loads(r.possible_answers) if len(a) >= 3]
        out.append({"source": "popqa", "row": int(i), "stratum": name, "question": r.question,
                    "answers": ans, "meta": {"prop": r.prop, "s_pop": int(r.s_pop)}})
for k, q in enumerate(out): q["id"] = f"q{k+1:03d}"
json.dump(out, open(os.path.join(HERE, "questions.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(len(out), pd.Series([q["stratum"] for q in out]).value_counts().to_dict(), "quartiles", q1, q3)

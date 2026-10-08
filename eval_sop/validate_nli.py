"""Validate the NLI support judge against PUBLIC HUMAN labels before it is used anywhere.

Judge: cross-encoder/nli-deberta-v3-large (already in the local HF cache), CPU only,
OMP_NUM_THREADS=2. A sentence is "supported" if max over ~350-word context windows of
P(entailment) >= t (the model's input limit is 512 tokens).

Benchmark: RAGTruth (Niu et al., 2024), human span-level hallucination annotations of
RAG responses, test split, copied read-only from another local worktree
(source: huggingface.co/datasets/wandb/RAGTruth-processed, data/test-00000-of-00001.parquet;
sha256 recorded in eval_sop/external/SOURCES.md). LLM-AggreFact was not approved.

Unit = response sentence (nltk). Human label: unsupported if the sentence overlaps any
annotated hallucination span (evident conflict or baseless info).
Protocol (fixed before seeing results): sample N_PER_TASK responses per task type
(QA / Summary / Data2txt, seed 0, quality == "good"); 30% of responses (seed 0) form a
dev split used only to pick t (grid 0.05..0.95, max balanced accuracy); report balanced
accuracy, Cohen's kappa and AUROC on the other 70%, with 2000-resample bootstrap 95% CIs
(resampling responses). Also report the fixed t = 0.5.

  OMP_NUM_THREADS=2 python eval_sop/validate_nli.py --n-per-task 50
  python eval_sop/validate_nli.py --smoke      # 4 hand-written pairs; checks the code runs, NOT a result
"""
import argparse, glob, json, os
os.environ.setdefault("OMP_NUM_THREADS", "2")
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "external", "ragtruth", "test.parquet")
OUT = os.path.join(HERE, "runs", "nli_validation")
MODEL = "cross-encoder/nli-deberta-v3-large"


def load_judge():
    os.environ.setdefault("USE_TF", "0"); os.environ.setdefault("USE_FLAX", "0")
    import torch
    from transformers import AutoTokenizer, AutoModelForSequenceClassification
    torch.set_num_threads(int(os.environ["OMP_NUM_THREADS"]))
    tok = AutoTokenizer.from_pretrained(MODEL)
    mdl = AutoModelForSequenceClassification.from_pretrained(MODEL).eval()
    labels = [mdl.config.id2label[i].lower() for i in range(len(mdl.config.id2label))]

    class CE:
        def predict(self, pairs, batch_size=8):
            out = []
            with torch.no_grad():
                for i in range(0, len(pairs), batch_size):
                    b = pairs[i:i + batch_size]
                    enc = tok([x[0] for x in b], [x[1] for x in b], truncation="only_first", max_length=512,
                              padding=True, return_tensors="pt")
                    out.append(torch.softmax(mdl(**enc).logits, -1).numpy())
            return np.concatenate(out)
    return CE(), labels.index("entailment")


def chunks(doc, words=350, stride=250):
    w = doc.split()
    if len(w) <= words:
        return [doc]
    return [" ".join(w[i:i + words]) for i in range(0, max(1, len(w) - words + stride), stride)]


def score(ce, ent, pairs, bs=8):
    out = []
    for doc, claim in pairs:
        cs = chunks(doc)
        logits = ce.predict([(c, claim) for c in cs], batch_size=bs)
        out.append(float(np.max(np.asarray(logits)[:, ent])))
    return np.array(out)


def metrics(y, p, t):
    from sklearn.metrics import balanced_accuracy_score, cohen_kappa_score, roc_auc_score
    yh = (p >= t).astype(int)
    return {"balanced_accuracy": float(balanced_accuracy_score(y, yh)), "cohen_kappa": float(cohen_kappa_score(y, yh)),
            "auroc": float(roc_auc_score(y, p)) if 0 < y.sum() < len(y) else None, "n": int(len(y)), "pos_rate": float(y.mean())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-per-task", type=int, default=50)
    ap.add_argument("--smoke", action="store_true")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    ce, ent = load_judge()
    if a.smoke:
        pairs = [("The Eiffel Tower is in Paris and was completed in 1889.", "The Eiffel Tower was completed in 1889."),
                 ("The Eiffel Tower is in Paris and was completed in 1889.", "The Eiffel Tower is in Rome."),
                 ("Water boils at 100 C at sea level.", "Water boils at 100 C at sea level."),
                 ("Water boils at 100 C at sea level.", "Water was discovered by Newton.")]
        p = score(ce, ent, pairs)
        print("SMOKE TEST ONLY (hand-written pairs, expected high/low/high/low):", np.round(p, 3).tolist())
        json.dump({"smoke_scores": p.tolist(), "note": "code check only, not a validation result"},
                  open(os.path.join(OUT, "smoke.json"), "w"), indent=1)
        return
    import pandas as pd, nltk, time
    if not os.path.exists(EXT):
        raise SystemExit(f"{EXT} missing - copy the local RAGTruth parquet (see docstring).")
    df = pd.read_parquet(EXT)
    df = df[df.quality == "good"]
    resp = pd.concat([g.sample(a.n_per_task, random_state=0) for _, g in df.groupby("task_type")])
    rng = np.random.default_rng(0)
    is_dev = rng.random(len(resp)) < 0.30
    rows = []
    for (idx, r), dev in zip(resp.iterrows(), is_dev):
        spans = [(h["start"], h["end"]) for h in json.loads(r.hallucination_labels or "[]")]             if isinstance(r.hallucination_labels, str) else [(h["start"], h["end"]) for h in (r.hallucination_labels or [])]
        pos = 0
        for sent in nltk.sent_tokenize(r.output):
            st = r.output.find(sent, pos); en = st + len(sent); pos = max(pos, en)
            if len(sent.split()) < 4:
                continue
            bad = any(st < e and s0 < en for s0, e in spans)
            rows.append({"resp_id": r.id, "task": r.task_type, "split": "dev" if dev else "test",
                         "sentence": sent, "context": r.context, "human_supported": int(not bad)})
    S = pd.DataFrame(rows)
    t0 = time.time()
    S["p_entail"] = score(ce, ent, list(zip(S.context, S.sentence)))
    secs = time.time() - t0
    dv, ts = S[S.split == "dev"], S[S.split == "test"]
    grid = np.round(np.arange(0.05, 0.951, 0.05), 2)
    t = float(grid[int(np.argmax([metrics(dv.human_supported.values, dv.p_entail.values, g)["balanced_accuracy"] for g in grid]))])
    y, p = ts.human_supported.values, ts.p_entail.values
    res = {"model": MODEL, "benchmark": "RAGTruth test (wandb/RAGTruth-processed), human span labels",
           "unit": "response sentence; label 1 = supported (no overlap with a human hallucination span)",
           "n_responses": int(len(resp)), "n_sentences": int(len(S)), "cpu_seconds": round(secs, 1),
           "threshold_from_dev": t, "dev": metrics(dv.human_supported.values, dv.p_entail.values, t),
           "test": metrics(y, p, t), "test_at_0.5": metrics(y, p, 0.5), "per_task_test": {}}
    ids = ts.resp_id.unique(); groups = {i: np.where(ts.resp_id.values == i)[0] for i in ids}
    bs = []
    for _ in range(2000):
        ii = np.concatenate([groups[i] for i in rng.choice(ids, len(ids))])
        m = metrics(y[ii], p[ii], t); bs.append((m["balanced_accuracy"], m["cohen_kappa"], m["auroc"] or np.nan))
    bs = np.array(bs, float)
    for k, j in (("balanced_accuracy", 0), ("cohen_kappa", 1), ("auroc", 2)):
        res["test"][k + "_ci"] = np.nanpercentile(bs[:, j], [2.5, 97.5]).tolist()
    for name in sorted(ts.task.unique()):
        m = (ts.task == name).values
        res["per_task_test"][name] = metrics(y[m], p[m], t)
    S.drop(columns=["context"]).to_csv(os.path.join(OUT, "sentence_scores.csv"), index=False)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    print(json.dumps(res, indent=1))

if __name__ == "__main__":
    main()

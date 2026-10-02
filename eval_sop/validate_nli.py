"""Validate the NLI support judge against PUBLIC HUMAN labels before it is used anywhere.

Judge: cross-encoder/nli-deberta-v3-large (already in the local HF cache), CPU only.
A claim is "supported" if max_chunk P(entailment) >= t over ~350-word windows of the
grounding document (the model's input limit is 512 tokens).

Benchmark: LLM-AggreFact (Tang et al., 2024; human-labeled claim/document support).
NOT present on this machine; it must be downloaded first, which needs the user's
explicit permission (see RESULTS.md "Pending user actions"). Expected layout after:
    hf download lytang/LLM-AggreFact --repo-type dataset --local-dir eval_sop/external/llm-aggrefact
(parquet files with columns: dataset, doc, claim, label  [label 1 = supported]).

Protocol (fixed before seeing results): from the `dev` split choose the threshold t that
maximises balanced accuracy (grid 0.05..0.95); report balanced accuracy, Cohen's kappa
and AUROC on a stratified sample of the `test` split (N_PER_DATASET per source dataset,
seed 0), with 2000-sample bootstrap 95% CIs.

  OMP_NUM_THREADS=2 python eval_sop/validate_nli.py --n-per-dataset 40
  python eval_sop/validate_nli.py --smoke      # 4 hand-written pairs; checks the code runs, NOT a result
"""
import argparse, glob, json, os
os.environ.setdefault("OMP_NUM_THREADS", "2")
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.join(HERE, "external", "llm-aggrefact")
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
    ap.add_argument("--n-per-dataset", type=int, default=40)
    ap.add_argument("--n-dev-per-dataset", type=int, default=15)
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
    import pandas as pd
    files = glob.glob(os.path.join(EXT, "**", "*.parquet"), recursive=True)
    if not files:
        raise SystemExit(f"LLM-AggreFact not found under {EXT} - download needs the user's permission (see docstring).")
    df = pd.concat([pd.read_parquet(f).assign(split=("dev" if "dev" in os.path.basename(f) else "test")) for f in files])
    rng = np.random.default_rng(0)
    def strat(split, k):
        parts = [g.sample(min(k, len(g)), random_state=0) for _, g in df[df.split == split].groupby("dataset")]
        return pd.concat(parts)
    dev, test = strat("dev", a.n_dev_per_dataset), strat("test", a.n_per_dataset)
    pdev = score(ce, ent, list(zip(dev.doc, dev.claim))); ydev = dev.label.astype(int).values
    grid = np.round(np.arange(0.05, 0.951, 0.05), 2)
    t = float(grid[int(np.argmax([metrics(ydev, pdev, g)["balanced_accuracy"] for g in grid]))])
    ptest = score(ce, ent, list(zip(test.doc, test.claim))); ytest = test.label.astype(int).values
    res = {"model": MODEL, "threshold_from_dev": t, "dev": metrics(ydev, pdev, t), "test": metrics(ytest, ptest, t),
           "test_at_0.5": metrics(ytest, ptest, 0.5), "per_dataset": {}}
    bs = []
    for _ in range(2000):
        i = rng.integers(0, len(ytest), len(ytest)); m = metrics(ytest[i], ptest[i], t)
        bs.append((m["balanced_accuracy"], m["cohen_kappa"]))
    bs = np.array(bs)
    res["test"]["balanced_accuracy_ci"] = np.percentile(bs[:, 0], [2.5, 97.5]).tolist()
    res["test"]["cohen_kappa_ci"] = np.percentile(bs[:, 1], [2.5, 97.5]).tolist()
    for name in sorted(test.dataset.unique()):
        m = (test.dataset == name).values
        res["per_dataset"][name] = metrics(ytest[m], ptest[m], t)
    pd.DataFrame({"dataset": test.dataset.values, "label": ytest, "p_entail": ptest}).to_csv(os.path.join(OUT, "test_scores.csv"), index=False)
    json.dump(res, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    print(json.dumps(res["test"], indent=1))


if __name__ == "__main__":
    main()

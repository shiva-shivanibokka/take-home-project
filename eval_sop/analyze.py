"""Analysis: does the Reviewer's self-reported confidence predict wrong briefs?
Reads data/labels_match.jsonl (primary, deterministic), data/labels_llm_*.jsonl
(LLM-created robustness labels) and data/reviews/*.jsonl. Writes data/results.json,
data/threshold_sweep.csv and data/reliability.png.  Bootstrap: 2000 resamples of
questions, numpy seed 0, percentile 95% CIs."""
import glob, json, os, re
from collections import defaultdict
import numpy as np
from sklearn.metrics import roc_auc_score, cohen_kappa_score

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "runs", os.environ.get("EVAL_RUN", "local"))  # see run_pipeline.mjs
QFILE = os.path.join(HERE, os.environ.get("EVAL_QUESTIONS", "questions.json"))
B = 2000
THR = 0.70


def jl(p):
    return [json.loads(l) for l in open(p, encoding="utf-8") if l.strip()]


def auroc(y, s):
    return float(roc_auc_score(y, s)) if 0 < y.sum() < len(y) else float("nan")


def ece(y_correct, conf, bins=10):
    edges = np.linspace(0, 1, bins + 1); e = 0.0
    idx = np.clip(np.digitize(conf, edges[1:-1], right=True), 0, bins - 1)
    for b in range(bins):
        m = idx == b
        if m.any():
            e += m.mean() * abs(y_correct[m].mean() - conf[m].mean())
    return float(e)


def esc_stats(y_bad, escalate):
    tp = (escalate & (y_bad == 1)).sum()
    prec = tp / escalate.sum() if escalate.sum() else float("nan")
    rec = tp / (y_bad == 1).sum() if (y_bad == 1).sum() else float("nan")
    return float(prec), float(rec), float(escalate.mean())


def boot(fn, n, rng):
    vals = []
    for _ in range(B):
        i = rng.integers(0, n, n)
        v = fn(i)
        if v is not None and not np.isnan(v):
            vals.append(v)
    return [float(np.percentile(vals, 2.5)), float(np.percentile(vals, 97.5))] if vals else [None, None]


def summarize(y_bad, conf, rng, escalate=None):
    y_bad = np.asarray(y_bad, int); conf = np.asarray(conf, float)
    esc = conf < THR if escalate is None else np.asarray(escalate, bool)
    p, r, er = esc_stats(y_bad, esc)
    return {
        "n": int(len(y_bad)), "base_rate_bad": float(y_bad.mean()),
        "auroc": auroc(y_bad, -conf), "auroc_ci": boot(lambda i: auroc(y_bad[i], -conf[i]), len(y_bad), rng),
        "ece": ece(1 - y_bad, conf), "ece_ci": boot(lambda i: ece(1 - y_bad[i], conf[i]), len(y_bad), rng),
        "mean_conf": float(conf.mean()), "acc": float(1 - y_bad.mean()),
        "esc_precision": p, "esc_precision_ci": boot(lambda i: esc_stats(y_bad[i], esc[i])[0], len(y_bad), rng),
        "esc_recall": r, "esc_recall_ci": boot(lambda i: esc_stats(y_bad[i], esc[i])[1], len(y_bad), rng),
        "esc_rate": er,
    }


def main():
    rng = np.random.default_rng(0)
    lab = {r["qid"]: r for r in jl(os.path.join(D, "labels_match.jsonl"))}
    llm = {}
    for p in glob.glob(os.path.join(D, "labels_llm_*.jsonl")):
        name = os.path.basename(p)[len("labels_llm_"):-6]
        llm[name] = {r["qid"]: r["grade"] for r in jl(p)}
    # reviews: cond -> seed -> qid -> (conf, checks_failed, exit)
    revs = defaultdict(dict)
    fails = defaultdict(int)
    for p in sorted(glob.glob(os.path.join(D, "reviews", "*.jsonl"))):
        name = os.path.basename(p)[:-6]
        m = re.match(r"rev_(.+)_snip(\d+)_s(\d+)_w0", name)
        cond, seed = f"{m.group(1)}|snip{m.group(2)}", int(m.group(3))
        d = {}
        for r in jl(p):
            qid = r["jobId"].split("_")[0]
            if r["exit"] != 0 or not r["review"]:
                fails[cond] += 1; d[qid] = (0.0, True, r["exit"]); continue  # crash -> treat as escalate
            rv = r["review"]; ch = rv.get("checks", {})
            d[qid] = (float(rv["confidence"]), not all(bool(ch.get(k)) for k in ("citations_supported", "coverage", "factuality")), 0)
        revs[cond][seed] = d

    label_sets = {"match": {q: int(not r["correct_match"]) for q, r in lab.items()}}
    for name, g in llm.items():
        label_sets[f"llm_{name}"] = {q: int(v != "CORRECT") for q, v in g.items() if v != "PARSE_FAIL"}

    res = {"n_questions": len(lab), "label_agreement": {}, "conditions": {}, "baselines": {}, "diagnostics": {}, "reviewer_failures": dict(fails)}
    names = list(label_sets)
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = label_sets[names[i]], label_sets[names[j]]
            common = sorted(set(a) & set(b))
            x = np.array([a[q] for q in common]); y = np.array([b[q] for q in common])
            res["label_agreement"][f"{names[i]}~{names[j]}"] = {
                "n": len(common), "raw_agreement": float((x == y).mean()), "cohen_kappa": float(cohen_kappa_score(x, y))}

    for cond, seeds in revs.items():
        for lname, L in label_sets.items():
            qids = sorted(set(L) & set.intersection(*[set(v) for v in seeds.values()]))
            y = np.array([L[q] for q in qids])
            per_seed = {s: summarize(y, [seeds[s][q][0] for q in qids], rng) for s in sorted(seeds)}
            meanconf = np.array([np.mean([seeds[s][q][0] for s in seeds]) for q in qids])
            entry = {"seeds": sorted(seeds), "per_seed": per_seed, "seed_mean_conf": summarize(y, meanconf, rng)}
            for k in ("auroc", "ece", "esc_precision", "esc_recall", "esc_rate", "mean_conf"):
                v = np.array([per_seed[s][k] for s in per_seed], float)
                entry[f"{k}_mean_over_seeds"] = float(np.nanmean(v)); entry[f"{k}_std_over_seeds"] = float(np.nanstd(v, ddof=1)) if len(v) > 1 else 0.0
            s0 = sorted(seeds)[0]
            entry["rule_conf_or_checks_seed%d" % s0] = summarize(
                y, [seeds[s0][q][0] for q in qids], rng,
                escalate=[seeds[s0][q][0] < THR or seeds[s0][q][1] for q in qids])
            # seed-to-seed stability of the confidence itself
            if len(seeds) > 1:
                M = np.array([[seeds[s][q][0] for q in qids] for s in sorted(seeds)])
                entry["conf_std_across_seeds_mean"] = float(M.std(axis=0, ddof=1).mean())
                entry["verdict_flip_rate"] = float(((M < THR).any(0) & ~(M < THR).all(0)).mean())
                entry["n_distinct_conf_values"] = int(len(np.unique(M)))
            res["conditions"].setdefault(cond, {})[lname] = entry

    # baselines (primary + llm labels)
    for lname, L in label_sets.items():
        qids = sorted(set(L) & set(lab))
        y = np.array([L[q] for q in qids])
        nsrc = np.array([lab[q]["n_sources"] for q in qids], float)
        wc = np.array([lab[q]["word_count"] for q in qids], float)
        rnd = [auroc(y, rng.random(len(y))) for _ in range(1000)]
        res["baselines"][lname] = {
            "random": {"auroc_mean": float(np.mean(rnd)), "auroc_95range": [float(np.percentile(rnd, 2.5)), float(np.percentile(rnd, 97.5))],
                       "esc_precision_expected": float(y.mean()), "note": "precision of random escalation = base rate at any escalation rate"},
            "fewer_sources_is_riskier": {"auroc": auroc(y, -nsrc), "auroc_ci": boot(lambda i: auroc(y[i], -nsrc[i]), len(y), rng), "n_distinct_values": int(len(np.unique(nsrc)))},
            "shorter_brief_is_riskier": {"auroc": auroc(y, -wc), "auroc_ci": boot(lambda i: auroc(y[i], -wc[i]), len(y), rng)},
        }

    # diagnostics on primary label
    L = lab
    def rate(f):
        v = [r for r in L.values() if f(r)]
        return {"n": len(v), "acc_match": float(np.mean([r["correct_match"] for r in v])) if v else None}
    res["diagnostics"] = {
        "acc_overall": rate(lambda r: True),
        "by_stratum": {s: rate(lambda r, s=s: r["stratum"] == s) for s in sorted({r["stratum"] for r in L.values()})},
        "gold_in_snippets": rate(lambda r: r["gold_in_snippets"]), "gold_not_in_snippets": rate(lambda r: not r["gold_in_snippets"]),
        "frac_gold_in_snippets": float(np.mean([r["gold_in_snippets"] for r in L.values()])),
        "frac_gold_in_rev150": float(np.mean([r["gold_in_rev150"] for r in L.values()])),
        "strip_changed_correctness": int(sum(r["correct_match"] != r["correct_match_raw"] for r in L.values())),
    }
    # citation ablation (c)
    tot = sum(r["n_claim_sents"] for r in L.values())
    res["citation_ablation"] = {
        "n_briefs": len(L), "n_claim_sentences": tot,
        "kept_frac_sentences_with_marker": sum(r["n_marked"] for r in L.values()) / tot,
        "kept_frac_sentences_with_valid_marker": sum(r["n_marked_valid"] for r in L.values()) / tot,
        "stripped_frac_sentences_with_marker": sum(r["n_marked_after_strip"] for r in L.values()) / tot,
        "per_brief_marked_frac_mean": float(np.mean([r["n_marked"] / max(1, r["n_claim_sents"]) for r in L.values()])),
        "per_brief_marked_frac_std": float(np.std([r["n_marked"] / max(1, r["n_claim_sents"]) for r in L.values()], ddof=1)),
        "briefs_with_answer_sentence": sum(r["ans_sentence_present"] for r in L.values()),
        "answer_sentence_cited": sum(r["ans_sentence_cited"] for r in L.values()),
        "answer_sentence_cites_source_containing_gold": sum(r["ans_cited_source_contains_gold"] for r in L.values()),
    }
    json.dump(res, open(os.path.join(D, "results.json"), "w"), indent=1)

    # sweep + reliability for the primary condition
    prim = next((c for c in res["conditions"] if c.endswith("snip150") and "qwen" in c), None)
    if prim:
        seeds = revs[prim]; Lm = label_sets["match"]
        qids = sorted(set(Lm) & set.intersection(*[set(v) for v in seeds.values()]))
        y = np.array([Lm[q] for q in qids])
        with open(os.path.join(D, "threshold_sweep.csv"), "w") as f:
            f.write("condition,seed,threshold,esc_rate,precision,recall\n")
            for c2, sd in revs.items():
                for s, d in sd.items():
                    q2 = [q for q in qids if q in d]; yy = np.array([Lm[q] for q in q2]); cc = np.array([d[q][0] for q in q2])
                    for t in np.round(np.arange(0.05, 1.0001, 0.05), 2):
                        p, r, er = esc_stats(yy, cc < t)
                        f.write(f"{c2},{s},{t},{er:.3f},{p:.3f},{r:.3f}\n")
        import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
        mc = np.array([np.mean([seeds[s][q][0] for s in seeds]) for q in qids]); yc = 1 - y
        edges = np.linspace(0, 1, 11); idx = np.clip(np.digitize(mc, edges[1:-1], right=True), 0, 9)
        fig, ax = plt.subplots(1, 2, figsize=(9, 4))
        xs, ys, ns = [], [], []
        for b in range(10):
            m = idx == b
            if m.any(): xs.append(mc[m].mean()); ys.append(yc[m].mean()); ns.append(int(m.sum()))
        ax[0].plot([0, 1], [0, 1], "--", color="gray", lw=1, label="perfect calibration")
        ax[0].plot(xs, ys, "o-", color="#2a6fdb", label="reviewer (mean of seeds)")
        for x_, y_, n_ in zip(xs, ys, ns): ax[0].annotate(f"n={n_}", (x_, y_), textcoords="offset points", xytext=(4, -10), fontsize=8)
        ax[0].axvline(THR, color="#c0392b", lw=1, ls=":", label="escalation threshold 0.70")
        ax[0].set_xlabel("reviewer confidence"); ax[0].set_ylabel("fraction of briefs correct (gold-answer match)")
        ax[0].set_title(f"Reliability ({prim}, n={len(y)})", fontsize=9); ax[0].legend(fontsize=7); ax[0].set_xlim(0, 1); ax[0].set_ylim(0, 1)
        ax[1].hist([mc[y == 0], mc[y == 1]], bins=np.linspace(0, 1, 21), label=["correct", "wrong"], color=["#2a6fdb", "#e67e22"])
        ax[1].set_xlabel("reviewer confidence"); ax[1].set_ylabel("briefs"); ax[1].legend(fontsize=8); ax[1].set_title("Confidence by outcome", fontsize=9)
        fig.tight_layout(); fig.savefig(os.path.join(D, "reliability.png"), dpi=130)
    print(json.dumps({k: res[k] for k in ("n_questions", "label_agreement", "diagnostics")}, indent=1))
    for c, v in res["conditions"].items():
        e = v["match"]["seed_mean_conf"]
        print(c, "AUROC", round(e["auroc"], 3), e["auroc_ci"], "ECE", round(e["ece"], 3), "prec", round(e["esc_precision"], 3), "rec", round(e["esc_recall"], 3), "esc_rate", e["esc_rate"])


if __name__ == "__main__":
    main()

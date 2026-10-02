"""Deterministic (no-LLM) labels, computed from the pipeline's own outputs.

For every brief:
  correct_match   : the stored (published) brief contains a gold answer alias after
                    normalisation (accents/case/punctuation stripped, word-boundary match;
                    'Month D, YYYY' dates also accepted as 'D Month YYYY'; digit grouping
                    commas removed).  PRIMARY LABEL: wrong = not correct_match.
  gold_in_snippets: some selected source snippet (350 chars, what the Writer saw) contains gold.
  gold_in_rev150  : some snippet truncated to 150 chars (what the Reviewer sees) contains gold.
Citation ablation (c), from the Writer's raw LLM output (logged before the [n] stripping):
  per-sentence marker presence / validity, and whether the answer-bearing sentence cites
  a source whose snippet contains the gold answer.
Output: data/labels_match.jsonl
"""
import json, os, re, unicodedata
import nltk

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "runs", os.environ.get("EVAL_RUN", "local"))  # see run_pipeline.mjs
QFILE = os.path.join(HERE, os.environ.get("EVAL_QUESTIONS", "questions.json"))
MONTHS = "january february march april may june july august september october november december".split()


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"(?<=\d),(?=\d{3})", "", s)
    s = re.sub(r"[^a-z0-9]+", " ", s)
    return " " + " ".join(s.split()) + " "


def variants(ans: str):
    out = {norm(ans)}
    m = re.match(r"^\s*([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})\s*$", ans)
    if m and m.group(1).lower() in MONTHS:
        out.add(norm(f"{m.group(2)} {m.group(1)} {m.group(3)}"))
    return {v for v in out if v.strip()}


def contains(text: str, answers) -> bool:
    t = norm(text)
    return any(v in t for a in answers for v in variants(a))


STRIP_RE = re.compile(r"\s*\[\d+(?:[,\s]+\d+)*\]")  # identical to writer/skills/run.mjs:147
MARK_RE = re.compile(r"\[(\d+(?:[,\s]+\d+)*)\]")


def claim_sentences(md: str):
    sents = []
    for line in md.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^[*\-]\s+", "", line)
        line = re.sub(r"\*\*[^*]+\*\*:?", "", line).strip()  # bold bullet titles are not claims
        if len(line) < 3:
            continue
        sents.extend(s for s in nltk.sent_tokenize(line) if len(s.split()) >= 4)
    return sents


def main():
    qs = {q["id"]: q for q in json.load(open(QFILE, encoding="utf-8"))}
    raw_writer = {}
    for l in open(os.path.join(D, "llm_logs", "gen_w0.jsonl"), encoding="utf-8"):
        r = json.loads(l)
        if r["stage"] == "writer":
            raw_writer[r["job"]] = r["content"]  # last call wins (there is one per job)
    out = []
    for qid, q in qs.items():
        f = os.path.join(D, "db", f"{qid}_w0.json")
        if not os.path.exists(f):
            continue
        doc = json.load(open(f, encoding="utf-8"))
        h = doc.get("handoffs", {})
        if "writing" not in h:
            continue
        srcs = h["collecting"]["artifact"]["sources"]
        w = h["writing"]["artifact"]
        raw = raw_writer.get(f"{qid}_w0", "")
        ans = q["answers"]
        snip_hit = [contains(s.get("snippet", ""), ans) for s in srcs]
        # citation ablation (c)
        sents = claim_sentences(raw)
        n_marked = n_valid = 0
        for s in sents:
            ms = MARK_RE.findall(s)
            if ms:
                n_marked += 1
                idx = [int(x) for m in ms for x in re.split(r"[,\s]+", m) if x]
                if idx and all(1 <= i <= len(srcs) for i in idx):
                    n_valid += 1
        stripped = [STRIP_RE.sub("", s) for s in sents]
        n_marked_after = sum(bool(MARK_RE.search(s)) for s in stripped)
        ans_sents = [s for s in sents if contains(s, ans)]
        ans_cited = ans_supported = False
        for s in ans_sents:
            idx = [int(x) for m in MARK_RE.findall(s) for x in re.split(r"[,\s]+", m) if x]
            if idx:
                ans_cited = True
                if any(1 <= i <= len(srcs) and snip_hit[i - 1] for i in idx):
                    ans_supported = True
        out.append({
            "qid": qid, "stratum": q["stratum"], "question": q["question"], "answers": ans,
            "correct_match": contains(w["brief_markdown"], ans),
            "correct_match_raw": contains(raw, ans),
            "gold_in_snippets": any(snip_hit),
            "gold_in_rev150": any(contains(s.get("snippet", "")[:150], ans) for s in srcs),
            "n_sources": h["collecting"]["artifact"]["count"],
            "word_count": w["word_count"],
            "n_claim_sents": len(sents), "n_marked": n_marked, "n_marked_valid": n_valid,
            "n_marked_after_strip": n_marked_after,
            "ans_sentence_present": bool(ans_sents), "ans_sentence_cited": ans_cited,
            "ans_cited_source_contains_gold": ans_supported,
        })
    with open(os.path.join(D, "labels_match.jsonl"), "w", encoding="utf-8") as fo:
        for r in out:
            fo.write(json.dumps(r, ensure_ascii=False) + "\n")
    n = len(out)
    print(n, "briefs; correct_match", sum(r["correct_match"] for r in out),
          "gold_in_snippets", sum(r["gold_in_snippets"] for r in out))


if __name__ == "__main__":
    main()

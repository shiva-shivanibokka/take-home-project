"""Corrected labels (fix phase, 2026-10-04). No LLM calls: recomputed from committed outputs.

Writes runs/$EVAL_RUN/labels_v2.jsonl with, per question:
  correct_v1   - the original deterministic matcher (grade_match.contains), kept for comparison
  correct_v2   - improved matcher (below)
  correct_adj  - adjudicated label where one exists in adjudication/adjudicated_labels.csv
                 (ADJUDICATED BY CLAUDE (an LLM), NOT BY A HUMAN), else correct_v2
  gold_in_question - question dropped: its primary gold answer appears in the question text
  leak_answer  - an answer-revealing leak: a selected source is a benchmark mirror
                 (huggingface.co) or contains the question verbatim (questions of >= 12 words),
                 AND that source's snippet contains the gold answer (v1 matcher)
  leak_exposure - a mirror / verbatim-question source was selected (answer shown or not)

Matcher v2 = v1 plus:
  * number words <-> digits ("eight" == "8"), on both sides;
  * person names: an optional single-letter middle initial between tokens ("Talbot H. Waterman");
  * doubled-letter spelling tolerance for alphabetic tokens of >= 5 letters ("Moussa" ~ "Mousa");
    (round 2: narrowed from any 1-edit, which matched Hansen/Hanson)
  * multi-part golds ("A and B", "A, B & C") match order-free when every part matches;
  * extra aliases (never the primary gold) that share a >= 4-letter content word with the
    question are dropped
    (e.g. "Kingdom of Hanover" for "What is Hanover the capital of?");
  * positional check: the match must occur in the title, the Summary section, or a bold
    Key-Findings headline - a gold mentioned only in passing in the body does not count;
  * documented gold typo fixes (GOLD_FIX).
The positional rule and the 12-word verbatim threshold were chosen after reading the
adversarial review's examples (f039, q056/q080; q068 is a non-benchmark page that repeats
a 10-word question) - they are post-hoc, see RESULTS.md.
"""
import csv, gzip, json, os, re, sys, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from grade_match import contains as contains_v1  # noqa: E402

RUN = os.environ.get("EVAL_RUN", "local")
D = os.path.join(HERE, "runs", RUN)
QFILE = os.path.join(HERE, os.environ.get("EVAL_QUESTIONS", "questions.json"))
ADJ = os.path.join(HERE, "adjudication", "adjudicated_labels.csv")
GOLD_FIX = {"q022": ["Georgia 25 - 25 Portugal", "25-25", "25 - 25", "25 all"]}  # dataset typo "Geogia"
MIRRORS = ("huggingface.co",)
VERBATIM_MIN_WORDS = 12

NUM = {w: str(i) for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen twenty".split())}
NUM.update({"thirty": "30", "forty": "40", "fifty": "50", "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90"})
STOP = set("what which who whom whose where when how many much the and for with from that this was were is are did does "
           "of in on at to by a an as its it his her their capital country city".split())


def toks(s):
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"(?<=\d),(?=\d{3})", "", s)
    return [NUM.get(t, t) for t in re.findall(r"[a-z0-9]+", s)]


def lev1(a, b):
    if a == b:
        return True
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        return sum(x != y for x, y in zip(a, b)) == 1
    if len(a) > len(b):
        a, b = b, a
    return any(b[:i] + b[i + 1:] == a for i in range(len(b)))


def doubled_letter_variant(a, b):
    """True if a and b differ only by one doubled letter (Moussa/Mousa, Phillips/Philips).
    Round-2 fix: a general 1-edit tolerance also matched distinct names (Hansen/Hanson)."""
    if abs(len(a) - len(b)) != 1:
        return False
    if len(a) < len(b):
        a, b = b, a
    return any(a[:i] + a[i + 1:] == b and ((i > 0 and a[i - 1] == a[i]) or (i + 1 < len(a) and a[i + 1] == a[i]))
               for i in range(len(a)))


def tok_eq(b, g, fuzzy=True):
    return b == g or (fuzzy and len(g) >= 5 and g.isalpha() and b.isalpha() and doubled_letter_variant(b, g))


def seq_match(T, G, fuzzy=True):
    """G occurs in T allowing one optional single-letter token between consecutive G tokens."""
    if not G:
        return False
    for i in range(len(T)):
        j, k = 0, i
        while j < len(G) and k < len(T):
            if tok_eq(T[k], G[j], fuzzy):
                j += 1; k += 1
            elif j > 0 and len(T[k]) == 1 and T[k].isalpha() and len(G) >= 2:
                k += 1  # middle initial
            else:
                break
        if j == len(G):
            return True
    return False


def parts(ans):
    p = [x for x in re.split(r"\s*(?:,|&|\band\b)\s*", ans) if toks(x)]
    return p if len(p) >= 2 else []


def match_v2_text(text, answers):
    T = toks(text)
    for a in answers:
        if seq_match(T, toks(a)):
            return True
        ps = parts(a)
        if ps and all(seq_match(T, toks(x)) for x in ps):
            return True
    return False


def answer_zone(md):
    """Title + Summary section + bold Key-Findings headlines."""
    z = []
    m = re.search(r"^#\s+(.+)$", md, re.M)
    if m:
        z.append(m.group(1))
    m = re.search(r"##\s*Summary\s*(.*?)(?=\n##\s|\Z)", md, re.S)
    if m:
        z.append(m.group(1))
    z += re.findall(r"\*\*([^*]+)\*\*", md)
    return "\n".join(z)


def clean_answers(qid, q):
    ans = GOLD_FIX.get(qid, q["answers"])
    qwords = {w for w in toks(q["question"]) if len(w) >= 4 and w not in STOP}
    kept = [ans[0]] + [a for a in ans[1:] if not (set(toks(a)) & qwords)]  # primary gold never dropped
    primary_in_q = bool(toks(ans[0])) and seq_match(toks(q["question"]), toks(ans[0]), fuzzy=False)
    return kept, primary_in_q


def n2(s):
    return " ".join(toks(s))


def main():
    qs = {q["id"]: q for q in json.load(open(QFILE, encoding="utf-8"))}
    adj = {}
    if os.path.exists(ADJ):
        for r in csv.DictReader(open(ADJ, encoding="utf-8")):
            if r["run"] == RUN:
                adj[r["qid"]] = r
    out = []
    for qid, q in qs.items():
        f = os.path.join(D, "db", f"{qid}_w0.json")
        if not os.path.exists(f):
            continue
        h = json.load(open(f, encoding="utf-8"))["handoffs"]
        md = h["writing"]["artifact"]["brief_markdown"]
        srcs = h["collecting"]["artifact"]["sources"]
        ans, giq = clean_answers(qid, q)
        v2 = bool(ans) and match_v2_text(answer_zone(md), ans)
        nq = n2(q["question"])
        exposed = [s for s in srcs if any(m in s.get("source", "") for m in MIRRORS)
                   or (len(nq.split()) >= VERBATIM_MIN_WORDS and nq[:60] in n2(s["title"] + " " + s.get("snippet", "")))]
        r = {
            "qid": qid, "stratum": q["stratum"],
            "correct_v1": contains_v1(md, q["answers"]),
            "correct_v2": v2,
            "correct_adj": (adj[qid]["adjudicated_correct"] == "1") if qid in adj else v2,
            "adjudicated": qid in adj,
            # sensitivity: every remaining LOW-confidence adjudication flipped
            "correct_adj_lowflip": ((adj[qid]["adjudicated_correct"] == "1") != (adj[qid]["confidence"] == "low")) if qid in adj else v2,
            "gold_in_question": giq, "answers_used_v2": ans,
            "leak_answer": any(contains_v1(s.get("snippet", ""), q["answers"]) for s in exposed),
            "leak_exposure": bool(exposed),
            "gold_in_snippets_v2": any(match_v2_text(s.get("snippet", ""), ans or q["answers"]) for s in srcs),
        }
        out.append(r)
    with open(os.path.join(D, "labels_v2.jsonl"), "w", encoding="utf-8") as fo:
        for r in out:
            fo.write(json.dumps(r, ensure_ascii=False) + "\n")
    s = lambda k: sum(bool(r[k]) for r in out)
    print(RUN, len(out), "v1", s("correct_v1"), "v2", s("correct_v2"), "adj", s("correct_adj"),
          "adjudicated", s("adjudicated"), "gold_in_q", s("gold_in_question"),
          "leak_answer", s("leak_answer"), [r["qid"] for r in out if r["leak_answer"]], "exposure", s("leak_exposure"))


if __name__ == "__main__":
    main()

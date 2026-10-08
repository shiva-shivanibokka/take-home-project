"""Writes adjudication/adjudicated_labels.csv from the decisions below.
ADJUDICATED BY CLAUDE (AN LLM), NOT BY A HUMAN. Each decision was made by reading the
published brief (runs/<run>/db/<qid>_w0.json) on 2026-10-04. Rule: correct (1) only if the
brief commits to an answer equivalent to the gold; hedged / contradicted / passing mentions = 0.
confidence: high = unambiguous; low = judgment call (hedging, partial lists, numeric ranges)."""
import csv, json, os
HERE = os.path.dirname(os.path.abspath(__file__)); E = os.path.dirname(HERE)
F = {  # FRAMES: all 60
 "f001": (0,"high","revised after round-2 review (2026-10-04): Key Findings also answer 'east' twice - conflicting answers"),
 "f002": (0,"low","names She's All That only as 'reminiscent of'; never commits to it as the answer"),
 "f003": (0,"high","no series named"), "f004": (0,"high","answers 18th century; gold 19th"),
 "f005": (0,"high","never names Wausau"), "f006": (1,"high","Saving Private Ryan (long-form gold)"),
 "f007": (0,"high","discusses Federer; no Kratochvil"),
 "f008": (0,"high","'Illinois' appears only as 'the dataset includes the answer', not asserted (leaked item)"),
 "f009": (1,"high","1946 (leaked item)"), "f010": (0,"high","no host cities named"),
 "f011": (0,"high","revised after round-2 review (2026-10-04): claims 4 cast members incl. Phoebe/Kudrow vs gold 3"),
 "f012": (1,"high","Gladys Knight born in Atlanta"), "f013": (0,"high","68 vs 37 KOs (=31); gold 15"),
 "f014": (0,"high","39 years; gold 117"), "f015": (0,"high","says impossible to compute"),
 "f016": (0,"high","answers Panic Room; gold Fight Club"), "f017": (1,"high","total equals Budelli's 1 resident"),
 "f018": (0,"high","answers 1917"), "f019": (0,"high","assumed numbers, 5.0000005"),
 "f020": (1,"high","$183 million (leaked item)"), "f021": (0,"high","no answer"),
 "f022": (0,"high","uses 10 Downing Street; no yes/no conclusion"), "f023": (0,"high","says Truman, 61; gold 70 (Hoover)"),
 "f024": (0,"high","multiplies 5*6*5; never 55"),
 "f025": (0,"high","restates the options; dates all before the events (also gold-in-question)"),
 "f026": (0,"high","says NFL team unknown"), "f027": (0,"high","answers 3 letters; gold 2"),
 "f028": (0,"high","nickname not given"), "f029": (0,"high","omits Texas Rangers, says Blue Jays not applicable"),
 "f030": (0,"high","painting not named"), "f031": (0,"high","no answer"), "f032": (0,"high","no answer"),
 "f033": (1,"high","binomial nomenclature (leaked item)"), "f034": (0,"high","'nearly 10 years'; gold 11"),
 "f035": (0,"high","no Crab Nebula"), "f036": (0,"high","answers Simone Katie"), "f037": (0,"high","no title"),
 "f038": (0,"high","says Obama was NOT in office when Chile won"),
 "f039": (0,"high","Naples only as a city near Vesuvius; never as the session venue"),
 "f040": (0,"high","wrong actress (Claire Danes)"), "f041": (0,"high","no answer"), "f042": (0,"high","says no championships"),
 "f043": (1,"high","Celtics scored 148 in 1985 Finals"), "f044": (0,"high","names Kawakatsu"), "f045": (0,"high","no names"),
 "f046": (0,"high","no city named"), "f047": (0,"high","no episode"), "f048": (1,"high","both Italian (leaked item)"),
 "f049": (1,"high","King William IV (leaked item)"), "f050": (0,"high","Muhammad Ali 1996; gold Rafer Johnson 1984"),
 "f051": (1,"high","around 29 years old"), "f052": (1,"high","Genie in a Bottle (leaked item)"),
 "f053": (0,"high","no yes/no answer (leaked item)"), "f054": (1,"high","swine flu (leaked item)"),
 "f055": (0,"high","says order cannot be determined"), "f056": (0,"high","answers Haunted Mansion"),
 "f057": (0,"high","no answer"), "f058": (0,"high","says three died after 1980; gold 1"),
 "f059": (0,"high","says 'significantly lower' than 56"), "f060": (0,"high","no age"),
}
L = {  # SQA/PopQA: disputed items only (v1 vs v2 vs qwen grader, or flagged by the review)
 "q003": (1,"low","reports Spotify lists 37 songs; summary says count is consistent"),
 "q010": (1,"high","'eight minutes' = 8"), "q016": (1,"high","Pacific Coast intercollegiate (leaked item)"),
 "q020": (1,"high","executive-in-charge of production"), "q021": (1,"high","Amr Moussa (spelling variant)"),
 "q022": (0,"high","says sources lack the score (gold has typo 'Geogia')"), "q024": (0,"high","revised after round-2 review (2026-10-04): only 'may also contain a chicken'; concludes contents unsolved"),
 "q028": (1,"high","Talbot H. Waterman"), "q030": (0,"low","gives a range 128-2,048 KB, not 2048"),
 "q036": (1,"high","Economics and Mathematical Sciences"), "q040": (1,"high","Vale of Kashmir"),
 "q043": (0,"high","keywords given are semantic maps, challenges, new avenues, methods"),
 "q048": (1,"high","49-year marriage"), "q050": (1,"high","1827"), "q051": (1,"high","Lower Saxony"),
 "q056": (0,"high","claims David Koepp was sole screenwriter; Lindelof only as creator"),
 "q057": (1,"high","Ghana - but gold is in the question: item dropped"), "q061": (0,"high","says capital is Bontoc"),
 "q065": (0,"high","revised after round-2 review (2026-10-04): concludes the director is a matter of controversy / unclear"), "q067": (1,"high","Nouakchott"),
 "q072": (0,"low","never states a capital - and gold is in the question: item dropped"), "q080": (0,"high","Bern only for a different Manon; no commitment"),
 "q081": (1,"high","Herentals"), "q083": (0,"high","revised after round-2 review (2026-10-04): Antwerp given only with an 'accuracy uncertain' caveat (leaked item)"), "q091": (0,"high","names other directors"),
 "q098": (0,"high","Joseph Kane named as director, producer unknown"),
}
rows = []
for run, qf, dec in [("frames", "questions_frames.json", F), ("local", "questions.json", L)]:
    Q = {q["id"]: q for q in json.load(open(os.path.join(E, qf), encoding="utf-8"))}
    for qid, (c, conf, why) in dec.items():
        rows.append({"run": run, "qid": qid, "question": Q[qid]["question"], "gold": Q[qid]["answers"][0],
                     "adjudicated_correct": c, "confidence": conf, "reason": why,
                     "adjudicator": "Claude (LLM) - NOT human"})
with open(os.path.join(HERE, "adjudicated_labels.csv"), "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
print(len(rows), "rows")

"""python eval_sop/tests/test_grade_match.py  - checks the deterministic answer matcher."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from grade_match import contains, claim_sentences, STRIP_RE

assert contains("It was certified on 12 February 2020 by the RIAA.", ["February 12, 2020"])
assert contains("born in Statesville, North Carolina", ["Statesville"])
assert contains("España is the country", ["Espana"]) and contains("Espana", ["España"])
assert contains("a total of 2,048 kilobytes", ["2048"])
assert not contains("the policy of the state", ["pol"]), "word-boundary match required"
assert not contains("in 2019", ["2020"])
assert STRIP_RE.sub("", "Claim one [1]. Claim two [2, 3].") == "Claim one. Claim two."
s = claim_sentences("# T\n## Summary\nFirst real claim here [1]. Second real claim here [2].\n* **Bold title**: Third claim sentence here.")
assert s == ["First real claim here [1].", "Second real claim here [2].", "Third claim sentence here."], s
print("grade_match tests: all passed")

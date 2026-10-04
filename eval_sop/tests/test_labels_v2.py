"""python eval_sop/tests/test_labels_v2.py - matcher v2 behaviours requested by the review."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from labels_v2 import match_v2_text, answer_zone, clean_answers
assert match_v2_text("reach 6,000 feet in approximately eight minutes", ["8"])            # number words
assert match_v2_text("awarded to Talbot H. Waterman in 2008", ["Talbot Waterman"])        # middle initial
assert match_v2_text("sponsored by Amr Moussa", ["Amr Mousa"])                             # 1-edit spelling
assert match_v2_text("degrees in Economics and in Mathematical Sciences", ["Mathematical Sciences and Economics"])  # order-free
assert not match_v2_text("degrees in Economics only", ["Mathematical Sciences and Economics"])
assert not match_v2_text("in 2019", ["2020"]) and not match_v2_text("the policy", ["pol"])
md = "# Pompeii\n## Summary\nPompeii was destroyed in 79 AD.\n## Key Findings\n* **Vesuvius** It threatens Naples."
assert not match_v2_text(answer_zone(md), ["Naples"])                                      # passing mention
assert match_v2_text(answer_zone("# T\n## Summary\nThe session was held in Naples.\n## X\n"), ["Naples"])
ans, giq = clean_answers("qx", {"question": "What is the capital of County Dublin?", "answers": ["Dublin", "City of Dublin"]})
assert giq                                                                                  # gold in question
ans, giq = clean_answers("qy", {"question": "What is Hanover the capital of?", "answers": ["Lower Saxony", "Kingdom of Hanover"]})
assert not giq and ans == ["Lower Saxony"]                                                  # alias in question dropped
print("labels_v2 tests: all passed")

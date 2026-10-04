"""python eval_sop/tests/test_labels_v2_fuzzy.py - the 1-edit spelling tolerance must not create
false positives between distinct names (round-2 review)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from labels_v2 import match_v2_text
assert match_v2_text("sponsored by Amr Moussa", ["Amr Mousa"]), "doubled-letter variant must still match"
fails = []
for text, gold in [("Peter Hanson", "Peter Hansen"), ("born in Jansen", "Janson"), ("Mr Morris", "Morrie"),
                   ("the Lakers", "Bakers"), ("Waukesha", "Wausau"), ("Smithe", "Smythe")]:
    if match_v2_text(text, [gold]):
        fails.append((text, gold))
assert not fails, f"false positives: {fails}"
print("labels_v2 fuzzy tests: all passed")

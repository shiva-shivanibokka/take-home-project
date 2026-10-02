"""Step 1: web search (DuckDuckGo via `ddgs`) as a free stand-in for Tavily.
Cached by sha1(query)[:16] so the Collector stage (via harness fetch intercept)
reads exactly these results. Re-running overwrites nothing that already exists."""
import json, hashlib, os, time, datetime
from ddgs import DDGS
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "search"); os.makedirs(OUT, exist_ok=True)
topics = [{"id": q["id"], "topic": q["question"]} for q in json.load(open(os.path.join(HERE, "questions.json"), encoding="utf-8"))]
for t in topics:
    key = hashlib.sha1(t["topic"].encode()).hexdigest()[:16]
    f = os.path.join(OUT, key + ".json")
    if os.path.exists(f): continue
    for attempt in range(4):
        try:
            res = DDGS().text(t["topic"], max_results=10); break
        except Exception as e:
            print("retry", t["id"], e); time.sleep(5 * (attempt + 1)); res = []
    json.dump({"query": t["topic"], "id": t["id"], "retrieved_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
               "engine": "ddgs.text", "results": res}, open(f, "w", encoding="utf-8"), indent=1)
    print(t["id"], len(res)); time.sleep(1.5)

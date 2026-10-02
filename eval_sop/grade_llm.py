"""Robustness labels from LLM graders (these are LLM-CREATED labels, not human labels).
SimpleQA-style 3-way grade of each published brief against the gold answer, using
local Ollama (default, native /api/chat, seed 0, temperature 0) or, with --base groq,
Groq free-tier models (key loaded in-process from the original repo's .env; never printed).
  EVAL_RUN=local python eval_sop/grade_llm.py --model qwen2.5:7b      (local; different family from llama writer/reviewer)

  python eval_sop/grade_llm.py --model qwen/qwen3.8-27b      (used: different family from writer/reviewer)
  python eval_sop/grade_llm.py --model openai/gpt-oss-120b   (only if quota remains; it is also the Writer)
Output: data/labels_llm_<model>.jsonl (raw responses kept)."""
import argparse, json, os, re, time, requests

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(HERE, "runs", os.environ.get("EVAL_RUN", "local"))  # see run_pipeline.mjs
QFILE = os.path.join(HERE, os.environ.get("EVAL_QUESTIONS", "questions.json"))
ENV = r"<REPOS>/take-home-project/.env"

PROMPT = """You are grading whether a research brief correctly answers a factual question.

Question: {q}
Gold target answer: {gold}

Brief:
<<<
{brief}
>>>

Grade the brief:
- CORRECT: the brief explicitly gives an answer to the question that is semantically equivalent to the gold target (different formatting, aliases or extra correct detail are fine) and does not also assert a conflicting answer.
- INCORRECT: the brief gives an answer that differs from or contradicts the gold target, or hedges between several answers.
- NOT_ATTEMPTED: the brief never gives a specific answer to the question.
Respond with JSON only: {{"grade": "CORRECT" | "INCORRECT" | "NOT_ATTEMPTED", "answer_in_brief": "<the brief's answer, or empty>"}}"""


def key():
    for l in open(ENV, encoding="utf-8"):
        if l.startswith("OLLAMA_API_KEY="):
            return l.split("=", 1)[1].split(" #")[0].strip().strip('"')


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--model", required=True)
    ap.add_argument("--base", default="ollama", choices=["ollama", "groq"]); a = ap.parse_args()
    out = os.path.join(D, f"labels_llm_{a.model.split('/')[-1]}.jsonl")
    done = {json.loads(l)["qid"] for l in open(out, encoding="utf-8")} if os.path.exists(out) else set()
    qs = {q["id"]: q for q in json.load(open(QFILE, encoding="utf-8"))}
    H = {"Authorization": "Bearer " + key()} if a.base == "groq" else {}
    for qid, q in qs.items():
        f = os.path.join(D, "db", f"{qid}_w0.json")
        if qid in done or not os.path.exists(f):
            continue
        doc = json.load(open(f, encoding="utf-8"))
        if "writing" not in doc["handoffs"]:
            continue
        brief = doc["handoffs"]["writing"]["artifact"]["brief_markdown"]
        prompt = PROMPT.format(q=q["question"], gold=" | ".join(q["answers"][:5]), brief=brief)
        if a.base == "ollama":
            r = requests.post("http://127.0.0.1:11434/api/chat", timeout=None, json={
                "model": a.model, "stream": False, "keep_alive": "30m",
                "messages": [{"role": "user", "content": prompt}],
                "options": {"temperature": 0, "seed": 0, "num_ctx": 8192, "num_predict": 200}})
            r.raise_for_status(); j = r.json(); txt = j["message"]["content"] or ""
            m = re.search(r'"grade"\s*:\s*"(CORRECT|INCORRECT|NOT_ATTEMPTED)"', txt)
            rec = {"qid": qid, "model": a.model, "base": "ollama", "grade": m.group(1) if m else "PARSE_FAIL", "raw": txt,
                   "usage": {"prompt_tokens": j.get("prompt_eval_count"), "completion_tokens": j.get("eval_count")}}
            open(out, "a", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(qid, rec["grade"]); continue
        body = {"model": a.model, "temperature": 0, "seed": 0, "max_tokens": 400,  # qwen3.8 free tier caps output at 1000 tokens/min
                "reasoning_effort": "low" if "gpt-oss" in a.model else "none",
                "messages": [{"role": "user", "content": PROMPT.format(q=q["question"], gold=" | ".join(q["answers"][:5]), brief=brief)}]}
        for attempt in range(8):
            r = requests.post("https://api.groq.com/openai/v1/chat/completions", headers=H, json=body, timeout=120)
            if r.status_code == 429:
                msg = r.text[:300]
                if "per day" in msg or "TPD" in msg or "RPD" in msg:
                    print("DAILY LIMIT reached:", msg); return
                time.sleep(float(r.headers.get("retry-after", 10)) + 1); continue
            break
        if not r.ok:
            print(qid, "HTTP", r.status_code, r.text[:200]); continue
        j = r.json(); txt = j["choices"][0]["message"]["content"] or ""
        m = re.search(r'"grade"\s*:\s*"(CORRECT|INCORRECT|NOT_ATTEMPTED)"', txt)
        rec = {"qid": qid, "model": a.model, "grade": m.group(1) if m else "PARSE_FAIL", "raw": txt,
               "usage": j.get("usage")}
        open(out, "a", encoding="utf-8").write(json.dumps(rec, ensure_ascii=False) + "\n")
        print(qid, rec["grade"], (j.get("usage") or {}).get("total_tokens"))
        time.sleep(3)


if __name__ == "__main__":
    main()

"""
score_prompt.py - Give a prompt a grade out of 1.0.

WHAT THIS DOES, in plain English:
  You give it (1) a prompt file and (2) a file of test cases. For each test
  case it fills your prompt in, sends it to Claude, and checks whether the
  answer that comes back says what the test case said it should say. At the
  end it prints a single score: the fraction of test cases that were fully
  correct.

HOW TO RUN IT:
  python scripts/score_prompt.py prompts/triage.md evals/triage.jsonl

WHAT THE TWO FILES LOOK LIKE:
  The prompt file is just text. Anywhere you want a test case's value to be
  dropped in, write the field name in double curly braces, like {{message}}.

  The eval file is "JSONL" - one JSON object per line, no commas between
  lines. Each line needs an "input" (what gets pasted into the prompt) and
  an "expected" (the fields the answer must contain):

    {"input": {"message": "we are down"}, "expected": {"urgency": "HIGH"}}
    {"input": {"message": "quick question"}, "expected": {"urgency": "LOW"}}

HOW THE CHECKING WORKS (this is the part that matters):
  - Only the fields listed in "expected" are checked. Claude can add all the
    friendly wording it likes around them; extra words are ignored.
  - Text is compared loosely: capital letters and spare spaces don't matter.
    "high", " HIGH " and "High" all count as the same answer.
  - Numbers are compared with a small tolerance (see NUMBER_TOLERANCE below),
    so 0.90 and 0.91 count as a match. Numbers rarely come back identical,
    and demanding an exact match would fail cases that are really fine.
  - A case only counts as correct if EVERY field in its "expected" matched.
    Partial credit within a case is deliberately not given.

WHAT HAPPENS WHEN THINGS GO WRONG:
  Every expected failure (no API key, wrong API key, missing file, bad line
  in the eval file, no internet) prints one plain sentence telling you what
  to fix, and stops. You should never see a wall of red Python error text.
  If a single test case fails for a one-off reason - a rate limit, say -
  that case is marked failed with the reason, and the rest still run.

IS IT SAFE TO RUN TWICE?
  Yes. It only reads your files and asks Claude questions - it never writes
  or changes anything. Note that Claude is not perfectly repeatable, so the
  same prompt can score slightly differently on two runs. That is the model
  being probabilistic, not this script being broken.
"""

import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Settings you might reasonably want to change
# ---------------------------------------------------------------------------

# Which Claude model does the grading run against.
MODEL = "claude-opus-5"

# How close two numbers have to be to count as the same answer.
NUMBER_TOLERANCE = 0.05

# Give up on a single request after this many seconds, rather than hanging.
REQUEST_TIMEOUT_SECONDS = 60.0

# Room for Claude's answer. Generous, because you are only billed for what
# actually comes back, not for the ceiling.
MAX_TOKENS = 16000


def quit_with_message(message):
    """Print one plain-English line and stop. No Python error text."""
    print("\n" + message + "\n")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Step 1: read the two files the user pointed us at
# ---------------------------------------------------------------------------

def read_prompt_file(path):
    """Return the text of the prompt file."""
    prompt_path = Path(path)
    if not prompt_path.is_file():
        quit_with_message(
            "I could not find a prompt file at: {}\n"
            "Nothing has been sent to Claude. Check the path, or create that "
            "file with your prompt in it, then run this again.".format(prompt_path)
        )
    text = prompt_path.read_text(encoding="utf-8").strip()
    if not text:
        quit_with_message(
            "The prompt file {} exists but is empty. Put your prompt text in "
            "it before scoring it.".format(prompt_path)
        )
    return text


def read_eval_file(path):
    """Return a list of test cases from a .jsonl file, one per line."""
    eval_path = Path(path)
    if not eval_path.is_file():
        quit_with_message(
            "I could not find an eval file at: {}\n"
            "This should be a .jsonl file with one test case per line.".format(eval_path)
        )

    cases = []
    for line_number, raw_line in enumerate(
        eval_path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        line = raw_line.strip()
        if not line:
            continue  # blank lines are fine, just skip them

        try:
            case = json.loads(line)
        except json.JSONDecodeError as problem:
            quit_with_message(
                "Line {} of {} is not valid JSON, so I stopped before calling "
                "Claude.\nThe problem: {}\nEach line must be a complete JSON "
                "object on a single line, with no comma at the end.".format(
                    line_number, eval_path, problem.msg
                )
            )

        # Every case needs both halves, or there is nothing to test or check.
        if not isinstance(case.get("input"), dict) or not isinstance(
            case.get("expected"), dict
        ):
            quit_with_message(
                "Line {} of {} is missing an \"input\" or an \"expected\" "
                "section (both must be objects in curly braces). Every test "
                "case needs something to send and something to check.".format(
                    line_number, eval_path
                )
            )

        case["_line"] = line_number
        cases.append(case)

    if not cases:
        quit_with_message(
            "{} has no test cases in it. Add at least one line before "
            "scoring.".format(eval_path)
        )
    return cases


# ---------------------------------------------------------------------------
# Step 2: fill the test case's values into the prompt
# ---------------------------------------------------------------------------

def fill_prompt(prompt_text, case_input):
    """Replace every {{field}} in the prompt with that field's value."""
    filled = prompt_text
    for field_name, value in case_input.items():
        filled = filled.replace("{{" + field_name + "}}", str(value))

    # If the prompt still has {{something}} left in it, the eval file and the
    # prompt disagree about field names. Worth saying out loud once.
    leftover = re.findall(r"\{\{(\w+)\}\}", filled)
    return filled, leftover


# ---------------------------------------------------------------------------
# Step 3: ask Claude
# ---------------------------------------------------------------------------

def build_client():
    """Load the API key from .env and hand back a ready-to-use Claude client."""
    try:
        import anthropic
        from dotenv import load_dotenv
    except ImportError as problem:
        quit_with_message(
            "A required package is not installed ({}).\n"
            "Fix it by running:  pip install anthropic python-dotenv".format(problem.name)
        )

    # The .env file lives at the top of this project, one folder up from
    # scripts/. load_dotenv reads it and puts the values into the environment.
    env_path = Path(__file__).resolve().parent.parent / ".env"
    load_dotenv(env_path)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        quit_with_message(
            "I could not find your Claude API key, so I did not try to call "
            "the API.\nTo fix it, open this file:\n  {}\nand add a line that "
            "looks exactly like this (no quotes, no spaces around the = sign):"
            "\n  ANTHROPIC_API_KEY=sk-ant-your-real-key-here\nThen run this "
            "script again. Never share or commit that key.".format(env_path)
        )

    # Catch an obviously broken key here rather than wasting a call on it.
    # This is worth doing because a half-pasted key and a revoked key both
    # come back from the API as the same unhelpful "invalid" error.
    if not api_key.startswith("sk-ant-"):
        quit_with_message(
            "The ANTHROPIC_API_KEY in {} does not start with 'sk-ant-', so it "
            "is not an Anthropic API key.\nYou may have pasted a key's name, "
            "an ID, or a key for a different service. Copy the real key from "
            "console.anthropic.com (API keys).".format(env_path)
        )

    if len(api_key) < 80:
        quit_with_message(
            "The ANTHROPIC_API_KEY in {} looks cut off - it is only {} "
            "characters long, and a real key is around 108.\nThis usually "
            "means only part of the key got copied. Go back to "
            "console.anthropic.com (API keys), copy the WHOLE key - it is "
            "long, so use the copy button rather than selecting it by hand - "
            "and paste it over the existing line. Nothing was sent to the "
            "API.".format(env_path, len(api_key))
        )

    return anthropic.Anthropic(
        api_key=api_key,
        timeout=REQUEST_TIMEOUT_SECONDS,  # never hang forever
        max_retries=2,                    # the SDK retries blips on its own
    )


def ask_claude(client, filled_prompt):
    """
    Send one filled-in prompt and return (answer_text, fatal_error, case_error).

    fatal_error means "stop the whole run, this will fail for every case".
    case_error means "this one case failed, keep going with the others".
    """
    import anthropic

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": filled_prompt}],
        )
    except anthropic.AuthenticationError:
        return None, (
            "Claude rejected your API key. The key in your .env file is wrong, "
            "expired, or was revoked.\nGet a fresh one from "
            "console.anthropic.com (API keys), paste it into .env as "
            "ANTHROPIC_API_KEY=..., and run this again."
        ), None
    except anthropic.PermissionDeniedError:
        return None, (
            "Your API key is valid but is not allowed to use the model '{}'. "
            "Check your workspace's model permissions, or change the MODEL "
            "setting near the top of this script.".format(MODEL)
        ), None
    except anthropic.NotFoundError:
        return None, (
            "Claude does not recognise the model name '{}'. Fix the MODEL "
            "setting near the top of this script.".format(MODEL)
        ), None
    except anthropic.APIConnectionError:
        return None, (
            "I could not reach Claude at all. Check your internet connection "
            "(and any VPN or company firewall), then run this again."
        ), None
    except anthropic.RateLimitError:
        return None, None, "rate limited by the API"
    except anthropic.APIStatusError as problem:
        return None, None, "API error {}".format(problem.status_code)

    # Claude's reply arrives as a list of blocks. We want only the text ones.
    return "\n".join(
        block.text for block in response.content if block.type == "text"
    ), None, None


# ---------------------------------------------------------------------------
# Step 4: pull the expected fields back out of Claude's answer
# ---------------------------------------------------------------------------

def find_field(answer_text, field_name):
    """
    Look for one field in Claude's answer and return what it said, or None.

    Handles the two shapes answers usually take: a JSON object, or plain
    lines like "Urgency: HIGH". Any wording around them is ignored.
    """
    # First try: is there a JSON object in the answer containing this field?
    match = re.search(r"\{.*\}", answer_text, re.DOTALL)
    if match:
        try:
            parsed = json.loads(match.group(0))
            if isinstance(parsed, dict):
                for key, value in parsed.items():
                    if normalise_key(key) == normalise_key(field_name):
                        return value
        except json.JSONDecodeError:
            pass  # not JSON after all; fall through to the line search

    # Second try: a line like "Urgency: HIGH" or "next_action - call them".
    pattern = re.compile(
        r"^\W*" + field_name.replace("_", r"[ _-]?") + r"\s*[:\-]\s*(.+)$",
        re.IGNORECASE | re.MULTILINE,
    )
    line_match = pattern.search(answer_text)
    if line_match:
        return line_match.group(1).strip().strip("*_`\"' ")

    return None  # the field simply is not in the answer


def normalise_key(text):
    """Make field names comparable: lowercase, no spaces, dashes or underscores."""
    return re.sub(r"[\s_\-]+", "", str(text)).lower()


# ---------------------------------------------------------------------------
# Step 5: compare what we got against what we expected
# ---------------------------------------------------------------------------

def values_match(expected, actual):
    """True if the answer counts as correct for this one field."""
    if actual is None:
        return False

    # Numbers: allow a small tolerance instead of demanding an exact match.
    if isinstance(expected, bool):
        return str(actual).strip().lower() in (
            ["true", "yes", "y"] if expected else ["false", "no", "n"]
        )

    if isinstance(expected, (int, float)):
        number_in_answer = re.search(r"-?\d+(?:\.\d+)?", str(actual))
        if not number_in_answer:
            return False
        return abs(float(number_in_answer.group(0)) - float(expected)) <= NUMBER_TOLERANCE

    # Lists and nested objects: compare their text form, loosely.
    if isinstance(expected, (list, dict)):
        return json.dumps(expected, sort_keys=True).lower() == json.dumps(
            actual, sort_keys=True
        ).lower() if isinstance(actual, (list, dict)) else False

    # Text: ignore capital letters and surrounding spaces.
    return str(expected).strip().lower() == str(actual).strip().lower()


def score_one_case(client, prompt_text, case):
    """Run a single test case. Returns (passed, list_of_problem_lines)."""
    filled_prompt, leftover = fill_prompt(prompt_text, case["input"])

    answer, fatal_error, case_error = ask_claude(client, filled_prompt)
    if fatal_error:
        quit_with_message(fatal_error)
    if case_error:
        return False, ["could not be scored: {}".format(case_error)]

    problems = []
    if leftover:
        problems.append(
            "warning: the prompt still has {{{{{}}}}} in it - your eval file "
            "does not supply that field".format("}}, {{".join(sorted(set(leftover))))
        )

    for field_name, expected_value in case["expected"].items():
        actual_value = find_field(answer, field_name)
        if not values_match(expected_value, actual_value):
            problems.append(
                "  {:<16} expected {!r:<24} got {}".format(
                    field_name,
                    expected_value,
                    "(nothing found)" if actual_value is None else repr(actual_value),
                )
            )

    # A case only passes if nothing at all went wrong with it.
    return (len(problems) == 0), problems


# ---------------------------------------------------------------------------
# Putting it together
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) != 3:
        quit_with_message(
            "This script needs exactly two things: a prompt file and an eval "
            "file.\nLike this:\n  python scripts/score_prompt.py "
            "prompts/triage.md evals/triage.jsonl"
        )

    prompt_path, eval_path = sys.argv[1], sys.argv[2]

    # Read both files BEFORE spending money on API calls, so a typo in a
    # filename costs you nothing.
    prompt_text = read_prompt_file(prompt_path)
    cases = read_eval_file(eval_path)
    client = build_client()

    print("\nScoring {} against {} case(s) using {}...".format(
        prompt_path, len(cases), MODEL
    ))

    failures = []
    passed_count = 0

    for position, case in enumerate(cases, start=1):
        passed, problems = score_one_case(client, prompt_text, case)
        if passed:
            passed_count += 1
            print("  case {}: pass".format(position))
        else:
            print("  case {}: FAIL".format(position))
            failures.append((position, case["_line"], problems))

    score = passed_count / len(cases)

    print("\n" + "=" * 60)
    print("SCORE:  {:.2f}   ({} of {} cases matched on every field)".format(
        score, passed_count, len(cases)
    ))
    print("Model:  {}".format(MODEL))
    print("Cases:  {}   from {}".format(len(cases), eval_path))
    print("Prompt: {}".format(prompt_path))
    print("=" * 60)

    if failures:
        print("\nWhat went wrong:")
        for position, line_number, problems in failures:
            print("\n  Case {} (line {} of the eval file):".format(position, line_number))
            for problem in problems:
                print("  " + problem)
    print()


if __name__ == "__main__":
    main()

import json
import os
import subprocess
from pathlib import Path

from openai import OpenAI

PROJECT_DIR = Path(".").resolve()
TASK_FILE = PROJECT_DIR / "TASK.md"
ARTIFACTS_DIR = PROJECT_DIR / "artifacts"
REPLIT_OUTPUT_FILE = ARTIFACTS_DIR / "replit_output.txt"
SCREENSHOT_NOTES_FILE = ARTIFACTS_DIR / "screenshot_notes.txt"
EXTRA_CONTEXT_FILE = ARTIFACTS_DIR / "extra_context.txt"
DECISION_FILE = ARTIFACTS_DIR / "controller_decision.json"
NEXT_PROMPT_FILE = ARTIFACTS_DIR / "next_prompt.txt"

MODEL = "gpt-5.4"

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])


def read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="ignore").strip()


def run_command(cmd: str) -> dict:
    try:
        result = subprocess.run(
            cmd,
            shell=True,
            cwd=PROJECT_DIR,
            capture_output=True,
            text=True,
            timeout=240,
        )
        return {
            "command": cmd,
            "returncode": result.returncode,
            "stdout": result.stdout[-12000:],
            "stderr": result.stderr[-12000:],
        }
    except subprocess.TimeoutExpired:
        return {
            "command": cmd,
            "returncode": 124,
            "stdout": "",
            "stderr": "Command timed out",
        }


def get_build_checks() -> list[dict]:
    checks = []

    if (PROJECT_DIR / "package.json").exists():
        checks.append(run_command("npm run build"))

        package_json = read_text(PROJECT_DIR / "package.json")
        if '"lint"' in package_json:
            checks.append(run_command("npm run lint"))

    return checks


def get_git_summary() -> str:
    parts = []
    for cmd, title in [
        ("git status --short", "git status --short"),
        ("git diff --name-only", "git diff --name-only"),
    ]:
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                cwd=PROJECT_DIR,
                capture_output=True,
                text=True,
                timeout=30,
            )
            parts.append(f"## {title}\n{result.stdout.strip() or '(no output)'}")
        except Exception as e:
            parts.append(f"## {title}\n(error: {e})")
    return "\n\n".join(parts)


def build_packet() -> dict:
    return {
        "task": read_text(TASK_FILE),
        "replit_output": read_text(REPLIT_OUTPUT_FILE),
        "screenshot_notes": read_text(SCREENSHOT_NOTES_FILE),
        "extra_context": read_text(EXTRA_CONTEXT_FILE),
        "git_summary": get_git_summary(),
        "checks": get_build_checks(),
    }


def ask_controller(packet: dict) -> dict:
    system = """
You are a strict engineering controller reviewing app/UI work done in Replit.

Your job is NOT to write code.
Your job is to decide whether the current work should be:
- accepted
- sent back to Replit with a better prompt
- or escalated to human review

Rules:
- Do not accept based on compilation alone.
- Evaluate against the task, UX acceptance criteria, runtime notes, and build outputs.
- If the work is technically functional but still strategically or visually wrong, do NOT accept it.
- If status is "revise_prompt", produce a strong next prompt for Replit.
- Return ONLY valid JSON.
"""

    user = f"""
Review this packet and return JSON with this exact shape:

{{
  "status": "accept" | "revise_prompt" | "needs_human",
  "summary": "short diagnosis",
  "passed_gates": ["..."],
  "failing_gates": ["..."],
  "changed_files_to_review": ["..."],
  "confidence": 0.0,
  "next_prompt": "only if status is revise_prompt, otherwise empty string"
}}

Packet:
{json.dumps(packet, indent=2)}
"""

    response = client.responses.create(
        model=MODEL,
        input=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    )

    text = response.output_text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {
            "status": "needs_human",
            "summary": "Controller did not return valid JSON.",
            "passed_gates": [],
            "failing_gates": ["invalid_controller_output"],
            "changed_files_to_review": [],
            "confidence": 0.0,
            "next_prompt": "",
            "raw_output": text,
        }


def main():
    ARTIFACTS_DIR.mkdir(parents=True, exist_ok=True)

    if not TASK_FILE.exists():
        print("Missing TASK.md at project root.")
        return

    packet = build_packet()
    decision = ask_controller(packet)

    DECISION_FILE.write_text(json.dumps(decision, indent=2), encoding="utf-8")

    if decision.get("next_prompt"):
        NEXT_PROMPT_FILE.write_text(decision["next_prompt"], encoding="utf-8")

    print("\n=== CONTROLLER DECISION ===")
    print(json.dumps(decision, indent=2))

    print("\nSaved:")
    print(f"- {DECISION_FILE}")
    if decision.get("next_prompt"):
        print(f"- {NEXT_PROMPT_FILE}")


if __name__ == "__main__":
    main()
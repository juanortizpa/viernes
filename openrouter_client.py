"""Cliente mínimo para OpenRouter (solo biblioteca estándar).

Uso como librería:
    from openrouter_client import chat
    print(chat("Hola"))

Uso por CLI:
    python openrouter_client.py "Hola" [-m openai/gpt-4o-mini]

Requiere la variable de entorno OPENROUTER_API_KEY.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = "https://openrouter.ai/api/v1/chat/completions"
DEFAULT_MODEL = "openai/gpt-4o-mini"


def chat(prompt, model=DEFAULT_MODEL, system=None, max_tokens=None, timeout=60):
    """Envía un prompt y devuelve el texto de la respuesta."""
    key = os.environ.get("OPENROUTER_API_KEY")
    if not key:
        raise RuntimeError("Falta la variable de entorno OPENROUTER_API_KEY")

    messages = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    body = {"model": model, "messages": messages}
    if max_tokens:
        body["max_tokens"] = max_tokens

    req = urllib.request.Request(
        API_URL,
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"OpenRouter HTTP {e.code}: {e.read().decode(errors='replace')}") from None
    return data["choices"][0]["message"]["content"]


def main():
    p = argparse.ArgumentParser(description="Cliente simple de OpenRouter")
    p.add_argument("prompt")
    p.add_argument("-m", "--model", default=DEFAULT_MODEL)
    p.add_argument("-s", "--system")
    p.add_argument("--max-tokens", type=int)
    a = p.parse_args()
    try:
        print(chat(a.prompt, a.model, a.system, a.max_tokens))
    except RuntimeError as e:
        sys.exit(str(e))


if __name__ == "__main__":
    main()

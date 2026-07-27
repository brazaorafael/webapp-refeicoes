#!/usr/bin/env python3
"""
Registra um 👍/👎 vindo do app (via GitHub 'repository_dispatch').

O app envia um payload como:
{
  "voto": "like" | "dislike",
  "receita": { "id": "...", "titulo": "...", "tags": [...], ...objeto completo... }
}

Este script:
  - atualiza data/perfil_gostos.json (contadores por tag + resumo aprendido);
  - se 'like', adiciona a receita à data/lista_final.json (dedup);
  - se 'dislike', remove da lista final (se estiver lá) e bloqueia futuras sugestões.

O payload chega na variável de ambiente PAYLOAD (JSON como string).
"""

import os
import json
import datetime

DATA_DIR = "data"
FILE_PERFIL = os.path.join(DATA_DIR, "perfil_gostos.json")
FILE_LISTA = os.path.join(DATA_DIR, "lista_final.json")

HOJE = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3))).strftime("%d/%m/%Y")


def carregar(caminho, padrao):
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return padrao


def salvar(caminho, obj):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def montar_resumo(contadores):
    """Transforma os contadores de tags num texto curto e explicável."""
    positivos = sorted([(v, k) for k, v in contadores.items() if v > 0], reverse=True)
    negativos = sorted([(v, k) for k, v in contadores.items() if v < 0])
    curtem = ", ".join(k.replace("_", " ") for _, k in positivos[:6])
    evitam = ", ".join(k.replace("_", " ") for _, k in negativos[:6])
    partes = []
    if curtem:
        partes.append(f"curtem: {curtem}")
    if evitam:
        partes.append(f"evitam: {evitam}")
    return "; ".join(partes)


def main():
    payload_raw = os.environ.get("PAYLOAD", "").strip()
    if not payload_raw:
        print("Sem payload; nada a fazer.")
        return 0
    payload = json.loads(payload_raw)
    voto = (payload.get("voto") or "").lower()
    receita = payload.get("receita") or {}
    rid = receita.get("id")
    titulo = receita.get("titulo", "")
    tags = receita.get("tags", [])
    if not rid or voto not in ("like", "dislike"):
        print("Payload incompleto; ignorando.")
        return 0

    # ---- perfil de gostos ----
    perfil = carregar(FILE_PERFIL, {})
    perfil.setdefault("curtidas", [])
    perfil.setdefault("rejeitadas", [])
    perfil.setdefault("contadores", {})

    registro = {"id": rid, "titulo": titulo, "tags": tags, "data": HOJE}
    peso = 1 if voto == "like" else -1
    alvo = "curtidas" if voto == "like" else "rejeitadas"
    oposto = "rejeitadas" if voto == "like" else "curtidas"

    perfil[oposto] = [x for x in perfil[oposto] if x.get("id") != rid]
    if not any(x.get("id") == rid for x in perfil[alvo]):
        perfil[alvo].append(registro)

    for t in tags:
        perfil["contadores"][t] = perfil["contadores"].get(t, 0) + peso

    perfil["resumo"] = montar_resumo(perfil["contadores"])
    salvar(FILE_PERFIL, perfil)

    # ---- lista final ----
    lista = carregar(FILE_LISTA, {"itens": []})
    lista.setdefault("itens", [])
    lista["itens"] = [x for x in lista["itens"] if x.get("id") != rid]
    if voto == "like":
        lista["itens"].append(receita)
    salvar(FILE_LISTA, lista)

    print(f"Registrado {voto} para '{titulo}'. Resumo: {perfil['resumo']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
Agente de Refeições (Gemini + Google Search) — versão WebApp (pratos à la carte).

Gera receitas em JSON estruturado que servem para o e-mail E para o WebApp.
Agora cada PRATO é uma unidade independente (like por prato):
  - por dia: 2 a 3 pratos PRINCIPAIS + 1 ENTRADA + 1 SOBREMESA
  - o casal pode curtir o principal de um e a sobremesa de outro, à vontade.

Modos:
  - AGENT_MODE=semanal  -> cardápio da próxima semana (domingo 19h30)
  - AGENT_MODE=diario   -> receitas do dia (todo dia 08h)

Aprendizado e anti-repetição:
  - lê data/perfil_gostos.json e data/historico.json
  - injeta preferências e bloqueios na curadoria
  - grava data/receitas_do_dia.json e atualiza data/historico.json

Secrets/variáveis:
  GEMINI_API_KEY, GMAIL_ADDRESS, GMAIL_APP_PASSWORD,
  MAIL_TO (opcional), GEMINI_MODEL (opcional), AGENT_MODE (opcional), APP_URL (opcional)
"""

import os
import re
import sys
import ssl
import json
import html
import smtplib
import hashlib
import datetime
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr

from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Configuração
# ---------------------------------------------------------------------------
MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
MODE = (os.environ.get("AGENT_MODE") or "diario").strip().lower()
APP_URL = os.environ.get("APP_URL", "").strip()

GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
GMAIL_ADDRESS = os.environ["GMAIL_ADDRESS"]
GMAIL_APP_PASSWORD = os.environ["GMAIL_APP_PASSWORD"]

DEFAULT_RECIPIENTS = "brazaorafael@gmail.com"
_raw_to = os.environ.get("MAIL_TO") or DEFAULT_RECIPIENTS
RECIPIENTS = [e.strip() for e in _raw_to.replace(";", ",").split(",") if e.strip()]

DATA_DIR = "data"
FILE_DIA = os.path.join(DATA_DIR, "receitas_do_dia.json")
FILE_HIST = os.path.join(DATA_DIR, "historico.json")
FILE_PERFIL = os.path.join(DATA_DIR, "perfil_gostos.json")

HOJE = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=-3)))
DATA_STR = HOJE.strftime("%d/%m/%Y")
DIAS_SEMANA = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"]
DIA_SEMANA = DIAS_SEMANA[HOJE.weekday()]

_prox_segunda = HOJE + datetime.timedelta(days=(7 - HOJE.weekday()))
_prox_domingo = _prox_segunda + datetime.timedelta(days=6)
PERIODO_SEMANA = f"{_prox_segunda.strftime('%d/%m')} a {_prox_domingo.strftime('%d/%m/%Y')}"

SITES = [
    "https://panelinha.com.br",
    "https://panelinha.com.br/home/cozinha-pratica",
    "https://receitas.globo.com/ana-maria-braga/",
]

# ---------------------------------------------------------------------------
# Perfil, dieta e critérios
# ---------------------------------------------------------------------------
PERFIL = f"""PERFIL DE QUEM VAI COMER:
- Casal jovem (Ana e Rafael), jantar para 2 pessoas.
- Quando fizer sentido, porções que rendam SOBRA para o almoço de 1 pessoa no dia seguinte.
- Prioridade ALTA em proteína, com equilíbrio entre carboidrato, legumes/verduras e demais macros.
- Receitas, na maioria, FÁCEIS e PRÁTICAS (poucos ingredientes acessíveis no Brasil, preparo rápido).

FONTES PRIORITÁRIAS (use a busca do Google agora, priorizando estes sites):
{chr(10).join('- ' + s for s in SITES)}
Não copie textos; escreva as receitas com suas próprias palavras."""

DIETA = """REGRAS DE DIETA (OBRIGATÓRIAS):
- POUCA FRITURA: evite fritar em óleo. Prefira AIRFRYER, forno, grelha ou refogado.
- CARNE VERMELHA é a preferida do casal: use com boa frequência.
- PEIXE é pouco apreciado: NO MÁXIMO 1 prato de peixe por semana.
- Boas fontes de proteína nos pratos principais."""

CRITERIOS = """CRITÉRIOS DE APROVAÇÃO (reprove o que não atende bem):
1. PRATICIDADE: preparo simples, sem técnicas difíceis, até ~45 min.
2. INGREDIENTES: acessíveis em supermercado brasileiro; poucos itens.
3. PROTEÍNA: boa fonte de proteína no prato principal.
4. EQUILÍBRIO: proteína + carboidrato + legumes/verduras.
5. SABOR/QUALIDADE: receita reconhecida/bem avaliada, nada experimental."""

TAGS_INFO = """Use tags curtas e padronizadas (minúsculas, sem acento):
carne_vermelha, frango, porco, ovos, vegetariano, peixe, massa, salada, sopa, grelhado,
airfryer, forno, rapido, low_carb. Liste 2 a 3 tags por prato."""

# Como cada PRATO deve vir (preparo um pouco mais detalhado, mas claro)
ESQUEMA_PRATO = """Cada PRATO é um objeto independente:
{
  "nome": "Nome do prato",
  "curso": "principal" | "entrada" | "sobremesa",
  "porque": "1 frase de por que encaixa no perfil",
  "tags": ["carne_vermelha","grelhado"],
  "rende_sobra": true,
  "ingredientes": ["2 bifes de alcatra (~180g cada)", "2 batatas médias", "..."],
  "preparo": ["Passo 1 claro...", "Passo 2...", "Passo 3...", "Passo 4..."]
}
REGRAS DO PRATO:
- ingredientes com quantidade aproximada quando possível.
- preparo com 4 a 6 passos, curtos e claros (nem uma linha só, nem um textão)."""


# ---------------------------------------------------------------------------
# Arquivos
# ---------------------------------------------------------------------------
def carregar_json(caminho, padrao):
    try:
        with open(caminho, "r", encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return padrao


def salvar_json(caminho, obj):
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def gerar_id(nome):
    base = re.sub(r"[^a-z0-9]+", "-", nome.lower()).strip("-")
    h = hashlib.sha1(nome.encode("utf-8")).hexdigest()[:6]
    return f"{base[:40]}-{h}"


# ---------------------------------------------------------------------------
# Preferências aprendidas
# ---------------------------------------------------------------------------
def montar_contexto_preferencias():
    perfil = carregar_json(FILE_PERFIL, {})
    historico = carregar_json(FILE_HIST, [])
    resumo = perfil.get("resumo", "").strip()
    rejeitadas = [r.get("titulo", "") for r in perfil.get("rejeitadas", []) if r.get("titulo")]
    ja = [h.get("titulo", "") for h in historico][-80:]
    partes = []
    if resumo:
        partes.append(f"PREFERÊNCIAS APRENDIDAS DO CASAL: {resumo}")
    if rejeitadas:
        partes.append("NUNCA sugerir estes pratos (foram rejeitados): " + "; ".join(rejeitadas[:50]))
    if ja:
        partes.append("EVITE repetir pratos já sugeridos recentemente: " + "; ".join(ja))
    return "\n".join(partes) if partes else "Ainda não há preferências registradas."


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------
def prompt_candidatos(tema, quantidade):
    return f"""Você é um pesquisador de receitas. Hoje é {DIA_SEMANA}, {DATA_STR}.

TAREFA: {tema}
Gere uma LISTA AMPLA de candidatos ({quantidade}) para depois passarem por curadoria.
Inclua pratos PRINCIPAIS, ENTRADAS e SOBREMESAS.

{PERFIL}

{DIETA}

Para cada candidato, escreva em texto simples (sem JSON, sem HTML):
- Nome e se é principal, entrada ou sobremesa
- Por que é prático e encaixa no perfil
- Ingredientes principais
- Fonte/site de inspiração"""


def prompt_curador_diario(candidatos):
    return f"""Você é um CURADOR de cardápio criterioso. Hoje é {DIA_SEMANA}, {DATA_STR}.

Selecione os melhores pratos para hoje: de 2 a 3 PRINCIPAIS, 1 ENTRADA e 1 SOBREMESA.

{CRITERIOS}

{DIETA}

{montar_contexto_preferencias()}

{TAGS_INFO}

CANDIDATOS:
{candidatos}

RESPONDA APENAS COM JSON VÁLIDO (sem crases, sem texto fora do JSON):
{{
  "tipo": "diario",
  "data": "{DATA_STR}",
  "dia_semana": "{DIA_SEMANA}",
  "pratos": [ PRATO, PRATO, PRATO, PRATO ]
}}
Inclua de 2 a 3 pratos com curso "principal", exatamente 1 "entrada" e 1 "sobremesa".

{ESQUEMA_PRATO}"""


def prompt_curador_semanal(candidatos):
    return f"""Você é um CURADOR de cardápio criterioso. Hoje é {DIA_SEMANA}, {DATA_STR}.

Monte o cardápio da PRÓXIMA semana ({PERIODO_SEMANA}), de segunda a domingo.
Para CADA dia: 2 a 3 pratos PRINCIPAIS + 1 ENTRADA + 1 SOBREMESA.

{CRITERIOS}

{DIETA}
- Lembre: no MÁXIMO 1 prato de peixe na semana inteira; bastante carne vermelha.

{montar_contexto_preferencias()}

{TAGS_INFO}

CANDIDATOS:
{candidatos}

RESPONDA APENAS COM JSON VÁLIDO (sem crases, sem texto fora do JSON):
{{
  "tipo": "semanal",
  "periodo": "{PERIODO_SEMANA}",
  "dias": [
    {{"dia": "Segunda", "pratos": [ PRATO, PRATO, PRATO, PRATO ]}}
    // ... até Domingo (7 dias), cada um com 2-3 principais + 1 entrada + 1 sobremesa
  ],
  "lista_compras": {{
    "Proteínas": ["..."],
    "Legumes e verduras": ["..."],
    "Hortifruti": ["..."],
    "Mercearia e despensa": ["..."]
  }}
}}

{ESQUEMA_PRATO}"""


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------
def _chamar(prompt):
    client = genai.Client(api_key=GEMINI_API_KEY)
    grounding = types.Tool(google_search=types.GoogleSearch())
    config = types.GenerateContentConfig(tools=[grounding], temperature=0.7)
    resp = client.models.generate_content(model=MODEL, contents=prompt, config=config)
    return (resp.text or "").strip()


def _extrair_json(texto):
    t = texto.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[-1]
        if t.endswith("```"):
            t = t.rsplit("```", 1)[0]
    t = t.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        ini, fim = t.find("{"), t.rfind("}")
        if ini != -1 and fim != -1:
            return json.loads(t[ini:fim + 1])
        raise


def _prep_prato(p):
    p["id"] = gerar_id(p.get("nome", "prato"))
    p["curso"] = (p.get("curso") or "principal").lower()
    return p


def gerar_diario():
    tema = "Sugira pratos para o jantar de hoje (2-3 principais, 1 entrada, 1 sobremesa)."
    cand = _chamar(prompt_candidatos(tema, "cerca de 10 candidatos"))
    print(f"  Candidatos ({len(cand)} chars). Curando...", flush=True)
    data = _extrair_json(_chamar(prompt_curador_diario(cand)))
    data["pratos"] = [_prep_prato(p) for p in data.get("pratos", [])]
    return data


def gerar_semanal():
    tema = f"Cardápio da próxima semana ({PERIODO_SEMANA}): por dia, 2-3 principais, 1 entrada, 1 sobremesa."
    cand = _chamar(prompt_candidatos(tema, "muitos candidatos (vários por dia)"))
    print(f"  Candidatos ({len(cand)} chars). Curando...", flush=True)
    data = _extrair_json(_chamar(prompt_curador_semanal(cand)))
    for dia in data.get("dias", []):
        dia["pratos"] = [_prep_prato(p) for p in dia.get("pratos", [])]
    return data


# ---------------------------------------------------------------------------
# Histórico
# ---------------------------------------------------------------------------
def _todos_pratos(data):
    if data.get("tipo") == "diario":
        return data.get("pratos", [])
    pratos = []
    for dia in data.get("dias", []):
        pratos += dia.get("pratos", [])
    return pratos


def atualizar_historico(data):
    hist = carregar_json(FILE_HIST, [])
    conhecidos = {h.get("id") for h in hist}
    for p in _todos_pratos(data):
        if p.get("id") and p["id"] not in conhecidos:
            hist.append({"id": p["id"], "titulo": p.get("nome", ""),
                         "tags": p.get("tags", []), "data": DATA_STR})
            conhecidos.add(p["id"])
    salvar_json(FILE_HIST, hist[-500:])


def gravar_receitas_app(data):
    doc = carregar_json(FILE_DIA, {})
    doc["gerado_em"] = DATA_STR
    if data.get("tipo") == "diario":
        doc["diario"] = data
    else:
        doc["semanal"] = data
    salvar_json(FILE_DIA, doc)


# ---------------------------------------------------------------------------
# E-mail
# ---------------------------------------------------------------------------
def _esc(s):
    return html.escape(str(s or ""))


ROTULO = {"principal": "Prato principal", "entrada": "Entrada", "sobremesa": "Sobremesa"}
ORDEM = {"principal": 0, "entrada": 1, "sobremesa": 2}


def _render_prato(p):
    ings = "".join(f"<li>{_esc(i)}</li>" for i in p.get("ingredientes", []))
    passos = "".join(f"<li>{_esc(x)}</li>" for x in p.get("preparo", []))
    sobra = " <em>(rende sobra p/ o almoço)</em>" if p.get("rende_sobra") else ""
    tags = " · ".join(_esc(t) for t in p.get("tags", []))
    bloco = f"<h4>{_esc(p.get('nome',''))}{sobra}</h4>"
    if p.get("porque"):
        bloco += f"<p><em>{_esc(p['porque'])}</em></p>"
    bloco += f"<p><strong>Ingredientes</strong></p><ul>{ings}</ul>"
    bloco += f"<p><strong>Modo de preparo</strong></p><ol>{passos}</ol>"
    if tags:
        bloco += f'<p style="color:#888;font-size:12px">{tags}</p>'
    return bloco


def _render_dia(pratos):
    corpo = ""
    for curso in ("principal", "entrada", "sobremesa"):
        do_curso = [p for p in pratos if p.get("curso") == curso]
        if not do_curso:
            continue
        corpo += f"<h3>{_esc(ROTULO[curso])}</h3>"
        for p in do_curso:
            corpo += _render_prato(p)
    return corpo


def render_email(data):
    if data.get("tipo") == "diario":
        corpo = f"<h2>Receitas de hoje — {_esc(DIA_SEMANA)}, {_esc(DATA_STR)}</h2>"
        corpo += _render_dia(data.get("pratos", []))
        return corpo
    corpo = f"<h2>Cardápio da semana ({_esc(data.get('periodo',''))})</h2>"
    for dia in data.get("dias", []):
        corpo += f"<h3 style='border-bottom:1px solid #eee'>{_esc(dia.get('dia',''))}</h3>"
        corpo += _render_dia(dia.get("pratos", []))
    lc = data.get("lista_compras", {})
    if lc:
        corpo += "<h3>Lista de compras da semana</h3>"
        for cat, itens in lc.items():
            lis = "".join(f"<li>{_esc(i)}</li>" for i in itens)
            corpo += f"<h4>{_esc(cat)}</h4><ul>{lis}</ul>"
    return corpo


def enviar_email(assunto, corpo_html):
    link = (f'<p style="margin:0 0 18px"><a href="{_esc(APP_URL)}">Abrir o app de refeições</a></p>'
            if APP_URL else "")
    documento = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<style>
  body {{ font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
         color:#1a1a1a; line-height:1.5; max-width:680px; margin:0 auto; padding:16px; }}
  h2 {{ margin-top:28px; border-bottom:2px solid #eee; padding-bottom:4px; }}
  h3 {{ margin-top:22px; color:#0b66c3; }}
  h4 {{ margin:14px 0 4px; color:#444; }}
  a  {{ color:#0b66c3; }}
  li {{ margin-bottom:6px; }}
  .rodape {{ margin-top:32px; font-size:12px; color:#888; }}
</style></head><body>
{link}{corpo_html}
<p class="rodape">Enviado automaticamente pelo Agente de Refeições · {DATA_STR}</p>
</body></html>"""

    msg = MIMEMultipart("alternative")
    msg["Subject"] = assunto
    msg["From"] = formataddr(("Agente de Refeições", GMAIL_ADDRESS))
    msg["To"] = ", ".join(RECIPIENTS)
    msg.attach(MIMEText("Seu leitor de e-mail não suporta HTML.", "plain", "utf-8"))
    msg.attach(MIMEText(documento, "html", "utf-8"))

    contexto = ssl.create_default_context()
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=contexto) as servidor:
        servidor.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        servidor.sendmail(GMAIL_ADDRESS, RECIPIENTS, msg.as_string())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"[{DATA_STR}] Modo={MODE} · Gerando (via {MODEL})...", flush=True)

    if MODE == "semanal":
        data = gerar_semanal()
        if not data.get("dias"):
            print("ERRO: cardápio vazio.", file=sys.stderr)
            return 1
        assunto = f"🍽️ Cardápio da semana ({PERIODO_SEMANA}) — Ana e Rafael"
    else:
        data = gerar_diario()
        if not data.get("pratos"):
            print("ERRO: pratos vazios.", file=sys.stderr)
            return 1
        assunto = f"🍽️ Receitas de hoje — {DIA_SEMANA}, {DATA_STR}"

    gravar_receitas_app(data)
    atualizar_historico(data)

    corpo = render_email(data)
    if MODE != "semanal":
        doc = carregar_json(FILE_DIA, {})
        if doc.get("semanal"):
            corpo += ('\n<hr style="margin:28px 0;border:none;border-top:1px solid #eee">\n'
                      + render_email(doc["semanal"]))

    enviar_email(assunto, corpo)
    print(f"OK. E-mail enviado para: {', '.join(RECIPIENTS)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

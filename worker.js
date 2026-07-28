/* =========================================================================
   Mini-servidor (Cloudflare Worker) do app de Refeições.

   Faz três coisas, conforme o campo "action" do pedido:
     - "voto" (padrão): recebe 👍/👎 e avisa o GitHub (workflow registrar-gosto).
     - "foto": recebe a foto de uma receita e o Gemini lê os ingredientes.
     - "consolidar": recebe uma lista de ingredientes e devolve a lista de
        compras somada (quantidades juntadas; itens contáveis arredondados p/ cima).

   Variáveis (Cloudflare → Configurações → Variáveis e segredos):
     - GITHUB_TOKEN  (Segredo)   token fine-grained com Contents: Read and write
     - GEMINI_API_KEY (Segredo)  sua chave do Gemini (mesma dos secrets do GitHub)
     - REPO          (Variável)  ex.: "brazaorafael/webapp-refeicoes"
   ========================================================================= */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MODEL = "gemini-2.5-flash";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function gemini(env, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts }] }),
  });
  const j = await r.json();
  const txt = j?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  return txt;
}

function extrairJson(txt) {
  let t = (txt || "").trim();
  if (t.startsWith("```")) { t = t.split("\n").slice(1).join("\n"); if (t.endsWith("```")) t = t.slice(0, -3); }
  t = t.trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  const c = t.indexOf("["), d = t.lastIndexOf("]");
  try { if (c !== -1 && (a === -1 || c < a)) return JSON.parse(t.slice(c, d + 1)); } catch {}
  try { if (a !== -1) return JSON.parse(t.slice(a, b + 1)); } catch {}
  return null;
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "GET") return json({ ok: true, servico: "cozinha-app" }, 200);
      if (request.method !== "POST") return json({ error: "metodo" }, 405);

      let body;
      try { body = await request.json(); } catch { return json({ error: "json invalido" }, 400); }
      const action = body.action || "voto";

      // ---- Ler ingredientes de uma foto de receita ----
      if (action === "foto") {
        if (!env.GEMINI_API_KEY) return json({ error: "config", detalhe: "GEMINI_API_KEY ausente" }, 200);
        if (!body.imagem) return json({ error: "sem imagem" }, 400);
        const prompt = "Esta imagem é uma receita de comida. Liste APENAS os ingredientes, "
          + "com a quantidade exatamente como aparece. Responda só com um array JSON de strings, "
          + 'ex: ["2 cebolas","1 xícara de arroz","meia colher de sal"]. '
          + "Se não conseguir identificar ingredientes, responda [].";
        const txt = await gemini(env, [
          { text: prompt },
          { inline_data: { mime_type: body.mime || "image/jpeg", data: body.imagem } },
        ]);
        const arr = extrairJson(txt);
        return json({ ingredientes: Array.isArray(arr) ? arr : [] }, 200);
      }

      // ---- Consolidar ingredientes numa lista de compras ----
      if (action === "consolidar") {
        if (!env.GEMINI_API_KEY) return json({ error: "config", detalhe: "GEMINI_API_KEY ausente" }, 200);
        const itens = Array.isArray(body.ingredientes) ? body.ingredientes : [];
        if (!itens.length) return json({ lista: {} }, 200);
        const prompt = "Você recebe ingredientes de várias receitas (texto livre, português do Brasil). "
          + "Monte a LISTA DE COMPRAS consolidada:\n"
          + "- Agrupe itens iguais (ex.: 'cebola', '1 cebola', 'meia cebola' são o mesmo item).\n"
          + "- Some as quantidades quando forem da mesma unidade.\n"
          + "- Para itens CONTÁVEIS (cebola, ovo, dente de alho, tomate, batata), arredonde a soma "
          + "PARA CIMA em unidades inteiras (ex.: 1 + 0,5 + 2 = 3,5 → 4 cebolas).\n"
          + "- Para peso/volume (g, kg, ml, xícaras), some e mantenha a unidade.\n"
          + "- Agrupe por categoria: Proteínas, Legumes e verduras, Hortifruti, Mercearia e despensa, Outros.\n"
          + "Responda SÓ com JSON no formato { \"Categoria\": [\"quantidade item\", ...] }.\n\n"
          + "INGREDIENTES:\n- " + itens.join("\n- ");
        const txt = await gemini(env, [{ text: prompt }]);
        const obj = extrairJson(txt);
        return json({ lista: (obj && typeof obj === "object") ? obj : {} }, 200);
      }

      // ---- Voto (padrão): avisa o GitHub ----
      const repo = (env.REPO || "").trim();
      const token = (env.GITHUB_TOKEN || "").trim();
      if (!repo) return json({ error: "config", detalhe: "REPO ausente" }, 200);
      if (!token) return json({ error: "config", detalhe: "GITHUB_TOKEN ausente" }, 200);
      const voto = body.voto, receita = body.receita;
      if (!["like", "dislike"].includes(voto) || !receita || !receita.id) {
        return json({ error: "payload incompleto" }, 400);
      }
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "cozinha-app-worker",
        },
        body: JSON.stringify({ event_type: "gosto", client_payload: { voto, receita } }),
      });
      if (!resp.ok) return json({ error: "github", status: resp.status, detalhe: await resp.text() }, 200);
      return json({ ok: true }, 200);
    } catch (e) {
      return json({ error: "excecao", detalhe: String(e && e.message ? e.message : e) }, 200);
    }
  },
};


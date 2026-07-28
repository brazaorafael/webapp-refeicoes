/* =========================================================================
   Mini-servidor (Cloudflare Worker) do app de Refeições.

   Ações (campo "action" do pedido):
     - "voto" (padrão): recebe 👍/👎 e avisa o GitHub (workflow registrar-gosto).
     - "foto": lê os ingredientes da foto de uma receita.
     - "consolidar": soma ingredientes numa lista de compras (arredonda p/ cima).
     - "buscar": busca receitas na web (com os sites e critérios do casal).
     - "com_ingredientes": monta receitas com o que o casal tem em casa.

   Variáveis (Cloudflare → Configurações → Variáveis e segredos):
     - GITHUB_TOKEN   (Segredo)   token fine-grained Contents: Read and write
     - GEMINI_API_KEY (Segredo)   chave do Gemini
     - REPO           (Variável)  ex.: "brazaorafael/webapp-refeicoes"
   ========================================================================= */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const MODEL = "gemini-2.5-flash";

const PERFIL = "Perfil: casal jovem, jantar para 2. Prioridade em proteína (carne vermelha "
  + "é a preferida; peixe no máximo 1x por semana). Pouca fritura (prefira airfryer, forno, "
  + "grelha ou refogado). Receitas fáceis e práticas, até ~45 min. Sites preferidos: "
  + "panelinha.com.br, panelinha.com.br/home/cozinha-pratica, receitas.globo.com/ana-maria-braga, "
  + "tudogostoso.com.br.";

const ESQUEMA = "Cada receita é um objeto: { \"nome\", \"curso\" (\"principal\"|\"entrada\"|\"sobremesa\"), "
  + "\"tempo\" (tempo estimado de preparo, ex: \"35 min\"), "
  + "\"url\" (link direto e real da receita no site onde foi encontrada), "
  + "\"porque\" (1 frase), \"tags\" (array curto, ex: [\"carne_vermelha\",\"airfryer\"]), "
  + "\"rende_sobra\" (true/false), \"ingredientes\" (array, com quantidades), "
  + "\"preparo\" (array de 4 a 6 passos claros) }.";

function json(obj, status) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

async function gemini(env, parts, useSearch) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body = { contents: [{ parts }] };
  if (useSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json();
  return (j?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("");
}

async function ogImage(pageUrl) {
  const r = await fetch(pageUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; CozinhaBot/1.0)" } });
  if (!r.ok) return null;
  const html = await r.text();
  const m = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/i);
  let u = m ? m[1] : null;
  if (u && u.startsWith("//")) u = "https:" + u;
  else if (u && u.startsWith("/")) { try { u = new URL(pageUrl).origin + u; } catch {} }
  return u;
}

async function pexels(env, q) {
  if (!env.PEXELS_KEY || !q) return null;
  const u = "https://api.pexels.com/v1/search?per_page=1&orientation=landscape&query=" + encodeURIComponent(q + " food dish");
  const r = await fetch(u, { headers: { Authorization: env.PEXELS_KEY } });
  const j = await r.json();
  return j?.photos?.[0]?.src?.medium || null;
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

function comoArray(x) { return Array.isArray(x) ? x : (x && Array.isArray(x.pratos) ? x.pratos : []); }

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (request.method === "GET") return json({ ok: true, servico: "cozinha-app" }, 200);
      if (request.method !== "POST") return json({ error: "metodo" }, 405);

      let body;
      try { body = await request.json(); } catch { return json({ error: "json invalido" }, 400); }
      const action = body.action || "voto";
      const precisaGemini = ["foto", "consolidar", "buscar", "com_ingredientes"].includes(action);
      if (precisaGemini && !env.GEMINI_API_KEY) return json({ error: "config", detalhe: "GEMINI_API_KEY ausente" }, 200);

      // ---- Foto do prato: capa do site (og:image) + banco de imagens como plano B ----
      if (action === "imagem") {
        const q = (body.consulta || "").trim();
        const pageUrl = (body.url || "").trim();
        let site = null, banco = null;
        if (pageUrl) { try { site = await ogImage(pageUrl); } catch {} }
        try { banco = await pexels(env, q); } catch {}
        return json({ site, banco }, 200);
      }

      // ---- Foto -> ingredientes ----
      if (action === "foto") {
        if (!body.imagem) return json({ error: "sem imagem" }, 400);
        const prompt = "Esta imagem é uma receita de comida. Liste APENAS os ingredientes, com a "
          + "quantidade como aparece. Responda só com um array JSON de strings, ex: "
          + '["2 cebolas","1 xícara de arroz"]. Se não identificar, responda [].';
        const txt = await gemini(env, [{ text: prompt }, { inline_data: { mime_type: body.mime || "image/jpeg", data: body.imagem } }]);
        const arr = extrairJson(txt);
        return json({ ingredientes: Array.isArray(arr) ? arr : [] }, 200);
      }

      // ---- Consolidar lista de compras ----
      if (action === "consolidar") {
        const itens = Array.isArray(body.ingredientes) ? body.ingredientes : [];
        if (!itens.length) return json({ lista: {} }, 200);
        const prompt = "Você recebe ingredientes de várias receitas (português do Brasil). Monte a LISTA "
          + "DE COMPRAS consolidada:\n- Agrupe itens iguais (ex.: 'cebola', '1 cebola', 'meia cebola').\n"
          + "- Some as quantidades da mesma unidade.\n- Itens CONTÁVEIS (cebola, ovo, dente de alho, tomate, "
          + "batata): arredonde a soma PARA CIMA em unidades inteiras (ex.: 1 + 0,5 + 2 = 3,5 → 4 cebolas).\n"
          + "- Peso/volume (g, kg, ml, xícaras): some e mantenha a unidade.\n- Agrupe por categoria: Proteínas, "
          + "Legumes e verduras, Hortifruti, Mercearia e despensa, Outros.\nResponda SÓ com JSON no formato "
          + "{ \"Categoria\": [\"quantidade item\", ...] }.\n\nINGREDIENTES:\n- " + itens.join("\n- ");
        const obj = extrairJson(await gemini(env, [{ text: prompt }]));
        return json({ lista: (obj && typeof obj === "object" && !Array.isArray(obj)) ? obj : {} }, 200);
      }

      // ---- Buscar receitas na web ----
      if (action === "buscar") {
        const texto = (body.texto || "").trim();
        if (!texto) return json({ pratos: [] }, 200);
        const prompt = "Você é um buscador de receitas. Busque no Google agora receitas que atendam a este "
          + "pedido: \"" + texto + "\".\n" + PERFIL + "\nTraga de 2 a 4 receitas boas e bem avaliadas. "
          + "Responda SÓ com JSON: um array de receitas. " + ESQUEMA;
        const arr = comoArray(extrairJson(await gemini(env, [{ text: prompt }], true)));
        return json({ pratos: arr.slice(0, 4) }, 200);
      }

      // ---- Montar receitas com o que a pessoa tem ----
      if (action === "com_ingredientes") {
        const itens = Array.isArray(body.ingredientes) ? body.ingredientes
          : (body.texto ? [body.texto] : []);
        if (!itens.length) return json({ pratos: [] }, 200);
        const prompt = "Monte de 1 a 3 receitas de jantar usando PRINCIPALMENTE estes ingredientes que o "
          + "casal tem em casa: " + itens.join(", ") + ". Pode assumir itens básicos de despensa (sal, óleo, "
          + "alho, cebola, arroz, temperos). " + PERFIL + "\nBusque no Google para inspirar em receitas reais "
          + "e bem avaliadas. Responda SÓ com JSON: um array de receitas. " + ESQUEMA;
        const arr = comoArray(extrairJson(await gemini(env, [{ text: prompt }], true)));
        return json({ pratos: arr.slice(0, 3) }, 200);
      }

      // ---- Voto (padrão) ----
      const repo = (env.REPO || "").trim();
      const token = (env.GITHUB_TOKEN || "").trim();
      if (!repo) return json({ error: "config", detalhe: "REPO ausente" }, 200);
      if (!token) return json({ error: "config", detalhe: "GITHUB_TOKEN ausente" }, 200);
      const voto = body.voto, receita = body.receita;
      if (!["like", "dislike"].includes(voto) || !receita || !receita.id) return json({ error: "payload incompleto" }, 400);
      const resp = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json",
          "Content-Type": "application/json", "User-Agent": "cozinha-app-worker",
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

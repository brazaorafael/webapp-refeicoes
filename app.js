/* =========================================================================
   App de Refeições — Ana & Rafael  (pratos à la carte)
   - Cada PRATO é curtido individualmente (principal, entrada ou sobremesa).
   - Tocar num prato abre a tela da receita (ingredientes + preparo).
   - Votos vão ao mini-servidor (Worker) para o agente aprender.
   ========================================================================= */
 
const WORKER_URL = "https://cozinha-app.brazaorafael.workers.dev";
 
const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};
 
let VOTOS = LS.get("votos", {});           // { idPrato: "like" | "dislike" }
let CACHE = LS.get("cache_pratos", {});    // { idPrato: pratoObj } (curtidos)
let FOTOS = LS.get("foto_extras", []);     // [{ id, nome, ingredientes:[] }] adicionados por foto
let LAST_COMPRAS = [];                       // última lista de compras gerada (para o e-mail)
let DADOS = { dia: null, lista: null, perfil: null };
let INDICE = {};                            // { idPrato: pratoObj } (todos os pratos carregados)
 
const CURSOS = ["principal", "entrada", "sobremesa"];
const ROTULO = { principal: "Prato principal", entrada: "Entrada", sobremesa: "Sobremesa" };
 
// -------------------------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
 
async function carregar(nome) {
  try {
    const r = await fetch(`./data/${nome}.json?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
 
async function iniciar() {
  [DADOS.dia, DADOS.lista, DADOS.perfil] = await Promise.all([
    carregar("receitas_do_dia"), carregar("lista_final"), carregar("perfil_gostos"),
  ]);
  indexarPratos();
  renderHoje(); renderSemana(); renderLista(); renderPerfil();
  const quando = DADOS.dia?.gerado_em;
  document.getElementById("rodape-atualizado").textContent =
    quando && quando !== "exemplo" ? `Atualizado em ${quando}` : "Aguardando a primeira geração de receitas";
}
 
function indexarPratos() {
  INDICE = {};
  (DADOS.dia?.diario?.pratos || []).forEach(p => INDICE[p.id] = p);
  (DADOS.dia?.semanal?.dias || []).forEach(d => (d.pratos || []).forEach(p => INDICE[p.id] = p));
  Object.values(CACHE).forEach(p => { if (p && p.id && !INDICE[p.id]) INDICE[p.id] = p; });
}
 
// -------------------------------------------------------------------------
// Linha de prato (nome + tags + votos), tocável para abrir a receita
// -------------------------------------------------------------------------
function linhaPrato(p, compacto) {
  const voto = VOTOS[p.id];
  const tags = (p.tags || []).map(t => esc(t).replace(/_/g, " ")).join(" · ");
  const sobra = p.rende_sobra ? ` <span class="sobra">rende sobra</span>` : "";
  return `<div class="prato-linha ${compacto ? "compacto" : ""}" data-id="${esc(p.id)}">
    <button class="prato-abrir" data-abrir="${esc(p.id)}">
      <span class="prato-nome">${esc(p.nome)}</span>
      ${tags ? `<span class="prato-tags">${tags}${sobra}</span>` : sobra}
      <span class="prato-link">ver receita ›</span>
    </button>
    <div class="votos-mini">
      <button class="votinho ${voto === "like" ? "sel-gostei" : ""}" data-voto="like" data-p="${esc(p.id)}" aria-label="Gostei">👍</button>
      <button class="votinho ${voto === "dislike" ? "sel-naogostei" : ""}" data-voto="dislike" data-p="${esc(p.id)}" aria-label="Não curti">👎</button>
    </div>
  </div>`;
}
 
function blocosPorCurso(pratos) {
  let html = "";
  CURSOS.forEach(curso => {
    const doCurso = pratos.filter(p => (p.curso || "principal") === curso);
    if (!doCurso.length) return;
    const opcional = curso !== "principal" ? " · opcional" : (doCurso.length > 1 ? " · escolha" : "");
    html += `<p class="curso-rot">${esc(ROTULO[curso])}${opcional}</p>`;
    html += doCurso.map(p => linhaPrato(p)).join("");
  });
  return html;
}
 
function ligarInteracoes(container) {
  container.querySelectorAll("[data-voto]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); votar(btn.dataset.p, btn.dataset.voto); });
  });
  container.querySelectorAll("[data-abrir]").forEach(btn => {
    btn.addEventListener("click", () => abrirReceita(btn.dataset.abrir));
  });
}
 
// -------------------------------------------------------------------------
// Abas
// -------------------------------------------------------------------------
function renderHoje() {
  const alvo = document.getElementById("hoje");
  const pratos = DADOS.dia?.diario?.pratos || [];
  if (!pratos.length) { alvo.innerHTML = `<p class="vazio">Ainda não há receitas de hoje.</p>`; return; }
  alvo.innerHTML = `<h2 class="secao-titulo">Receitas de hoje</h2>` + blocosPorCurso(pratos);
  ligarInteracoes(alvo);
}
 
function renderSemana() {
  const alvo = document.getElementById("semana");
  const dias = DADOS.dia?.semanal?.dias || [];
  if (!dias.length) { alvo.innerHTML = `<p class="vazio">O cardápio da semana chega no domingo à noite.</p>`; return; }
  let html = `<h2 class="secao-titulo">Cardápio da semana</h2>`;
  dias.forEach(d => {
    html += `<h3 class="dia-titulo">${esc(d.dia)}</h3>` + blocosPorCurso(d.pratos || []);
  });
  alvo.innerHTML = html;
  ligarInteracoes(alvo);
}
 
function pratosDaLista() {
  const doRepo = DADOS.lista?.itens || [];
  const mapa = {};
  doRepo.forEach(p => { if (p && p.id) mapa[p.id] = p; });
  Object.keys(VOTOS).forEach(id => {
    if (VOTOS[id] === "like" && (CACHE[id] || INDICE[id])) mapa[id] = CACHE[id] || INDICE[id];
    if (VOTOS[id] === "dislike") delete mapa[id];
  });
  return Object.values(mapa);
}
 
function renderLista() {
  const alvo = document.getElementById("lista");
  const itens = pratosDaLista();
  const total = itens.length + FOTOS.length;
  let html = `<h2 class="secao-titulo">Minha lista${total ? ` (${total})` : ""}</h2>`;
  html += `<div class="btn-linha">
      <label class="btn" for="foto-input">📷 Adicionar por foto</label>
      <input id="foto-input" type="file" accept="image/*" multiple hidden>
      <button class="btn" id="btn-compras">Gerar lista de compras</button>
    </div>`;
  html += `<p class="ajuda" id="foto-status"></p>`;
 
  if (!total) {
    html += `<p class="vazio">Marque 👍 nos pratos, ou toque em “Adicionar por foto” para incluir uma receita de fora. Tudo entra na lista de compras.</p>`;
  }
 
  CURSOS.forEach(curso => {
    const doCurso = itens.filter(p => (p.curso || "principal") === curso);
    if (!doCurso.length) return;
    html += `<p class="curso-rot">${esc(ROTULO[curso])}</p>`;
    html += doCurso.map(p => linhaPrato(p, true)).join("");
  });
 
  if (FOTOS.length) {
    html += `<p class="curso-rot">Das fotos</p>`;
    html += FOTOS.map(f => `<div class="prato-linha compacto">
        <div class="prato-abrir" style="cursor:default">
          <span class="prato-nome">${esc(f.nome)}</span>
          <span class="prato-tags">${(f.ingredientes || []).length} ingredientes</span>
        </div>
        <div class="votos-mini"><button class="votinho" data-remove-foto="${esc(f.id)}" aria-label="Remover">✕</button></div>
      </div>`).join("");
  }
 
  html += `<div id="area-compras"></div>`;
  alvo.innerHTML = html;
  ligarInteracoes(alvo);
  document.getElementById("foto-input").addEventListener("change", e => adicionarFotos(e.target.files));
  document.getElementById("btn-compras").onclick = gerarCompras;
  alvo.querySelectorAll("[data-remove-foto]").forEach(b => b.addEventListener("click", () => removerFoto(b.dataset.removeFoto)));
}
 
function statusFoto(txt) { const s = document.getElementById("foto-status"); if (s) s.textContent = txt; }
 
function fileToBase64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}
 
async function adicionarFotos(files) {
  if (!files || !files.length) return;
  const url = urlDoWorker();
  if (!url) { statusFoto("Sincronização não configurada (veja Ajustes)."); return; }
  let n = 0;
  for (const f of files) {
    statusFoto(`Lendo a foto ${++n} de ${files.length}…`);
    try {
      const b64 = await fileToBase64(f);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "foto", imagem: b64, mime: f.type || "image/jpeg" }) });
      const j = await r.json();
      const ings = Array.isArray(j.ingredientes) ? j.ingredientes : [];
      if (ings.length) {
        FOTOS.push({ id: "foto-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6),
                     nome: "Receita da foto", ingredientes: ings });
      } else { statusFoto("Não consegui ler ingredientes nessa foto."); }
    } catch (e) { statusFoto("Erro ao ler a foto."); }
  }
  LS.set("foto_extras", FOTOS);
  statusFoto("");
  renderLista();
}
 
function removerFoto(id) {
  FOTOS = FOTOS.filter(f => f.id !== id);
  LS.set("foto_extras", FOTOS);
  renderLista();
}
 
async function gerarCompras() {
  const itens = pratosDaLista();
  const ingredientes = [];
  [...itens, ...FOTOS].forEach(p => (p.ingredientes || []).forEach(i => ingredientes.push(i)));
  const area = document.getElementById("area-compras");
  if (!ingredientes.length) { area.innerHTML = `<p class="ajuda">Nada na lista ainda.</p>`; return; }
  area.innerHTML = `<p class="ajuda">Montando a lista e somando as quantidades…</p>`;
  const url = urlDoWorker();
  try {
    if (!url) throw new Error("sem worker");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "consolidar", ingredientes }) });
    const j = await r.json();
    const lista = j.lista || {};
    if (Object.keys(lista).length) { renderCompras(area, lista); return; }
    throw new Error("vazio");
  } catch (e) {
    const set = new Map();
    ingredientes.forEach(i => { const k = i.toLowerCase().trim(); if (!set.has(k)) set.set(k, i.trim()); });
    renderCompras(area, { "Lista de compras": [...set.values()].sort((a, b) => a.localeCompare(b, "pt-BR")) });
  }
}
 
function renderCompras(area, lista) {
  LAST_COMPRAS = [];
  let html = `<h3 class="dia-titulo">Lista de compras</h3>`;
  for (const [cat, itens] of Object.entries(lista)) {
    html += `<p class="curso-rot">${esc(cat)}</p><ul class="compras">`;
    (itens || []).forEach(i => { LAST_COMPRAS.push(i); html += `<li><input type="checkbox"> ${esc(i)}</li>`; });
    html += `</ul>`;
  }
  html += `<div class="btn-linha"><button class="btn" id="btn-email">Enviar por e-mail</button></div>`;
  area.innerHTML = html;
  document.getElementById("btn-email").onclick = enviarPorEmail;
}
 
function enviarPorEmail() {
  const corpo = "Lista de compras:%0D%0A%0D%0A" + LAST_COMPRAS.map(i => "- " + i).join("%0D%0A");
  window.location.href = `mailto:?subject=${encodeURIComponent("Lista de compras — Cozinha Ana & Rafael")}&body=${corpo}`;
}
 
function renderPerfil() {
  const alvo = document.getElementById("perfil");
  const p = DADOS.perfil || {};
  const cont = p.contadores || {};
  const pos = Object.entries(cont).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const neg = Object.entries(cont).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  let html = `<h2 class="secao-titulo">O que o app aprendeu</h2>`;
  html += `<p class="ajuda">${(p.curtidas || []).length} pratos curtidos · ${(p.rejeitadas || []).length} rejeitados</p>`;
  if (p.resumo) html += `<p>${esc(p.resumo)}</p>`;
  if (pos.length) html += `<p class="curso-rot">Vocês tendem a curtir</p><div class="chip-grid">` +
    pos.map(([k]) => `<span class="chip pos">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
  if (neg.length) html += `<p class="curso-rot">Costumam evitar</p><div class="chip-grid">` +
    neg.map(([k]) => `<span class="chip neg">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
  if (!pos.length && !neg.length) html += `<p class="vazio">Comece marcando 👍/👎 nos pratos.</p>`;
  alvo.innerHTML = html;
}
 
// -------------------------------------------------------------------------
// Tela da receita
// -------------------------------------------------------------------------
function abrirReceita(id) {
  const p = INDICE[id];
  if (!p) return;
  const voto = VOTOS[id];
  const tags = (p.tags || []).map(t => esc(t).replace(/_/g, " ")).join(" · ");
  const ings = (p.ingredientes || []).map(i => `<label class="check"><input type="checkbox"> ${esc(i)}</label>`).join("");
  const passos = (p.preparo || []).map((x, n) => `<div class="passo"><b>${n + 1}.</b> ${esc(x)}</div>`).join("");
  const tela = document.getElementById("tela-receita");
  tela.innerHTML = `
    <div class="receita-topo">
      <button class="link-sutil" id="rec-voltar">‹ voltar</button>
    </div>
    <h2 class="receita-titulo">${esc(p.nome)}</h2>
    ${tags ? `<p class="receita-tags">${tags}</p>` : ""}
    ${p.porque ? `<p class="porque">${esc(p.porque)}</p>` : ""}
    <p class="curso-rot">Ingredientes</p>
    <div class="ingredientes">${ings}</div>
    <p class="curso-rot">Modo de preparo</p>
    <div class="preparo">${passos}</div>
    <div class="votos">
      <button class="voto ${voto === "like" ? "sel-gostei" : ""}" data-voto="like" data-p="${esc(id)}">👍 Gostei</button>
      <button class="voto ${voto === "dislike" ? "sel-naogostei" : ""}" data-voto="dislike" data-p="${esc(id)}">👎 Não curti</button>
    </div>`;
  tela.querySelector("#rec-voltar").onclick = fecharReceita;
  tela.querySelectorAll("[data-voto]").forEach(btn => {
    btn.addEventListener("click", () => { votar(btn.dataset.p, btn.dataset.voto); abrirReceita(id); });
  });
  tela.classList.remove("escondida");
  window.scrollTo(0, 0);
}
 
function fecharReceita() {
  document.getElementById("tela-receita").classList.add("escondida");
}
 
// -------------------------------------------------------------------------
// Votar
// -------------------------------------------------------------------------
async function votar(id, voto) {
  const p = INDICE[id];
  if (!p) return;
  VOTOS[id] = (VOTOS[id] === voto) ? undefined : voto;
  if (VOTOS[id] === undefined) delete VOTOS[id];
  if (VOTOS[id] === "like") CACHE[id] = p; else delete CACHE[id];
  LS.set("votos", VOTOS); LS.set("cache_pratos", CACHE);
  renderHoje(); renderSemana(); renderLista();
  if (VOTOS[id]) enviarVoto(voto, p);
}
 
function urlDoWorker() {
  const cfg = LS.get("cfg", {});
  return (cfg.worker || WORKER_URL || "").trim();
}
 
async function enviarVoto(voto, prato) {
  const url = urlDoWorker();
  if (!url) return;
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voto, receita: prato }),
    });
    if (!r.ok) console.warn("Falha ao sincronizar:", r.status);
  } catch (e) { console.warn("Sem rede para sincronizar:", e); }
}
 
// -------------------------------------------------------------------------
// Abas + configuração
// -------------------------------------------------------------------------
document.querySelectorAll(".aba").forEach(btn => {
  btn.addEventListener("click", () => {
    fecharReceita();
    document.querySelectorAll(".aba").forEach(b => b.classList.remove("ativa"));
    document.querySelectorAll(".painel").forEach(p => p.classList.remove("ativo"));
    btn.classList.add("ativa");
    document.getElementById(btn.dataset.aba).classList.add("ativo");
  });
});
 
const modal = document.getElementById("modal-config");
document.getElementById("btn-config").onclick = () => {
  const cfg = LS.get("cfg", {});
  document.getElementById("cfg-worker").value = cfg.worker || "";
  document.getElementById("cfg-status").textContent =
    urlDoWorker() ? "Sincronização ativa." : "Sem sincronização (votos ficam só neste aparelho).";
  modal.classList.remove("escondido");
};
document.getElementById("cfg-fechar").onclick = () => modal.classList.add("escondido");
document.getElementById("cfg-salvar").onclick = () => {
  LS.set("cfg", { worker: document.getElementById("cfg-worker").value.trim() });
  modal.classList.add("escondido");
};
 
iniciar();

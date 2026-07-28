/* =========================================================================
   App de Refeições — Ana & Rafael  (pratos à la carte + Buscar + lista auto)
   ========================================================================= */

const WORKER_URL = "https://cozinha-app.brazaorafael.workers.dev";

const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

let VOTOS = LS.get("votos", {});          // { id: "like"|"dislike" }
let CACHE = LS.get("cache_pratos", {});   // { id: prato } (curtidos)
let FOTOS = LS.get("foto_extras", []);    // [{ id, nome, ingredientes:[] }]
let DADOS = { dia: null, lista: null, perfil: null };
let INDICE = {};                           // { id: prato } (todos conhecidos)
let BUSCA = [];                            // resultados da aba Buscar
let LISTA_CACHE = LS.get("lista_cache", { sig: "", lista: null });

const CURSOS = ["principal", "entrada", "sobremesa"];
const ROTULO = { principal: "Prato principal", entrada: "Entrada", sobremesa: "Sobremesa" };

function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function slug(s) { return String(s || "prato").toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40); }
function idNovo(nome) { return slug(nome) + "-" + Math.random().toString(36).slice(2, 7); }

// -------------------------------------------------------------------------
async function carregar(nome) {
  try { const r = await fetch(`./data/${nome}.json?t=${Date.now()}`); return r.ok ? await r.json() : null; }
  catch { return null; }
}

async function iniciar() {
  [DADOS.dia, DADOS.lista, DADOS.perfil] = await Promise.all([
    carregar("receitas_do_dia"), carregar("lista_final"), carregar("perfil_gostos"),
  ]);
  indexarPratos();
  renderHoje(); renderSemana(); renderBuscar(); renderLista(); renderPerfil();
  const quando = DADOS.dia?.gerado_em;
  document.getElementById("rodape-atualizado").textContent =
    quando && quando !== "exemplo" ? `Atualizado em ${quando}` : "Aguardando a primeira geração de receitas";
}

function indexarPratos() {
  (DADOS.dia?.diario?.pratos || []).forEach(p => INDICE[p.id] = p);
  (DADOS.dia?.semanal?.dias || []).forEach(d => (d.pratos || []).forEach(p => INDICE[p.id] = p));
  Object.values(CACHE).forEach(p => { if (p && p.id) INDICE[p.id] = p; });
  BUSCA.forEach(p => { if (p && p.id) INDICE[p.id] = p; });
}

// -------------------------------------------------------------------------
// Linha de prato + agrupamento por curso
// -------------------------------------------------------------------------
function linhaPrato(p) {
  const voto = VOTOS[p.id];
  const tags = (p.tags || []).map(t => esc(t).replace(/_/g, " ")).join(" · ");
  const sobra = p.rende_sobra ? ` <span class="sobra">rende sobra</span>` : "";
  return `<div class="prato-linha" data-id="${esc(p.id)}">
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
    const rot = curso !== "principal" ? " · opcional" : (doCurso.length > 1 ? " · escolha" : "");
    html += `<p class="curso-rot">${esc(ROTULO[curso])}${rot}</p>` + doCurso.map(linhaPrato).join("");
  });
  return html;
}

function ligarInteracoes(container) {
  container.querySelectorAll("[data-voto]").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); votar(b.dataset.p, b.dataset.voto); }));
  container.querySelectorAll("[data-abrir]").forEach(b => b.addEventListener("click", () => abrirReceita(b.dataset.abrir)));
}

// -------------------------------------------------------------------------
// Abas Hoje / Semana
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
  dias.forEach(d => { html += `<h3 class="dia-titulo">${esc(d.dia)}</h3>` + blocosPorCurso(d.pratos || []); });
  alvo.innerHTML = html;
  ligarInteracoes(alvo);
}

// -------------------------------------------------------------------------
// Aba Buscar (buscar receita + cozinhar com o que tenho)
// -------------------------------------------------------------------------
function renderBuscar() {
  const alvo = document.getElementById("buscar");
  alvo.innerHTML = `
    <h2 class="secao-titulo">Buscar receitas</h2>
    <p class="curso-rot">Busque uma ideia</p>
    <div class="busca-linha">
      <input id="busca-texto" type="text" placeholder="ex.: frango rápido, algo com abóbora">
      <button class="btn" id="busca-btn">Buscar</button>
    </div>
    <p class="curso-rot">Cozinhar com o que tenho</p>
    <div class="busca-linha">
      <input id="busca-ingr" type="text" placeholder="ex.: ovos, batata, queijo">
      <button class="btn" id="busca-ingr-btn">Montar</button>
    </div>
    <p class="ajuda" id="busca-status"></p>
    <div id="busca-resultados">${BUSCA.length ? blocosPorCurso(BUSCA) : ""}</div>`;
  const res = document.getElementById("busca-resultados");
  if (BUSCA.length) ligarInteracoes(res);

  const rodar = async (acao, payload) => {
    const st = document.getElementById("busca-status");
    st.textContent = "Buscando receitas…";
    const url = urlDoWorker();
    if (!url) { st.textContent = "Sincronização não configurada (Ajustes)."; return; }
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const j = await r.json();
      const pratos = (j.pratos || []).map(p => { p.id = idNovo(p.nome); p.curso = (p.curso || "principal").toLowerCase(); return p; });
      pratos.forEach(p => INDICE[p.id] = p);
      BUSCA = pratos;
      st.textContent = pratos.length ? "" : "Não encontrei receitas para isso. Tente outras palavras.";
      renderBuscar();
    } catch (e) { st.textContent = "Erro na busca. Tente de novo."; }
  };

  document.getElementById("busca-btn").onclick = () => {
    const t = document.getElementById("busca-texto").value.trim();
    if (t) rodar("buscar", { action: "buscar", texto: t });
  };
  document.getElementById("busca-ingr-btn").onclick = () => {
    const t = document.getElementById("busca-ingr").value.trim();
    if (t) rodar("com_ingredientes", { action: "com_ingredientes", ingredientes: t.split(",").map(s => s.trim()).filter(Boolean) });
  };
}

// -------------------------------------------------------------------------
// Minha lista (com lista de compras automática)
// -------------------------------------------------------------------------
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

function coletarIngredientes() {
  const out = [];
  [...pratosDaLista(), ...FOTOS].forEach(p => (p.ingredientes || []).forEach(i => out.push(i)));
  return out;
}

function renderLista() {
  const alvo = document.getElementById("lista");
  const itens = pratosDaLista();
  const total = itens.length + FOTOS.length;
  let html = `<h2 class="secao-titulo">Minha lista${total ? ` (${total})` : ""}</h2>`;
  html += `<div class="btn-linha">
      <label class="btn" for="foto-input">📷 Adicionar por foto</label>
      <input id="foto-input" type="file" accept="image/*" multiple hidden>
    </div><p class="ajuda" id="foto-status"></p>`;
  if (!total) html += `<p class="vazio">Marque 👍 nos pratos, ou toque em “Adicionar por foto” para incluir uma receita de fora. A lista de compras se monta sozinha aqui embaixo.</p>`;

  CURSOS.forEach(curso => {
    const doCurso = itens.filter(p => (p.curso || "principal") === curso);
    if (!doCurso.length) return;
    html += `<p class="curso-rot">${esc(ROTULO[curso])}</p>` + doCurso.map(linhaPrato).join("");
  });
  if (FOTOS.length) {
    html += `<p class="curso-rot">Das fotos</p>` + FOTOS.map(f => `<div class="prato-linha">
        <div class="prato-abrir" style="cursor:default"><span class="prato-nome">${esc(f.nome)}</span>
          <span class="prato-tags">${(f.ingredientes || []).length} ingredientes</span></div>
        <div class="votos-mini"><button class="votinho" data-remove-foto="${esc(f.id)}" aria-label="Remover">✕</button></div>
      </div>`).join("");
  }
  html += `<div id="area-compras"></div>`;
  alvo.innerHTML = html;
  ligarInteracoes(alvo);
  document.getElementById("foto-input").addEventListener("change", e => adicionarFotos(e.target.files));
  alvo.querySelectorAll("[data-remove-foto]").forEach(b => b.addEventListener("click", () => removerFoto(b.dataset.removeFoto)));
  if (document.getElementById("lista").classList.contains("ativo")) atualizarCompras();
}

async function consolidar(ingredientes) {
  const url = urlDoWorker();
  try {
    if (!url) throw new Error("sem worker");
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "consolidar", ingredientes }) });
    const j = await r.json();
    if (j.lista && Object.keys(j.lista).length) return j.lista;
    throw new Error("vazio");
  } catch (e) {
    const set = new Map();
    ingredientes.forEach(i => { const k = i.toLowerCase().trim(); if (!set.has(k)) set.set(k, i.trim()); });
    return { "Lista de compras": [...set.values()].sort((a, b) => a.localeCompare(b, "pt-BR")) };
  }
}

async function atualizarCompras() {
  const area = document.getElementById("area-compras");
  if (!area) return;
  const ingredientes = coletarIngredientes();
  const sig = JSON.stringify([...ingredientes].sort());
  if (!ingredientes.length) { area.innerHTML = ""; LISTA_CACHE = { sig: "", lista: null }; LS.set("lista_cache", LISTA_CACHE); return; }
  if (LISTA_CACHE.sig === sig && LISTA_CACHE.lista) { renderCompras(area, LISTA_CACHE.lista); return; }
  area.innerHTML = `<p class="ajuda">Montando a lista e somando as quantidades…</p>`;
  const lista = await consolidar(ingredientes);
  LISTA_CACHE = { sig, lista }; LS.set("lista_cache", LISTA_CACHE);
  renderCompras(area, lista);
}

function renderCompras(area, lista) {
  const todos = [];
  let html = `<h3 class="dia-titulo">Lista de compras</h3>`;
  for (const [cat, itens] of Object.entries(lista)) {
    html += `<p class="curso-rot">${esc(cat)}</p><ul class="compras">`;
    (itens || []).forEach(i => { todos.push(i); html += `<li><input type="checkbox"> ${esc(i)}</li>`; });
    html += `</ul>`;
  }
  html += `<div class="btn-linha"><button class="btn" id="btn-email">Enviar por e-mail</button></div>`;
  area.innerHTML = html;
  document.getElementById("btn-email").onclick = () => {
    const corpo = "Lista de compras:%0D%0A%0D%0A" + todos.map(i => "- " + i).join("%0D%0A");
    window.location.href = `mailto:?subject=${encodeURIComponent("Lista de compras — Cozinha Ana & Rafael")}&body=${corpo}`;
  };
}

// -------------------------------------------------------------------------
// Fotos
// -------------------------------------------------------------------------
function fileToBase64(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(file); });
}
async function adicionarFotos(files) {
  if (!files || !files.length) return;
  const url = urlDoWorker();
  const st = () => document.getElementById("foto-status");
  if (!url) { if (st()) st().textContent = "Sincronização não configurada (Ajustes)."; return; }
  let n = 0;
  for (const f of files) {
    if (st()) st().textContent = `Lendo a foto ${++n} de ${files.length}…`;
    try {
      const b64 = await fileToBase64(f);
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "foto", imagem: b64, mime: f.type || "image/jpeg" }) });
      const j = await r.json();
      const ings = Array.isArray(j.ingredientes) ? j.ingredientes : [];
      if (ings.length) FOTOS.push({ id: "foto-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6), nome: "Receita da foto", ingredientes: ings });
      else if (st()) st().textContent = "Não consegui ler ingredientes nessa foto.";
    } catch (e) { if (st()) st().textContent = "Erro ao ler a foto."; }
  }
  LS.set("foto_extras", FOTOS);
  renderLista();
}
function removerFoto(id) { FOTOS = FOTOS.filter(f => f.id !== id); LS.set("foto_extras", FOTOS); renderLista(); }

// -------------------------------------------------------------------------
// Perfil
// -------------------------------------------------------------------------
function renderPerfil() {
  const alvo = document.getElementById("perfil");
  const p = DADOS.perfil || {};
  const cont = p.contadores || {};
  const pos = Object.entries(cont).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const neg = Object.entries(cont).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  let html = `<h2 class="secao-titulo">O que o app aprendeu</h2>`;
  html += `<p class="ajuda">${(p.curtidas || []).length} pratos curtidos · ${(p.rejeitadas || []).length} rejeitados</p>`;
  if (p.resumo) html += `<p>${esc(p.resumo)}</p>`;
  if (pos.length) html += `<p class="curso-rot">Vocês tendem a curtir</p><div class="chip-grid">` + pos.map(([k]) => `<span class="chip pos">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
  if (neg.length) html += `<p class="curso-rot">Costumam evitar</p><div class="chip-grid">` + neg.map(([k]) => `<span class="chip neg">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
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
    <div class="receita-topo"><button class="link-sutil" id="rec-voltar">‹ voltar</button></div>
    <h2 class="receita-titulo">${esc(p.nome)}</h2>
    ${tags ? `<p class="receita-tags">${tags}</p>` : ""}
    ${p.porque ? `<p class="porque">${esc(p.porque)}</p>` : ""}
    <p class="curso-rot">Ingredientes</p><div class="ingredientes">${ings}</div>
    <p class="curso-rot">Modo de preparo</p><div class="preparo">${passos}</div>
    <div class="votos">
      <button class="voto ${voto === "like" ? "sel-gostei" : ""}" data-voto="like" data-p="${esc(id)}">👍 Gostei</button>
      <button class="voto ${voto === "dislike" ? "sel-naogostei" : ""}" data-voto="dislike" data-p="${esc(id)}">👎 Não curti</button>
    </div>`;
  tela.querySelector("#rec-voltar").onclick = fecharReceita;
  tela.querySelectorAll("[data-voto]").forEach(b => b.addEventListener("click", () => { votar(b.dataset.p, b.dataset.voto); abrirReceita(id); }));
  tela.classList.remove("escondida");
  window.scrollTo(0, 0);
}
function fecharReceita() { document.getElementById("tela-receita").classList.add("escondida"); }

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
  renderHoje(); renderSemana(); renderBuscar(); renderLista();
  if (VOTOS[id]) enviarVoto(voto, p);
}

function urlDoWorker() { const cfg = LS.get("cfg", {}); return (cfg.worker || WORKER_URL || "").trim(); }

async function enviarVoto(voto, prato) {
  const url = urlDoWorker();
  if (!url) return;
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ voto, receita: prato }) });
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
    if (btn.dataset.aba === "lista") atualizarCompras();
  });
});

const modal = document.getElementById("modal-config");
document.getElementById("btn-config").onclick = () => {
  const cfg = LS.get("cfg", {});
  document.getElementById("cfg-worker").value = cfg.worker || "";
  document.getElementById("cfg-status").textContent = urlDoWorker() ? "Sincronização ativa." : "Sem sincronização (votos ficam só neste aparelho).";
  modal.classList.remove("escondido");
};
document.getElementById("cfg-fechar").onclick = () => modal.classList.add("escondido");
document.getElementById("cfg-salvar").onclick = () => { LS.set("cfg", { worker: document.getElementById("cfg-worker").value.trim() }); modal.classList.add("escondido"); };

iniciar();

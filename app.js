/* =========================================================================
   App de Refeições — Ana & Rafael
   - Lê os dados publicados em ./data/*.json (o app é estático no GitHub Pages).
   - Os cliques de 👍/👎 ficam salvos localmente na hora (resposta instantânea)
     e, se houver token configurado, são enviados ao GitHub para que o agente
     aprenda os gostos (via workflow "registrar-gosto").
   ========================================================================= */

/* >>> DEPOIS DE CRIAR O WORKER, cole a URL dele aqui entre as aspas <<<
   Ex.: "https://cozinha-app.SEU-USUARIO.workers.dev"
   Enquanto estiver vazio, os votos ficam salvos só no aparelho.        */
const WORKER_URL = "https://cozinha-app.brazaorafael.workers.dev";

const LS = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => localStorage.setItem(k, JSON.stringify(v)),
};

// Estado local
let VOTOS = LS.get("votos", {});          // { idReceita: "like" | "dislike" }
let CACHE = LS.get("cache_receitas", {});  // { idReceita: objetoReceita } (curtidas)
let DADOS = { dia: null, lista: null, perfil: null };

// -------------------------------------------------------------------------
// Carregamento dos dados (com "?t=" para evitar cache velho do navegador)
// -------------------------------------------------------------------------
async function carregar(nome) {
  try {
    const r = await fetch(`./data/${nome}.json?t=${Date.now()}`);
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function iniciar() {
  [DADOS.dia, DADOS.lista, DADOS.perfil] = await Promise.all([
    carregar("receitas_do_dia"),
    carregar("lista_final"),
    carregar("perfil_gostos"),
  ]);
  renderHoje();
  renderSemana();
  renderLista();
  renderPerfil();
  const quando = DADOS.dia?.gerado_em;
  document.getElementById("rodape-atualizado").textContent =
    quando && quando !== "exemplo" ? `Atualizado em ${quando}` : "Aguardando a primeira geração de receitas";
}

// -------------------------------------------------------------------------
// Componente: cartão de receita
// -------------------------------------------------------------------------
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function blocoPrato(rotulo, prato) {
  if (!prato) return "";
  const ings = (prato.ingredientes || []).map(i => `<li>${esc(i)}</li>`).join("");
  const passos = (prato.preparo || []).map(p => `<li>${esc(p)}</li>`).join("");
  return `<div class="prato">
    <p class="prato-rotulo">${esc(rotulo)}</p>
    <p class="prato-nome">${esc(prato.nome)}</p>
    <details><summary>Ver ingredientes e preparo</summary>
      <ul>${ings}</ul>
      <ol>${passos}</ol>
    </details></div>`;
}

function cartaoReceita(r) {
  const voto = VOTOS[r.id];
  const tags = (r.tags || []).map(t => `<span class="tag">${esc(t)}</span>`).join("");
  const sobra = r.rende_sobra ? `<span class="sobra">Rende sobra p/ o almoço</span>` : "";
  return `<article class="cartao" data-id="${esc(r.id)}">
    <h3>${esc(r.titulo)}</h3>
    ${r.porque ? `<p class="porque">${esc(r.porque)}</p>` : ""}
    <div class="tags">${tags} ${sobra}</div>
    ${blocoPrato("Entrada", r.entrada)}
    ${blocoPrato("Prato principal", r.principal)}
    ${blocoPrato("Sobremesa", r.sobremesa)}
    <div class="votos">
      <button class="voto ${voto === "like" ? "sel-gostei" : ""}" data-voto="like">👍 Gostei</button>
      <button class="voto ${voto === "dislike" ? "sel-naogostei" : ""}" data-voto="dislike">👎 Não curti</button>
    </div>
  </article>`;
}

// Liga os botões de voto de um container
function ligarVotos(container, indice) {
  container.querySelectorAll(".cartao").forEach(el => {
    const id = el.getAttribute("data-id");
    const receita = indice[id];
    el.querySelectorAll(".voto").forEach(btn => {
      btn.addEventListener("click", () => votar(receita, btn.getAttribute("data-voto")));
    });
  });
}

// -------------------------------------------------------------------------
// Abas
// -------------------------------------------------------------------------
function renderHoje() {
  const alvo = document.getElementById("hoje");
  const receitas = DADOS.dia?.diario?.receitas || [];
  if (!receitas.length) { alvo.innerHTML = `<p class="vazio">Ainda não há receitas de hoje.</p>`; return; }
  alvo.innerHTML = `<h2 class="secao-titulo">Receitas de hoje</h2>` + receitas.map(cartaoReceita).join("");
  const indice = Object.fromEntries(receitas.map(r => [r.id, r]));
  ligarVotos(alvo, indice);
}

function renderSemana() {
  const alvo = document.getElementById("semana");
  const sem = DADOS.dia?.semanal;
  if (!sem || !(sem.dias || []).length) { alvo.innerHTML = `<p class="vazio">O cardápio da semana chega no domingo à noite.</p>`; return; }
  let html = `<h2 class="secao-titulo">Cardápio da semana</h2>`;
  const indice = {};
  sem.dias.forEach(dia => {
    html += `<h3 class="dia-titulo">${esc(dia.dia)}</h3>`;
    (dia.opcoes || []).forEach(r => { indice[r.id] = r; html += cartaoReceita(r); });
  });
  alvo.innerHTML = html;
  ligarVotos(alvo, indice);
}

function itensDaLista() {
  // Une o que veio do GitHub (lista_final.json) com o que foi curtido neste aparelho.
  const doRepo = DADOS.lista?.itens || [];
  const mapa = {};
  doRepo.forEach(r => { mapa[r.id] = r; });
  Object.keys(VOTOS).forEach(id => {
    if (VOTOS[id] === "like" && CACHE[id]) mapa[id] = CACHE[id];
    if (VOTOS[id] === "dislike") delete mapa[id];
  });
  return Object.values(mapa);
}

function renderLista() {
  const alvo = document.getElementById("lista");
  const itens = itensDaLista();
  if (!itens.length) { alvo.innerHTML = `<p class="vazio">Marque 👍 nas receitas que quiser fazer — elas aparecem aqui.</p>`; return; }

  let html = `<h2 class="secao-titulo">Minha lista (${itens.length})</h2>`;
  html += `<div class="btn-linha">
      <button class="btn" id="btn-compras">Gerar lista de compras</button>
      <button class="btn" id="btn-email">Enviar por e-mail</button>
    </div>`;
  html += itens.map(r => `<article class="cartao"><h3>${esc(r.titulo)}</h3>
      ${r.principal ? `<p class="prato-nome">${esc(r.principal.nome)}</p>` : ""}</article>`).join("");
  html += `<div id="area-compras"></div>`;
  alvo.innerHTML = html;

  document.getElementById("btn-compras").onclick = () => mostrarCompras(itens);
  document.getElementById("btn-email").onclick = () => enviarPorEmail(itens);
}

function ingredientesDe(itens) {
  const set = new Map(); // chave normalizada -> texto original
  itens.forEach(r => ["entrada", "principal", "sobremesa"].forEach(k => {
    (r[k]?.ingredientes || []).forEach(i => {
      const chave = i.toLowerCase().trim();
      if (!set.has(chave)) set.set(chave, i.trim());
    });
  }));
  return [...set.values()].sort((a, b) => a.localeCompare(b, "pt-BR"));
}

function mostrarCompras(itens) {
  const lista = ingredientesDe(itens);
  const html = `<h3 class="dia-titulo">Lista de compras</h3><ul class="compras">` +
    lista.map(i => `<li><input type="checkbox"> ${esc(i)}</li>`).join("") + `</ul>`;
  document.getElementById("area-compras").innerHTML = html;
}

function enviarPorEmail(itens) {
  const lista = ingredientesDe(itens);
  const corpo = "Lista de compras da semana:%0D%0A%0D%0A" + lista.map(i => "- " + i).join("%0D%0A");
  const assunto = "Lista de compras — Cozinha Ana & Rafael";
  window.location.href = `mailto:?subject=${encodeURIComponent(assunto)}&body=${corpo}`;
}

function renderPerfil() {
  const alvo = document.getElementById("perfil");
  const p = DADOS.perfil || {};
  const cont = p.contadores || {};
  const pos = Object.entries(cont).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const neg = Object.entries(cont).filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const nCurtidas = (p.curtidas || []).length;
  const nRejeitadas = (p.rejeitadas || []).length;

  let html = `<h2 class="secao-titulo">O que o app aprendeu</h2>`;
  html += `<p class="ajuda">${nCurtidas} receitas curtidas · ${nRejeitadas} rejeitadas</p>`;
  if (p.resumo) html += `<p>${esc(p.resumo)}</p>`;
  if (pos.length) html += `<p class="prato-rotulo">Vocês tendem a curtir</p><div class="chip-grid">` +
    pos.map(([k]) => `<span class="chip pos">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
  if (neg.length) html += `<p class="prato-rotulo">Costumam evitar</p><div class="chip-grid">` +
    neg.map(([k]) => `<span class="chip neg">${esc(k.replace(/_/g, " "))}</span>`).join("") + `</div>`;
  if (!pos.length && !neg.length) html += `<p class="vazio">Comece marcando 👍/👎 nas receitas para o app conhecer vocês.</p>`;
  alvo.innerHTML = html;
}

// -------------------------------------------------------------------------
// Votar (local imediato + envio ao GitHub se configurado)
// -------------------------------------------------------------------------
async function votar(receita, voto) {
  if (!receita) return;
  // alterna: clicar de novo no mesmo voto cancela
  VOTOS[receita.id] = (VOTOS[receita.id] === voto) ? undefined : voto;
  if (VOTOS[receita.id] === undefined) delete VOTOS[receita.id];
  if (VOTOS[receita.id] === "like") CACHE[receita.id] = receita; else delete CACHE[receita.id];
  LS.set("votos", VOTOS); LS.set("cache_receitas", CACHE);

  // re-render rápido
  renderHoje(); renderSemana(); renderLista();

  // envia ao mini-servidor (Worker) para o agente aprender
  if (VOTOS[receita.id]) enviarVoto(voto, receita);
}

function urlDoWorker() {
  const cfg = LS.get("cfg", {});
  return (cfg.worker || WORKER_URL || "").trim();
}

async function enviarVoto(voto, receita) {
  const url = urlDoWorker();
  if (!url) return; // sem servidor configurado -> fica só local
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voto, receita }),
    });
    if (!r.ok) console.warn("Falha ao sincronizar voto:", r.status);
  } catch (e) { console.warn("Sem rede para sincronizar:", e); }
}

// -------------------------------------------------------------------------
// Navegação por abas + modal de configuração
// -------------------------------------------------------------------------
document.querySelectorAll(".aba").forEach(btn => {
  btn.addEventListener("click", () => {
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
  const worker = document.getElementById("cfg-worker").value.trim();
  LS.set("cfg", { worker });
  modal.classList.add("escondido");
};

iniciar();

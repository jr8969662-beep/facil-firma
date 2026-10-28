/* =====================================================================
   Sistema de Firmas — Policía de Salta
   Vistas: acceso, para firmar, pedir firma, mis pedidos, historial,
           mi firma y datos, administración, detalle de una solicitud
   ===================================================================== */
(() => {
"use strict";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const app = $("#app");
const ALTO = window.Documento ? Documento.ALTO : 0.62;
const MAX_MB = 10;

const JERARQUIAS = ["AGENTE", "CABO", "CABO PRIMERO", "SARGENTO", "SARGENTO PRIMERO", "SARGENTO AYUDANTE",
  "SUBOFICIAL PRINCIPAL", "SUBOFICIAL MAYOR", "OFICIAL SUBAYUDANTE", "OFICIAL AYUDANTE", "OFICIAL SUBINSPECTOR",
  "OFICIAL INSPECTOR", "OFICIAL PRINCIPAL", "SUBCOMISARIO", "COMISARIO", "COMISARIO INSPECTOR", "COMISARIO MAYOR", "COMISARIO GENERAL"];
const TIPOS = ["ACTA", "CONSTANCIA", "NOTA", "INFORME", "ELEVACIÓN", "OTRO"];
const ESTADOS = { pendiente: "Pendiente", firmada: "Firmada", rechazada: "Rechazada", cancelada: "Cancelada" };

const ST = { uid: null, sesion: null, perfil: null, firma: null, perfiles: [], canal: null, vista: null };

/* ---------- configuración ---------- */
const C = window.CONFIG || {};
if (!C.SUPABASE_URL || !C.SUPABASE_ANON_KEY || !window.supabase) {
  app.innerHTML = `<div class="card acceso"><h1>Falta configurar el sistema</h1>
    <p class="lead">Completá <span class="mono">config.js</span> con la Project URL y la anon key de Supabase.
    Los pasos están en <span class="mono">LEEME.md</span>.</p></div>`;
  return;
}
// Si alguien abre acá un enlace de "olvidé mi contraseña", va a la página de contraseña nueva
if (/type=recovery|error_code=/.test(location.hash)) { location.replace("nueva-clave.html" + location.hash); return; }
// "implicit": el enlace del correo funciona aunque se abra en otro dispositivo
const sb = supabase.createClient(C.SUPABASE_URL, C.SUPABASE_ANON_KEY, { auth: { flowType: "implicit" } });
if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------- utilidades ---------- */
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fh = d => d ? Documento.fechaHora(d) : "";
const nombre = p => p ? `${p.jerarquia || ""} ${p.nombre || ""} ${p.apellido || ""}`.replace(/\s+/g, " ").trim() : "Usuario dado de baja";
function msg(el, texto, tipo) { if (!el) return; el.className = "msg" + (tipo ? " " + tipo : ""); el.textContent = texto || ""; }
function traducir(e) {
  const m = (e && (e.message || e.error_description || e)) + "";
  if (/Invalid login credentials/i.test(m)) return "Correo o contraseña incorrectos.";
  if (/Email not confirmed/i.test(m)) return "Todavía no confirmaste tu correo. Revisá tu bandeja de entrada (y la carpeta de spam).";
  if (/already registered|already been registered/i.test(m)) return "Ya existe una cuenta con ese correo.";
  if (/at least \d+ characters|Password should/i.test(m)) return "La contraseña tiene que tener al menos 8 caracteres.";
  if (/rate limit|too many/i.test(m)) return "Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "No hay conexión con el servidor. Revisá internet y probá de nuevo.";
  if (/row-level security/i.test(m)) return "No tenés permiso para hacer esto. ¿Tu cuenta ya fue aprobada?";
  return m.replace(/^Error:\s*/, "");
}
async function bytesDe(path) {
  const { data, error } = await sb.storage.from("firma-actas").download(path);
  if (error) throw new Error("No se pudo descargar el documento.");
  return new Uint8Array(await data.arrayBuffer());
}
function descargar(bytes, nombreArchivo) {
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a"); a.href = url; a.download = nombreArchivo;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const archivoNombre = s => `${s.tipo_doc}-${s.titulo}`.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w-]+/g, "-").replace(/-+/g, "-").slice(0, 60);
async function verificarClave(clave) {
  if (!clave) throw new Error("Escribí tu contraseña para confirmar.");
  const { error } = await sb.auth.signInWithPassword({ email: ST.sesion.user.email, password: clave });
  if (error) throw new Error("La contraseña no es correcta.");
}

/* ---------- sesión ---------- */
sb.auth.onAuthStateChange((ev, sesion) => {
  // se difiere para no llamar a Supabase dentro del aviso (evita bloqueos)
  setTimeout(() => {
    const uid = sesion?.user?.id || null;
    if (uid && uid === ST.uid) { ST.sesion = sesion; return; }   // misma persona (ej. confirmó su clave)
    iniciar(sesion);
  }, 0);
});

async function iniciar(sesion) {
  ST.sesion = sesion; ST.uid = sesion?.user?.id || null;
  if (ST.canal) { sb.removeChannel(ST.canal); ST.canal = null; }
  if (!ST.uid) {
    ST.perfil = null; $("#who").hidden = $("#salir").hidden = $("#nav").hidden = true;
    document.title = "Firmas Policía de Salta";
    return vistaAcceso();
  }
  app.innerHTML = `<p class="lead">Cargando tu cuenta…</p>`;
  const { data: perfil, error } = await sb.from("firma_perfiles").select("*").eq("id", ST.uid).maybeSingle();
  if (error || !perfil) {
    app.innerHTML = `<div class="card acceso"><h1>No encontramos tu perfil</h1><p class="lead">${esc(error ? traducir(error) : "Cerrá sesión y volvé a ingresar. Si sigue pasando, avisale al administrador.")}</p></div>`;
    $("#salir").hidden = false; return;
  }
  ST.perfil = perfil;
  await cargarFirma();
  $("#whoName").textContent = nombre(perfil); $("#whoDep").textContent = perfil.dependencia || "";
  $("#who").hidden = $("#salir").hidden = $("#nav").hidden = false;
  $("#navAdmin").hidden = !perfil.es_admin;
  if (perfil.aprobado) {
    const { data } = await sb.from("firma_perfiles").select("id,nombre,apellido,jerarquia,dependencia").eq("aprobado", true).order("apellido");
    ST.perfiles = data || [];
    suscribir(); contarPendientes();
  }
  rutear();
}
async function cargarFirma() {
  const { data } = await sb.from("firma_imagenes").select("imagen,actualizada").eq("usuario_id", ST.uid).maybeSingle();
  ST.firma = data || null;
}
$("#salir").addEventListener("click", async () => { await sb.auth.signOut(); location.hash = ""; });

/* ---------- tiempo real y avisos ---------- */
let recargaPendiente = null;
function suscribir() {
  ST.canal = sb.channel("solicitudes-" + ST.uid)
    .on("postgres_changes", { event: "*", schema: "public", table: "firma_solicitudes" }, p => {
      contarPendientes();
      const n = p.new || {};
      if (p.eventType === "INSERT" && n.firmante_id === ST.uid && n.solicitante_id !== ST.uid) avisar("Nuevo pedido de firma", `${n.tipo_doc} · ${n.titulo}`);
      if (p.eventType === "UPDATE" && n.solicitante_id === ST.uid && n.estado !== "pendiente" && n.firmante_id !== ST.uid)
        avisar(n.estado === "firmada" ? "Te firmaron un pedido" : "Pedido " + (ESTADOS[n.estado] || "").toLowerCase(), `${n.tipo_doc} · ${n.titulo}`);
      if (["para-firmar", "mis-pedidos", "historial"].includes(ST.vista)) {
        clearTimeout(recargaPendiente); recargaPendiente = setTimeout(rutear, 400);
      }
    }).subscribe();
}
function avisar(titulo, cuerpo) {
  try { if ("Notification" in window && Notification.permission === "granted" && document.hidden) new Notification(titulo, { body: cuerpo }); } catch {}
}
async function contarPendientes() {
  const { count } = await sb.from("firma_solicitudes").select("id", { count: "exact", head: true }).eq("firmante_id", ST.uid).eq("estado", "pendiente");
  const b = $("#badge"); b.textContent = count || 0; b.hidden = !count;
  document.title = (count ? `(${count}) ` : "") + "Firmas Policía de Salta";
}

/* ---------- navegación ---------- */
window.addEventListener("hashchange", () => { if (ST.perfil) rutear(); });
function rutear() {
  if (!ST.perfil) return;
  let h = location.hash.replace(/^#/, "");
  if (/access_token|error_description|type=/.test(h)) h = "";
  let [v, id] = h.split("/");
  if (!ST.perfil.aprobado && v !== "mi-firma") v = "mi-firma";
  if (!v || !VISTAS[v] && v !== "solicitud") v = ST.perfil.aprobado ? "para-firmar" : "mi-firma";
  if (v === "admin" && !ST.perfil.es_admin) v = "para-firmar";
  ST.vista = v;
  $$("nav.tabs a").forEach(a => a.setAttribute("aria-current", a.dataset.v === v ? "page" : "false"));
  window.scrollTo(0, 0);
  (v === "solicitud" ? () => vistaSolicitud(id) : VISTAS[v])();
}
function avisosCuenta() {
  let h = "";
  if (!ST.perfil.aprobado) h += `<div class="aviso warn"><b>Tu cuenta espera aprobación.</b> El administrador tiene que habilitarte antes de que puedas pedir o recibir firmas. Mientras tanto, creá tu firma.</div>`;
  if (!ST.firma) h += `<div class="aviso info"><b>Todavía no creaste tu firma.</b> <a href="#mi-firma">Creala ahora</a>: la vas a necesitar para firmar las actas que te pidan.</div>`;
  return h;
}

/* =====================================================================
   ACCESO
   ===================================================================== */
function vistaAcceso(modo = "ingresar") {
  const jer = JERARQUIAS.map(j => `<option value="${j}">`).join("");
  app.innerHTML = `
  <div class="acceso" style="display:flex;flex-direction:column;gap:16px">
    <div><h1>Firmas de actas y constancias</h1>
    <p class="lead">Pedí y aprobá firmas a distancia, con registro de cada documento firmado.</p></div>
    <div class="card">
      <div class="seg" role="group"><button data-m="ingresar" aria-pressed="${modo === "ingresar"}">Ingresar</button><button data-m="registro" aria-pressed="${modo === "registro"}">Crear cuenta</button></div>
      <form id="fIngresar" ${modo !== "ingresar" ? "hidden" : ""} style="display:flex;flex-direction:column;gap:12px">
        <label class="f">Correo <input class="i" id="inEmail" type="email" autocomplete="email" required></label>
        <label class="f">Contraseña <input class="i" id="inClave" type="password" autocomplete="current-password" required></label>
        <div class="row"><button class="btn pri" type="submit">Ingresar</button><span class="sp"></span><a href="nueva-clave.html">Olvidé mi contraseña</a></div>
        <div class="msg" id="mIn" role="status"></div>
      </form>
      <form id="fRegistro" ${modo !== "registro" ? "hidden" : ""} style="display:flex;flex-direction:column;gap:12px">
        <div class="grid">
          <label class="f">Nombre/s <input class="i may" id="rNom" required autocomplete="given-name"></label>
          <label class="f">Apellido/s <input class="i may" id="rApe" required autocomplete="family-name"></label>
          <label class="f">Jerarquía <input class="i may" id="rJer" list="jer" required placeholder="Ej: COMISARIO"></label>
          <label class="f">Dependencia <input class="i may" id="rDep" required placeholder="Ej: COMISARÍA 17 DE OCTUBRE"></label>
          <label class="f">Legajo (opcional) <input class="i may" id="rLeg"></label>
          <label class="f">Correo <input class="i" id="rEmail" type="email" required autocomplete="email"></label>
          <label class="f">Contraseña <input class="i" id="rClave" type="password" minlength="8" required autocomplete="new-password"></label>
          <label class="f">Repetí la contraseña <input class="i" id="rClave2" type="password" minlength="8" required autocomplete="new-password"></label>
        </div>
        <datalist id="jer">${jer}</datalist>
        <p class="lead" style="margin:0;font-size:13.5px">Tu nombre y apellido no se pueden cambiar después: escribilos igual que en tu credencial. El administrador tiene que aprobar la cuenta.</p>
        <div class="row"><button class="btn pri" type="submit">Crear cuenta</button></div>
        <div class="msg" id="mReg" role="status"></div>
      </form>
    </div>
  </div>`;
  $$(".seg button", app).forEach(b => b.onclick = () => vistaAcceso(b.dataset.m));
  $("#fIngresar").onsubmit = async e => {
    e.preventDefault(); const m = $("#mIn"); msg(m, "Ingresando…");
    const { error } = await sb.auth.signInWithPassword({ email: $("#inEmail").value.trim(), password: $("#inClave").value });
    if (error) msg(m, traducir(error), "err");
  };
  $("#fRegistro").onsubmit = async e => {
    e.preventDefault(); const m = $("#mReg");
    if ($("#rClave").value !== $("#rClave2").value) return msg(m, "Las contraseñas no coinciden.", "err");
    msg(m, "Creando la cuenta…");
    const U = id => $(id).value.trim().toUpperCase();
    const { data, error } = await sb.auth.signUp({
      email: $("#rEmail").value.trim(), password: $("#rClave").value,
      options: { emailRedirectTo: location.href.split("#")[0], data: { app: "firmas", nombre: U("#rNom"), apellido: U("#rApe"), jerarquia: U("#rJer"), dependencia: U("#rDep"), legajo: U("#rLeg") } }
    });
    if (error) return msg(m, traducir(error), "err");
    if (!data.session) msg(m, "Listo. Te mandamos un correo para confirmar la cuenta: abrí el enlace y después ingresá.", "ok");
  };
}
/* =====================================================================
   LISTAS
   ===================================================================== */
const SEL = "*, solicitante:firma_perfiles!firma_solicitudes_solicitante_id_fkey(nombre,apellido,jerarquia,dependencia), firmante:firma_perfiles!firma_solicitudes_firmante_id_fkey(nombre,apellido,jerarquia,dependencia)";
function firmanteDe(s) { return s.firmante_datos || s.firmante; }
function itemHTML(s, rol) {
  const quien = rol === "firmante"
    ? `Pedido por <b>${esc(nombre(s.solicitante))}</b>${s.solicitante?.dependencia ? " · " + esc(s.solicitante.dependencia) : ""}`
    : `Para <b>${esc(nombre(firmanteDe(s)))}</b>`;
  const fechas = `Pedido el ${fh(s.creada)}` + (s.resuelta ? ` · ${ESTADOS[s.estado]} el ${fh(s.resuelta)}` : "");
  return `<a class="item" href="#solicitud/${s.id}">
    <span class="t">${esc(s.tipo_doc)} · ${esc(s.titulo)}</span><span class="chip ${s.estado}">${ESTADOS[s.estado]}</span>
    <span class="s">${quien}<br>${fechas}</span>
    ${rol === "firmante" && s.estado === "pendiente" && s.mensaje ? `<span class="m">${esc(s.mensaje)}</span>` : ""}
    ${s.estado === "rechazada" && s.motivo ? `<span class="m">Motivo: ${esc(s.motivo)}</span>` : ""}
  </a>`;
}
function filtroSeg(opciones, actual) {
  return `<div class="seg" role="group" id="filtro">${opciones.map(([v, t]) => `<button data-f="${v}" aria-pressed="${v === actual}">${t}</button>`).join("")}</div>`;
}

async function vistaParaFirmar() {
  app.innerHTML = `${avisosCuenta()}<div><h1>Para firmar</h1><p class="lead">Pedidos de firma que te hicieron y todavía no respondiste.</p></div><div class="lista" id="lista"><p class="lead">Cargando…</p></div>`;
  const { data, error } = await sb.from("firma_solicitudes").select(SEL).eq("firmante_id", ST.uid).eq("estado", "pendiente").order("creada");
  const l = $("#lista"); if (!l) return;
  if (error) return l.innerHTML = `<div class="aviso bad">${esc(traducir(error))}</div>`;
  const notif = ("Notification" in window && Notification.permission === "default")
    ? `<div class="aviso info" style="align-items:center"><span>Activá los avisos para enterarte cuando te pidan una firma (con la página abierta).</span><span class="sp"></span><button class="btn" id="activarAvisos">Activar avisos</button></div>` : "";
  l.innerHTML = notif + (data.length ? data.map(s => itemHTML(s, "firmante")).join("")
    : `<div class="vacio"><b>No tenés pedidos pendientes</b>Cuando alguien te pida una firma, va a aparecer acá.</div>`);
  const b = $("#activarAvisos"); if (b) b.onclick = async () => { try { await Notification.requestPermission(); } catch {} vistaParaFirmar(); };
}

async function vistaMisPedidos(f = "todos") {
  app.innerHTML = `${avisosCuenta()}<div class="row"><div><h1>Mis pedidos</h1><p class="lead">Firmas que pediste y en qué estado están.</p></div><span class="sp"></span><a class="btn pri" href="#pedir">Pedir una firma</a></div>
    ${filtroSeg([["todos", "Todos"], ["pendiente", "Pendientes"], ["firmada", "Firmados"], ["rechazada", "Rechazados"]], f)}
    <div class="lista" id="lista"><p class="lead">Cargando…</p></div>`;
  $$("#filtro button").forEach(b => b.onclick = () => vistaMisPedidos(b.dataset.f));
  let q = sb.from("firma_solicitudes").select(SEL).eq("solicitante_id", ST.uid).order("creada", { ascending: false }).limit(300);
  if (f !== "todos") q = q.eq("estado", f);
  const { data, error } = await q; const l = $("#lista"); if (!l) return;
  if (error) return l.innerHTML = `<div class="aviso bad">${esc(traducir(error))}</div>`;
  l.innerHTML = data.length ? data.map(s => itemHTML(s, "solicitante")).join("")
    : `<div class="vacio"><b>No hay pedidos ${f === "todos" ? "todavía" : "en este estado"}</b>Usá “Pedir una firma” para mandar un acta a firmar.</div>`;
}

async function vistaHistorial(f = "todos", texto = "") {
  app.innerHTML = `${avisosCuenta()}<div><h1>Historial de mi firma</h1><p class="lead">Todo lo que se firmó con tu firma o que rechazaste: quién lo pidió, cuándo, y el documento para volver a verlo.</p></div>
    <div class="row">${filtroSeg([["todos", "Todo"], ["firmada", "Firmados"], ["rechazada", "Rechazados"]], f)}<span class="sp"></span>
    <input class="i" id="buscar" placeholder="Buscar por título o por quién lo pidió" style="max-width:340px" value="${esc(texto)}"></div>
    <div id="resumen" class="eyebrow"></div><div class="lista" id="lista"><p class="lead">Cargando…</p></div>`;
  const { data, error } = await sb.from("firma_solicitudes").select(SEL).eq("firmante_id", ST.uid).in("estado", ["firmada", "rechazada"]).order("resuelta", { ascending: false }).limit(1000);
  const l = $("#lista"); if (!l) return;
  if (error) return l.innerHTML = `<div class="aviso bad">${esc(traducir(error))}</div>`;
  const pintar = () => {
    const t = norm($("#buscar").value.trim()), fil = $("#filtro button[aria-pressed=true]").dataset.f;
    const vis = data.filter(s => (fil === "todos" || s.estado === fil) && (!t || norm(`${s.tipo_doc} ${s.titulo} ${nombre(s.solicitante)}`).includes(t)));
    const nf = data.filter(s => s.estado === "firmada").length;
    $("#resumen").textContent = `${nf} firmado${nf === 1 ? "" : "s"} · ${data.length - nf} rechazado${data.length - nf === 1 ? "" : "s"}`;
    l.innerHTML = vis.length ? vis.map(s => itemHTML(s, "firmante")).join("")
      : `<div class="vacio"><b>${data.length ? "No hay resultados" : "Todavía no firmaste nada"}</b>${data.length ? "Probá con otra búsqueda." : "Cuando apruebes o rechaces un pedido, va a quedar registrado acá."}</div>`;
  };
  $$("#filtro button").forEach(b => b.onclick = () => { $$("#filtro button").forEach(x => x.setAttribute("aria-pressed", x === b)); pintar(); });
  $("#buscar").oninput = pintar; pintar();
}

/* =====================================================================
   VISOR DE PDF (con la caja de la firma)
   ===================================================================== */
async function mostrarPdf(cont, bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise;
  cont.innerHTML = ""; const hojas = [];
  const ancho = Math.max(240, Math.min(cont.clientWidth - 24, 820));
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i), v1 = pg.getViewport({ scale: 1 }), esc1 = ancho / v1.width;
    const vp = pg.getViewport({ scale: esc1 * dpr });
    const div = document.createElement("div"); div.className = "hoja"; div.style.width = ancho + "px";
    const cv = document.createElement("canvas"); cv.width = vp.width; cv.height = vp.height;
    div.appendChild(cv); div.insertAdjacentHTML("beforeend", `<span class="num">Hoja ${i} de ${pdf.numPages}</span>`);
    cont.appendChild(div);
    await pg.render({ canvasContext: cv.getContext("2d"), viewport: vp }).promise;
    hojas.push({ div, w: v1.width, h: v1.height, k: esc1 });
  }
  return hojas;
}
async function medirPdf(bytes) {
  const pdf = await pdfjsLib.getDocument({ data: bytes.slice(0) }).promise, out = [];
  for (let i = 1; i <= pdf.numPages; i++) { const v = (await pdf.getPage(i)).getViewport({ scale: 1 }); out.push({ w: v.width, h: v.height }); }
  return out;
}
function ponerCaja(hojas, pos, etiqueta, editable, alMover) {
  $$(".caja").forEach(n => n.remove());
  const H = hojas[Math.min(pos.pagina, hojas.length - 1)]; if (!H) return;
  pos.pw = H.w; pos.ph = H.h;
  const lim = () => { pos.w = Math.max(70, Math.min(pos.w, H.w - 4)); pos.x = Math.max(0, Math.min(pos.x, H.w - pos.w)); pos.y = Math.max(0, Math.min(pos.y, H.h - pos.w * ALTO)); };
  lim();
  const el = document.createElement("div"); el.className = "caja" + (editable ? " mov" : "");
  el.innerHTML = `<span>${etiqueta}</span>` + (editable ? `<span class="h" aria-hidden="true"></span>` : "");
  const pintar = () => Object.assign(el.style, { left: pos.x * H.k + "px", top: pos.y * H.k + "px", width: pos.w * H.k + "px", height: pos.w * ALTO * H.k + "px", fontSize: Math.max(8, pos.w * H.k / 16) + "px" });
  pintar(); H.div.appendChild(el);
  if (!editable) return;
  let d = null;
  el.addEventListener("pointerdown", e => { e.preventDefault(); el.setPointerCapture(e.pointerId); d = { r: e.target.classList.contains("h"), sx: e.clientX, sy: e.clientY, o: { ...pos } }; });
  el.addEventListener("pointermove", e => {
    if (!d) return; const dx = (e.clientX - d.sx) / H.k, dy = (e.clientY - d.sy) / H.k;
    if (d.r) pos.w = d.o.w + dx; else { pos.x = d.o.x + dx; pos.y = d.o.y + dy; }
    lim(); pintar();
  });
  ["pointerup", "pointercancel"].forEach(t => el.addEventListener(t, () => { if (d) { d = null; alMover && alMover(); } }));
}

/* =====================================================================
   PEDIR FIRMA
   ===================================================================== */
async function vistaPedir() {
  const B = { origen: "texto", bytes: null, posicion: null, firmante: null, hojas: null };
  const hoy = "Salta, " + new Date().toLocaleDateString("es-AR", { timeZone: "America/Argentina/Salta", day: "numeric", month: "long", year: "numeric" });
  app.innerHTML = `${avisosCuenta()}
  <div><h1>Pedir una firma</h1><p class="lead">Escribí el acta o subí un PDF, elegí quién la firma y marcá dónde va la firma. Esa persona la lee y la aprueba o la rechaza.</p></div>
  <div class="card">
    <div class="grid">
      <label class="f">Tipo de documento <select class="i" id="pTipo">${TIPOS.map(t => `<option>${t}</option>`).join("")}</select></label>
      <label class="f" style="grid-column:span 2">Título o asunto <input class="i may" id="pTit" maxlength="140" placeholder="Ej: SECUESTRO DE MOTOCICLETA DOMINIO A123BCD"></label>
    </div>
    <div class="f" style="display:flex;flex-direction:column;gap:6px">
      <label class="f" for="pBus">Quién tiene que firmar</label>
      <div id="pElegido" hidden></div>
      <input class="i" id="pBus" placeholder="Buscá por apellido, jerarquía o dependencia" autocomplete="off">
      <div class="lista" id="pRes" style="gap:6px"></div>
    </div>
    <label class="f">Mensaje para quien firma (opcional) <input class="i" id="pMsg" maxlength="300" placeholder="Ej: Jefe, es el acta del procedimiento de hoy a la mañana"></label>
  </div>
  <div class="card">
    <div class="row"><h2>Documento</h2><span class="sp"></span>
      <div class="seg" role="group" id="pOri"><button data-o="texto" aria-pressed="true">Escribir acta</button><button data-o="pdf" aria-pressed="false">Subir PDF</button></div></div>
    <div id="oTexto" style="display:flex;flex-direction:column;gap:12px">
      <label class="f">Lugar y fecha <input class="i" id="pLug" value="${esc(hoy)}"></label>
      <label class="f">Texto del documento <textarea class="i" id="pCue" placeholder="En la ciudad de Salta, a los … días del mes de … , siendo las … horas, el funcionario que suscribe …"></textarea></label>
      <div class="row"><button class="btn" id="pGen">Ver cómo queda y ubicar la firma</button></div>
    </div>
    <div id="oPdf" hidden style="display:flex;flex-direction:column;gap:10px">
      <label class="f">Archivo PDF (hasta ${MAX_MB} MB) <input class="i" id="pFile" type="file" accept="application/pdf"></label>
    </div>
    <div class="msg" id="pMsgDoc" role="status"></div>
  </div>
  <div class="card" id="pPrev" hidden>
    <div class="row"><h2>Dónde va la firma</h2><span class="sp"></span><label class="f" style="flex-direction:row;align-items:center;gap:8px">Hoja <select class="i" id="pHoja" style="width:auto"></select></label></div>
    <p class="lead" style="margin:0">Arrastrá el recuadro hasta donde tiene que ir la firma. Con el punto de la esquina lo agrandás o achicás.</p>
    <div class="visor" id="pVisor"></div>
    <div class="row"><span class="sp"></span><button class="btn pri" id="pEnviar">Enviar pedido de firma</button></div>
    <div class="msg" id="pMsgEnv" role="status"></div>
  </div>`;

  // --- elegir firmante
  const pintarElegido = () => {
    const e = $("#pElegido"), p = B.firmante;
    e.hidden = !p; $("#pBus").hidden = !!p; $("#pRes").innerHTML = "";
    if (p) e.innerHTML = `<div class="item" style="cursor:default"><span class="t">${esc(nombre(p))}${p.id === ST.uid ? " (vos)" : ""}</span><button class="btn" id="pCambiar">Cambiar</button><span class="s">${esc(p.dependencia)}</span></div>`;
    if (p) $("#pCambiar").onclick = () => { B.firmante = null; pintarElegido(); actualizarCaja(); $("#pBus").focus(); };
  };
  $("#pBus").oninput = () => {
    const t = norm($("#pBus").value.trim()), r = $("#pRes");
    if (t.length < 2) return r.innerHTML = "";
    const res = ST.perfiles.filter(p => norm(nombre(p) + " " + p.dependencia).includes(t)).slice(0, 8);
    r.innerHTML = res.length ? res.map(p => `<button class="item" data-id="${p.id}" style="text-align:left;font:inherit"><span class="t">${esc(nombre(p))}${p.id === ST.uid ? " (vos)" : ""}</span><span class="s">${esc(p.dependencia)}</span></button>`).join("")
      : `<p class="lead" style="margin:0">No hay nadie habilitado con ese nombre. Si es una cuenta nueva, tiene que aprobarla el administrador.</p>`;
    $$("button.item", r).forEach(b => b.onclick = () => { B.firmante = ST.perfiles.find(p => p.id === b.dataset.id); pintarElegido(); actualizarCaja(); });
  };

  // --- origen
  $$("#pOri button").forEach(b => b.onclick = () => {
    $$("#pOri button").forEach(x => x.setAttribute("aria-pressed", x === b));
    B.origen = b.dataset.o; $("#oTexto").hidden = B.origen !== "texto"; $("#oPdf").hidden = B.origen !== "pdf";
    B.bytes = null; $("#pPrev").hidden = true; msg($("#pMsgDoc"), "");
  });
  const invalidar = () => { if (B.origen === "texto" && B.bytes) { B.bytes = null; $("#pPrev").hidden = true; msg($("#pMsgDoc"), "Cambiaste el texto: tocá “Ver cómo queda” de nuevo antes de enviar."); } };
  ["#pCue", "#pLug", "#pTit", "#pTipo"].forEach(s => $(s).addEventListener("input", invalidar));

  const etiqueta = () => B.firmante ? `Firma de<br>${esc(nombre(B.firmante))}` : "Firma";
  function actualizarCaja() { if (B.hojas && B.posicion) ponerCaja(B.hojas, B.posicion, etiqueta(), true); }
  async function previsualizar() {
    $("#pPrev").hidden = false;
    B.hojas = await mostrarPdf($("#pVisor"), B.bytes);
    const sel = $("#pHoja"); sel.innerHTML = B.hojas.map((_, i) => `<option value="${i}">${i + 1}</option>`).join("");
    sel.value = B.posicion.pagina; sel.onchange = () => { B.posicion.pagina = +sel.value; actualizarCaja(); B.hojas[B.posicion.pagina].div.scrollIntoView({ block: "nearest" }); };
    actualizarCaja();
    B.hojas[B.posicion.pagina].div.scrollIntoView({ block: "center" });
  }
  $("#pGen").onclick = async () => {
    const m = $("#pMsgDoc");
    if (!$("#pCue").value.trim()) return msg(m, "Escribí el texto del documento.", "err");
    msg(m, "Armando el documento…");
    try {
      const r = await Documento.crearActa({ tipo: $("#pTipo").value, titulo: $("#pTit").value.trim(), dependencia: ST.perfil.dependencia, lugarFecha: $("#pLug").value.trim(), cuerpo: $("#pCue").value });
      B.bytes = r.bytes; B.posicion = r.posicion; msg(m, ""); await previsualizar();
    } catch (e) { msg(m, "No se pudo armar el documento: " + traducir(e), "err"); }
  };
  $("#pFile").onchange = async e => {
    const f = e.target.files[0], m = $("#pMsgDoc"); if (!f) return;
    if (f.size > MAX_MB * 1048576) return msg(m, `El archivo pesa más de ${MAX_MB} MB.`, "err");
    msg(m, "Abriendo el PDF…");
    try {
      B.bytes = new Uint8Array(await f.arrayBuffer());
      const hojas = await medirPdf(B.bytes).catch(() => null);
      if (!hojas) throw new Error("No es un PDF válido o tiene contraseña.");
      const u = hojas.length - 1, w = Math.min(190, hojas[u].w * .34);
      B.posicion = { pagina: u, w, x: hojas[u].w - w - 50, y: hojas[u].h - w * ALTO - 70 };
      if (!$("#pTit").value.trim()) $("#pTit").value = f.name.replace(/\.pdf$/i, "").toUpperCase();
      msg(m, ""); await previsualizar();
    } catch (err) { B.bytes = null; $("#pPrev").hidden = true; msg(m, traducir(err), "err"); }
  };

  // --- enviar
  $("#pEnviar").onclick = async () => {
    const m = $("#pMsgEnv"), btn = $("#pEnviar");
    const titulo = $("#pTit").value.trim().toUpperCase();
    if (!titulo) return msg(m, "Falta el título o asunto.", "err");
    if (!B.firmante) return msg(m, "Elegí quién tiene que firmar.", "err");
    if (!B.bytes) return msg(m, "Falta el documento.", "err");
    btn.disabled = true; msg(m, "Enviando…");
    const id = crypto.randomUUID(), ruta = `${id}/original.pdf`;
    try {
      const hash = await Documento.sha256(B.bytes);
      const pos = { pagina: B.posicion.pagina, x: +B.posicion.x.toFixed(2), y: +B.posicion.y.toFixed(2), w: +B.posicion.w.toFixed(2), pw: B.posicion.pw, ph: B.posicion.ph };
      const { error } = await sb.from("firma_solicitudes").insert({
        id, solicitante_id: ST.uid, firmante_id: B.firmante.id, tipo_doc: $("#pTipo").value, titulo,
        mensaje: $("#pMsg").value.trim() || null, origen: B.origen, pdf_original: ruta, hash_original: hash, posicion: pos });
      if (error) throw error;
      const up = await sb.storage.from("firma-actas").upload(ruta, new Blob([B.bytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
      if (up.error) { await sb.rpc("firma_cancelar", { p_id: id }); throw new Error("No se pudo subir el documento. El pedido se canceló; probá de nuevo."); }
      location.hash = "#solicitud/" + id;
    } catch (e) { btn.disabled = false; msg(m, traducir(e), "err"); }
  };
}

/* =====================================================================
   DETALLE DE UNA SOLICITUD (leer, firmar, rechazar, cancelar, descargar)
   ===================================================================== */
async function vistaSolicitud(id) {
  app.innerHTML = `<p class="lead">Cargando…</p>`;
  const { data: s, error } = await sb.from("firma_solicitudes").select(SEL).eq("id", id).maybeSingle();
  if (error || !s) { app.innerHTML = `<div class="card"><h1>No encontramos ese pedido</h1><p class="lead">No existe o no tenés acceso.</p><div><a class="btn" href="#para-firmar">Volver</a></div></div>`; return; }
  const soyFirmante = s.firmante_id === ST.uid, soySolicitante = s.solicitante_id === ST.uid;
  const volver = soyFirmante && s.estado !== "pendiente" ? "#historial" : soyFirmante ? "#para-firmar" : "#mis-pedidos";
  const f = firmanteDe(s);
  const acciones = soyFirmante && s.estado === "pendiente" ? (ST.firma ? `
      <div class="card" id="aFirmar">
        <h2>Tu respuesta</h2>
        <label class="row" style="gap:10px;align-items:flex-start;font-size:14px"><input type="checkbox" id="aLei" style="margin-top:3px;width:18px;height:18px"> <span>Leí el documento completo y estoy de acuerdo con su contenido.</span></label>
        <label class="f">Tu contraseña, para confirmar que sos vos <input class="i" id="aClave" type="password" autocomplete="current-password"></label>
        <div class="row"><button class="btn ok" id="aAprobar">Aprobar y firmar</button><button class="btn bad" id="aRechazar">Rechazar</button></div>
        <div id="aRech" hidden style="display:flex;flex-direction:column;gap:8px">
          <label class="f">Motivo del rechazo <textarea class="i" id="aMotivo" style="min-height:80px" placeholder="Ej: corregir el domicilio del testigo"></textarea></label>
          <div class="row"><button class="btn bad" id="aConfRech">Confirmar rechazo</button></div>
        </div>
        <div class="msg" id="aMsg" role="status"></div>
      </div>` : `<div class="aviso warn">Para firmar, primero <a href="#mi-firma">creá tu firma</a>.</div>`)
    : soySolicitante && s.estado === "pendiente" ? `<div class="card"><p class="lead" style="margin:0">Esperando que ${esc(nombre(f))} lo lea y responda.</p>
        <div class="row"><button class="btn bad" id="aCancelar">Cancelar pedido</button></div><div class="msg" id="aMsg"></div></div>` : "";

  app.innerHTML = `
    <div class="row"><a class="btn" href="${volver}">← Volver</a></div>
    <div><div class="eyebrow">${esc(s.tipo_doc)}</div><h1>${esc(s.titulo)}</h1></div>
    <div class="split">
      <div style="display:flex;flex-direction:column;gap:10px;min-width:0">
        <div class="visor" id="visor"><p class="lead">Cargando el documento…</p></div>
      </div>
      <div class="sticky" style="display:flex;flex-direction:column;gap:14px">
        <div class="card">
          <div class="row"><span class="chip ${s.estado}">${ESTADOS[s.estado]}</span></div>
          <dl class="datos">
            <dt>Pedido por</dt><dd>${esc(nombre(s.solicitante))}<br><span style="color:var(--muted)">${esc(s.solicitante?.dependencia || "")}</span></dd>
            <dt>Firma</dt><dd>${esc(nombre(f))}</dd>
            <dt>Pedido el</dt><dd>${fh(s.creada)}</dd>
            ${s.resuelta ? `<dt>${ESTADOS[s.estado]} el</dt><dd>${fh(s.resuelta)}</dd>` : ""}
            ${s.estado === "firmada" ? `<dt>Código</dt><dd class="mono">${esc(s.codigo)}</dd>` : ""}
            ${s.mensaje ? `<dt>Mensaje</dt><dd>${esc(s.mensaje)}</dd>` : ""}
            ${s.motivo ? `<dt>Motivo</dt><dd>${esc(s.motivo)}</dd>` : ""}
          </dl>
          <div class="row">
            ${s.estado === "firmada" ? `<button class="btn pri" id="dFirm">Descargar firmado</button>` : ""}
            <button class="btn" id="dOrig">Descargar original</button>
          </div>
          ${s.estado === "firmada" ? `<a href="verificar.html?c=${encodeURIComponent(s.codigo)}" target="_blank" rel="noopener" style="font-size:13.5px">Ver la página de verificación</a>` : ""}
        </div>
        ${acciones}
      </div>
    </div>`;

  let original = null, firmado = null;
  const visor = $("#visor");
  try {
    original = await bytesDe(s.pdf_original);
    if (s.estado === "firmada" && s.pdf_firmado) firmado = await bytesDe(s.pdf_firmado);
    const hashOk = (await Documento.sha256(original)) === s.hash_original;
    if (!hashOk) {
      visor.innerHTML = `<div class="aviso bad">El archivo guardado no coincide con el que se envió. No se puede firmar. Avisale al administrador.</div>`;
      $$("#aAprobar").forEach(b => b.disabled = true); original = null;
    } else {
      const hojas = await mostrarPdf(visor, firmado || original);
      if (s.estado === "pendiente") ponerCaja(hojas, { ...s.posicion }, `Acá va la firma de<br>${esc(nombre(f))}`, false);
    }
  } catch (e) { visor.innerHTML = `<div class="aviso bad">${esc(traducir(e))}</div>`; }

  const nom = archivoNombre(s);
  $("#dOrig").onclick = () => original ? descargar(original, nom + ".pdf") : null;
  const dF = $("#dFirm"); if (dF) dF.onclick = () => firmado && descargar(firmado, nom + "-firmado.pdf");

  // --- cancelar (quien pidió)
  const bc = $("#aCancelar");
  if (bc) bc.onclick = async () => {
    if (!bc.dataset.ok) { bc.dataset.ok = 1; bc.textContent = "Sí, cancelar el pedido"; return; }
    bc.disabled = true; const { error } = await sb.rpc("firma_cancelar", { p_id: s.id });
    if (error) { bc.disabled = false; return msg($("#aMsg"), traducir(error), "err"); }
    vistaSolicitud(s.id);
  };
  if (!$("#aFirmar")) return;

  // --- rechazar
  $("#aRechazar").onclick = () => { $("#aRech").hidden = false; $("#aMotivo").focus(); };
  $("#aConfRech").onclick = async () => {
    const b = $("#aConfRech"), m = $("#aMsg");
    if (!$("#aMotivo").value.trim()) return msg(m, "Escribí el motivo, así quien lo pidió sabe qué corregir.", "err");
    b.disabled = true;
    const { error } = await sb.rpc("firma_rechazar", { p_id: s.id, p_motivo: $("#aMotivo").value.trim() });
    if (error) { b.disabled = false; return msg(m, traducir(error), "err"); }
    contarPendientes(); vistaSolicitud(s.id);
  };

  // --- aprobar y firmar
  $("#aAprobar").onclick = async () => {
    const b = $("#aAprobar"), m = $("#aMsg");
    if (!original) return msg(m, "El documento no se cargó.", "err");
    if (!$("#aLei").checked) return msg(m, "Marcá que leíste el documento.", "err");
    b.disabled = true;
    try {
      msg(m, "Confirmando tu identidad…");
      await verificarClave($("#aClave").value);
      msg(m, "Firmando…");
      await cargarFirma();
      if (!ST.firma) throw new Error("No encontramos tu firma. Creala en “Mi firma y datos”.");
      const png = new Uint8Array(await (await fetch(ST.firma.imagen)).arrayBuffer());
      const ahora = Date.now();
      const url = new URL("verificar.html?c=" + encodeURIComponent(s.codigo), location.href).href;
      const bytes = await Documento.firmar(original, { posicion: s.posicion, firmaPng: png, codigo: s.codigo, urlVerificar: url, fecha: ahora, firmante: ST.perfil });
      const hashF = await Documento.sha256(bytes), ruta = `${s.id}/firmado-${ahora}.pdf`;
      const up = await sb.storage.from("firma-actas").upload(ruta, new Blob([bytes], { type: "application/pdf" }), { contentType: "application/pdf", upsert: false });
      if (up.error) throw new Error("No se pudo guardar el documento firmado. Probá de nuevo.");
      const { error } = await sb.rpc("firma_aprobar", { p_id: s.id, p_hash_leido: s.hash_original, p_pdf_firmado: ruta, p_hash_firmado: hashF });
      if (error) throw error;
      contarPendientes(); vistaSolicitud(s.id);
    } catch (e) { b.disabled = false; msg(m, traducir(e), "err"); }
  };
}

/* =====================================================================
   MI FIRMA Y DATOS
   ===================================================================== */
async function vistaMiFirma() {
  const p = ST.perfil;
  app.innerHTML = `${avisosCuenta()}
  <div><h1>Mi firma y datos</h1><p class="lead">Solo vos podés ver y cambiar tu firma. Cada cambio queda registrado, y los documentos que ya firmaste no se modifican.</p></div>
  <div class="card">
    <h2>${ST.firma ? "Tu firma actual" : "Creá tu firma"}</h2>
    ${ST.firma ? `<div class="firma-actual"><img alt="Tu firma" src="${ST.firma.imagen}"></div><p class="lead" style="margin:0;font-size:13.5px">Guardada el ${fh(ST.firma.actualizada)}. Si la querés rehacer, dibujala de nuevo abajo.</p>` : ""}
    <div class="pad" id="pad"><canvas id="cv"></canvas><div class="base"></div><div class="hint" id="hint">Firmá sobre la línea con el dedo o el mouse</div></div>
    <div class="row"><button class="btn" id="fDes">Deshacer</button><button class="btn" id="fBor">Borrar</button></div>
    ${ST.firma ? `<label class="f">Tu contraseña, para confirmar el cambio <input class="i" id="fClave" type="password" autocomplete="current-password"></label>` : ""}
    <div class="row"><button class="btn pri" id="fGuardar" disabled>${ST.firma ? "Reemplazar mi firma" : "Guardar mi firma"}</button></div>
    <div class="msg" id="fMsg" role="status"></div>
  </div>
  <div class="card">
    <h2>Mis datos</h2>
    <p class="lead" style="margin:0;font-size:13.5px">Así aparecen debajo de tu firma. Si cambia tu jerarquía o tu destino, actualizalos acá. Para corregir el nombre, pedíselo al administrador.</p>
    <dl class="datos"><dt>Nombre</dt><dd>${esc(p.nombre)} ${esc(p.apellido)}</dd><dt>Correo</dt><dd>${esc(p.email)}</dd>
      <dt>Cuenta</dt><dd>${p.aprobado ? "Habilitada" : "Esperando aprobación"}${p.es_admin ? " · Administrador" : ""}</dd></dl>
    <div class="grid">
      <label class="f">Jerarquía <input class="i may" id="dJer" list="jer2" value="${esc(p.jerarquia)}"></label>
      <label class="f">Dependencia <input class="i may" id="dDep" value="${esc(p.dependencia)}"></label>
      <label class="f">Legajo <input class="i may" id="dLeg" value="${esc(p.legajo || "")}"></label>
    </div>
    <datalist id="jer2">${JERARQUIAS.map(j => `<option value="${j}">`).join("")}</datalist>
    <div class="row"><button class="btn" id="dGuardar">Guardar datos</button></div><div class="msg" id="dMsg"></div>
  </div>
  <div class="card"><h2>Cambios de mi firma</h2><div id="cambios" class="lead">Cargando…</div></div>`;

  const pad = crearPad($("#pad"), $("#cv"), $("#hint"), n => { $("#fGuardar").disabled = !n; });
  $("#fDes").onclick = pad.deshacer; $("#fBor").onclick = pad.borrar;
  $("#fGuardar").onclick = async () => {
    const b = $("#fGuardar"), m = $("#fMsg"); b.disabled = true;
    try {
      if (ST.firma) { msg(m, "Confirmando tu identidad…"); await verificarClave($("#fClave").value); }
      msg(m, "Guardando…");
      const { error } = await sb.from("firma_imagenes").upsert({ usuario_id: ST.uid, imagen: pad.png() });
      if (error) throw error;
      await cargarFirma(); ST.perfil.tiene_firma = true;
      vistaMiFirma(); setTimeout(() => msg($("#fMsg"), "Firma guardada.", "ok"), 0);
    } catch (e) { b.disabled = false; msg(m, traducir(e), "err"); }
  };
  $("#dGuardar").onclick = async () => {
    const m = $("#dMsg"), U = s => $(s).value.trim().toUpperCase();
    const datos = { jerarquia: U("#dJer"), dependencia: U("#dDep"), legajo: U("#dLeg") || null };
    if (!datos.jerarquia || !datos.dependencia) return msg(m, "La jerarquía y la dependencia no pueden quedar vacías.", "err");
    const { error } = await sb.from("firma_perfiles").update(datos).eq("id", ST.uid);
    if (error) return msg(m, traducir(error), "err");
    Object.assign(ST.perfil, datos); $("#whoName").textContent = nombre(ST.perfil); $("#whoDep").textContent = datos.dependencia;
    msg(m, "Datos guardados.", "ok");
  };
  const { data } = await sb.from("firma_cambios").select("fecha").eq("usuario_id", ST.uid).order("fecha", { ascending: false }).limit(50);
  const c = $("#cambios"); if (c) c.innerHTML = data && data.length ? `<ul style="margin:0;padding-left:18px">${data.map((x, i) => `<li>${fh(x.fecha)}${i === data.length - 1 ? " · creación" : ""}</li>`).join("")}</ul>` : "Todavía no hay cambios.";
}

/* Panel para dibujar la firma */
function crearPad(caja, cv, hint, alCambiar) {
  const ctx = cv.getContext("2d"), trazos = []; let cur = null;
  const tinta = "#1f3fae", grosor = 2.6;
  function ajustar() {
    const r = cv.getBoundingClientRect(), d = Math.max(1, window.devicePixelRatio || 1);
    if (!r.width) return; cv.width = r.width * d; cv.height = r.height * d; ctx.setTransform(d, 0, 0, d, 0, 0); dibujar();
  }
  function trazo(t, c) {
    c.strokeStyle = c.fillStyle = tinta; c.lineCap = c.lineJoin = "round"; const p = t;
    if (p.length === 1) { c.beginPath(); c.arc(p[0].x, p[0].y, grosor * .6, 0, 7); c.fill(); return; }
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], b = p[i], pa = i > 1 ? { x: (p[i - 2].x + a.x) / 2, y: (p[i - 2].y + a.y) / 2 } : a;
      c.lineWidth = b.lw; c.beginPath(); c.moveTo(pa.x, pa.y); c.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2); c.stroke();
    }
  }
  function dibujar() { const r = cv.getBoundingClientRect(); ctx.clearRect(0, 0, r.width, r.height); trazos.forEach(t => trazo(t, ctx)); hint.hidden = trazos.length > 0; alCambiar(trazos.length); }
  const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() }; };
  cv.addEventListener("pointerdown", e => { cv.setPointerCapture(e.pointerId); const p = pos(e); p.lw = grosor; cur = [p]; trazos.push(cur); dibujar(); });
  cv.addEventListener("pointermove", e => {
    if (!cur) return;
    for (const ev of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
      const p = pos(ev), u = cur[cur.length - 1], d = Math.hypot(p.x - u.x, p.y - u.y); if (d < .8) continue;
      const v = d / Math.max(1, p.t - u.t), obj = grosor * Math.max(.45, Math.min(1.35, 1.35 - v * .35));
      p.lw = u.lw * .6 + obj * .4; cur.push(p);
    }
    dibujar();
  });
  ["pointerup", "pointercancel", "pointerleave"].forEach(t => cv.addEventListener(t, () => cur = null));
  new ResizeObserver(ajustar).observe(caja);
  return {
    deshacer: () => { trazos.pop(); dibujar(); },
    borrar: () => { trazos.length = 0; dibujar(); },
    png() {   // recorta, fondo transparente, máx. 900 px de ancho
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      trazos.forEach(t => t.forEach(p => { const m = p.lw * 1.5; x0 = Math.min(x0, p.x - m); y0 = Math.min(y0, p.y - m); x1 = Math.max(x1, p.x + m); y1 = Math.max(y1, p.y + m); }));
      x0 -= 6; y0 -= 6; x1 += 6; y1 += 6;
      const k = Math.min(3, 900 / (x1 - x0)), c = document.createElement("canvas");
      c.width = Math.ceil((x1 - x0) * k); c.height = Math.ceil((y1 - y0) * k);
      const g = c.getContext("2d"); g.setTransform(k, 0, 0, k, -x0 * k, -y0 * k); trazos.forEach(t => trazo(t, g));
      return c.toDataURL("image/png");
    }
  };
}

/* =====================================================================
   ADMINISTRACIÓN
   ===================================================================== */
async function vistaAdmin() {
  app.innerHTML = `<div><h1>Administración</h1><p class="lead">Aprobá las cuentas nuevas solo después de confirmar que la persona es quien dice ser. Bloquear una cuenta no borra lo que ya firmó.</p></div>
    <div class="card"><h2>Cuentas esperando aprobación</h2><div id="pend" class="lista"><p class="lead">Cargando…</p></div></div>
    <div class="card"><div class="row"><h2>Todas las cuentas</h2><span class="sp"></span><input class="i" id="aBus" placeholder="Buscar" style="max-width:260px"></div><div class="scroll-x" id="todas"></div></div>`;
  const { data, error } = await sb.from("firma_perfiles").select("*").order("creado", { ascending: false });
  if (error) return $("#pend").innerHTML = `<div class="aviso bad">${esc(traducir(error))}</div>`;
  const pend = data.filter(p => !p.aprobado);
  $("#pend").innerHTML = pend.length ? pend.map(p => `<div class="item" style="cursor:default"><span class="t">${esc(nombre(p))}</span>
      <button class="btn ok" data-ap="${p.id}">Aprobar</button>
      <span class="s">${esc(p.dependencia)}${p.legajo ? " · Legajo " + esc(p.legajo) : ""} · ${esc(p.email)} · registrada el ${fh(p.creado)}</span></div>`).join("")
    : `<div class="vacio"><b>No hay cuentas pendientes</b>Cuando alguien se registre, aparece acá.</div>`;
  const pintar = () => {
    const t = norm($("#aBus").value.trim());
    const vis = data.filter(p => !t || norm(`${nombre(p)} ${p.dependencia} ${p.email}`).includes(t));
    $("#todas").innerHTML = `<table class="t"><thead><tr><th>Funcionario</th><th>Dependencia</th><th>Correo</th><th>Firma</th><th>Estado</th><th></th></tr></thead><tbody>
      ${vis.map(p => `<tr><td>${esc(nombre(p))}${p.es_admin ? " <span class='chip cancelada'>Admin</span>" : ""}</td><td>${esc(p.dependencia)}</td><td>${esc(p.email)}</td>
        <td>${p.tiene_firma ? "Sí" : "No"}</td><td><span class="chip ${p.aprobado ? "firmada" : "pendiente"}">${p.aprobado ? "Habilitada" : "Sin habilitar"}</span></td>
        <td>${p.id === ST.uid ? "" : `<button class="btn ${p.aprobado ? "bad" : "ok"}" data-${p.aprobado ? "bl" : "ap"}="${p.id}">${p.aprobado ? "Bloquear" : "Habilitar"}</button>`}</td></tr>`).join("")}
      </tbody></table>`;
    enlazar();
  };
  function enlazar() {
    $$("[data-ap],[data-bl]").forEach(b => b.onclick = async () => {
      const id = b.dataset.ap || b.dataset.bl, val = !!b.dataset.ap;
      if (!val && !b.dataset.ok) { b.dataset.ok = 1; b.textContent = "¿Seguro? Bloquear"; return; }
      b.disabled = true;
      const { error } = await sb.rpc("firma_admin_aprobar", { p_usuario: id, p_aprobado: val });
      if (error) { b.disabled = false; b.textContent = traducir(error); return; }
      const { data: pf } = await sb.from("firma_perfiles").select("id,nombre,apellido,jerarquia,dependencia").eq("aprobado", true).order("apellido");
      ST.perfiles = pf || []; vistaAdmin();
    });
  }
  $("#aBus").oninput = pintar; pintar();
}

const VISTAS = { "para-firmar": vistaParaFirmar, "pedir": vistaPedir, "mis-pedidos": () => vistaMisPedidos(), "historial": () => vistaHistorial(), "mi-firma": vistaMiFirma, "admin": vistaAdmin };
})();

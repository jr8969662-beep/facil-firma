/* =====================================================================
   documento.js — arma el acta en PDF y estampa la firma
   Necesita (cargadas antes): pdf-lib (PDFLib) y qrcode-generator (qrcode)
   Coordenadas de "posicion": puntos PDF, origen arriba a la izquierda
   { pagina, x, y, w, pw, ph }  (pw/ph = tamaño de la hoja al ubicarla)
   ===================================================================== */
(function (g) {
  const TZ = "America/Argentina/Salta";
  const ALTO = 0.62;                        // alto del bloque = ancho * 0.62

  function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""); }
  async function sha256(bytes) {
    const c = (g.crypto && g.crypto.subtle) ? g.crypto.subtle : require("crypto").webcrypto.subtle;
    return hex(await c.digest("SHA-256", bytes));
  }
  function fechaHora(d) {
    const f = new Date(d || Date.now());
    const o = { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
    return f.toLocaleString("es-AR", o).replace(",", "");
  }
  function fechaLarga(d) {
    return new Date(d || Date.now()).toLocaleDateString("es-AR", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
  }
  // Las fuentes estándar de PDF no tienen todos los caracteres: se reemplazan
  function limpio(font, txt) {
    txt = String(txt || "").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\t/g, "    ");
    let out = "";
    for (const ch of txt) {
      if (ch === "\n" || ch === "\r") { out += ch; continue; }
      try { font.encodeText(ch); out += ch; } catch { out += "?"; }
    }
    return out;
  }
  function ajustar(font, txt, max, tam, min) {
    let s = tam; while (s > min && font.widthOfTextAtSize(txt, s) > max) s -= 0.25;
    return s;
  }
  // sangria: espacio extra en la primera línea de cada párrafo
  function partir(font, txt, tam, ancho, sangria) {
    sangria = sangria || 0;
    const lineas = [];
    for (const parrafo of txt.split(/\r?\n/)) {
      if (!parrafo.trim()) { lineas.push({ t: "", fin: true }); continue; }
      const pal = parrafo.split(/\s+/).filter(Boolean); let cur = "";
      const disp = () => ancho - (lineas.length && !lineas[lineas.length - 1].fin ? 0 : sangria);
      for (const p of pal) {
        const prueba = cur ? cur + " " + p : p;
        if (font.widthOfTextAtSize(prueba, tam) <= disp()) cur = prueba;
        else {
          if (cur) lineas.push({ t: cur, primera: !lineas.length || lineas[lineas.length - 1].fin });
          // palabra más larga que la línea: se corta
          let w = p; while (font.widthOfTextAtSize(w, tam) > ancho) {
            let k = w.length; while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), tam) > ancho) k--;
            lineas.push({ t: w.slice(0, k) }); w = w.slice(k);
          }
          cur = w;
        }
      }
      lineas.push({ t: cur, fin: true, primera: !lineas.length || lineas[lineas.length - 1].fin });
    }
    return lineas;
  }

  /* ---------- 1. Acta escrita en el sistema → PDF ---------- */
  async function crearActa(d) {
    const { PDFDocument, StandardFonts, rgb } = g.PDFLib;
    const doc = await PDFDocument.create();
    const reg = await doc.embedFont(StandardFonts.TimesRoman);
    const neg = await doc.embedFont(StandardFonts.TimesRomanBold);
    const W = 595.28, H = 841.89, M = 70, T = 12, LH = 18, ancho = W - 2 * M;
    const negro = rgb(0, 0, 0), gris = rgb(.35, .35, .35);
    const bloqueW = 190, bloqueH = bloqueW * ALTO;
    let pag, y; const paginas = [];
    const centro = (p, txt, f, s, yy, c) => p.drawText(txt, { x: (W - f.widthOfTextAtSize(txt, s)) / 2, y: yy, size: s, font: f, color: c || negro });

    function nueva() {
      pag = doc.addPage([W, H]); paginas.push(pag); y = H - 60;
      const t1 = limpio(neg, "POLICÍA DE LA PROVINCIA DE SALTA");
      centro(pag, t1, neg, 12, y); y -= 15;
      const dep = limpio(reg, (d.dependencia || "").toUpperCase());
      if (dep) { centro(pag, dep, reg, 10, y, gris); y -= 12; }
      pag.drawLine({ start: { x: M, y: y - 2 }, end: { x: W - M, y: y - 2 }, thickness: .6, color: gris });
      y -= 28;
    }
    nueva();
    const tipo = limpio(neg, (d.tipo || "ACTA").toUpperCase());
    centro(pag, tipo, neg, 15, y); y -= 20;
    const tit = limpio(neg, (d.titulo || "").toUpperCase());
    if (tit) for (const l of partir(neg, tit, 11.5, ancho)) { if (l.t) { centro(pag, l.t, neg, 11.5, y); y -= 15; } }
    y -= 14;
    const lf = limpio(reg, d.lugarFecha || ("Salta, " + fechaLarga()));
    pag.drawText(lf, { x: W - M - reg.widthOfTextAtSize(lf, T), y, size: T, font: reg }); y -= LH * 1.8;

    const SANG = 36;
    const lineas = partir(reg, limpio(reg, d.cuerpo || ""), T, ancho, SANG);
    for (const l of lineas) {
      if (y < M + 10) nueva();
      if (l.t) {
        const x0 = M + (l.primera ? SANG : 0), disp = ancho - (l.primera ? SANG : 0);
        const pal = l.t.split(" ");
        if (!l.fin && pal.length > 1) {          // justificado, salvo la última línea
          const esp = (disp - reg.widthOfTextAtSize(pal.join(""), T)) / (pal.length - 1); let x = x0;
          for (const p of pal) { pag.drawText(p, { x, y, size: T, font: reg }); x += reg.widthOfTextAtSize(p, T) + esp; }
        } else pag.drawText(l.t, { x: x0, y, size: T, font: reg });
      }
      y -= LH;
    }

    // lugar para la firma
    y -= 40;
    if (y - bloqueH < 40) { nueva(); y -= 40; }
    const posicion = { pagina: paginas.length - 1, x: W - M - bloqueW, y: H - y, w: bloqueW, pw: W, ph: H };

    paginas.forEach((p, i) => {
      const t = `Hoja ${i + 1} de ${paginas.length}`;
      p.drawText(t, { x: W - M - reg.widthOfTextAtSize(t, 8), y: H - 30, size: 8, font: reg, color: gris });
    });
    doc.setTitle(`${d.tipo || "ACTA"} - ${d.titulo || ""}`.trim());
    doc.setProducer("Sistema de Firmas - Policía de Salta");
    return { bytes: await doc.save(), posicion };
  }

  /* ---------- 2. Estampar la firma ---------- */
  function dibujarQR(pagina, texto, x, y, lado, color) {
    const q = g.qrcode(0, "M"); q.addData(texto); q.make();
    const n = q.getModuleCount(), m = lado / (n + 2);
    pagina.drawRectangle({ x, y, width: lado, height: lado, color: g.PDFLib.rgb(1, 1, 1) });
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
      if (q.isDark(r, c)) pagina.drawRectangle({ x: x + (c + 1) * m, y: y + lado - (r + 2) * m, width: m + .05, height: m + .05, color });
  }

  async function firmar(original, o) {
    const { PDFDocument, StandardFonts, rgb } = g.PDFLib;
    const doc = await PDFDocument.load(original, { ignoreEncryption: true });
    const reg = await doc.embedFont(StandardFonts.Helvetica);
    const neg = await doc.embedFont(StandardFonts.HelveticaBold);
    const png = await doc.embedPng(o.firmaPng);
    const pags = doc.getPages();
    const p = o.posicion, pag = pags[Math.min(p.pagina, pags.length - 1)];
    const { width: PW, height: PH } = pag.getSize();
    const fx = p.pw ? PW / p.pw : 1, fy = p.ph ? PH / p.ph : 1;
    const w = p.w * fx, h = p.w * ALTO * fy, x = p.x * fx, top = PH - p.y * fy;
    const tinta = rgb(.08, .1, .15), gris = rgb(.38, .4, .45);
    const f = o.firmante, cuando = fechaHora(o.fecha);

    // firma (imagen), centrada en la parte de arriba del bloque
    const altoImg = h * .5, esc = Math.min(w / png.width, altoImg / png.height);
    const iw = png.width * esc, ih = png.height * esc;
    const lineaY = top - altoImg - 2;
    pag.drawImage(png, { x: x + (w - iw) / 2, y: lineaY + 1, width: iw, height: ih });
    pag.drawLine({ start: { x, y: lineaY }, end: { x: x + w, y: lineaY }, thickness: .7, color: tinta });

    const nombre = limpio(neg, `${f.jerarquia} ${f.nombre} ${f.apellido}`.replace(/\s+/g, " ").trim());
    const s1 = ajustar(neg, nombre, w, Math.max(7, Math.min(10, w / 20)), 5);
    let ty = lineaY - s1 - 3;
    pag.drawText(nombre, { x: x + (w - neg.widthOfTextAtSize(nombre, s1)) / 2, y: ty, size: s1, font: neg, color: tinta });
    const dep = limpio(reg, (f.dependencia || "") + (f.legajo ? ` · L.P. ${f.legajo}` : ""));
    if (dep.trim()) {
      const s2 = ajustar(reg, dep, w, s1 - 1, 4.5); ty -= s2 + 3;
      pag.drawText(dep, { x: x + (w - reg.widthOfTextAtSize(dep, s2)) / 2, y: ty, size: s2, font: reg, color: tinta });
    }
    const leg = limpio(reg, `Firmado electrónicamente el ${cuando} · Cód. ${o.codigo}`);
    const s3 = ajustar(reg, leg, w, 6, 4); ty -= s3 + 4;
    pag.drawText(leg, { x: x + (w - reg.widthOfTextAtSize(leg, s3)) / 2, y: ty, size: s3, font: reg, color: gris });

    // QR al costado del bloque (izquierda si entra, si no derecha)
    const lado = Math.min(h * .72, 70), url = o.urlVerificar;
    if (url) {
      const qy = top - h + (h - lado) / 2;
      if (x - lado - 8 >= 6) dibujarQR(pag, url, x - lado - 8, qy, lado, tinta);
      else if (x + w + 8 + lado <= PW - 6) dibujarQR(pag, url, x + w + 8, qy, lado, tinta);
    }

    // pie de verificación en todas las hojas
    const pie = limpio(reg, `Documento firmado electrónicamente por ${f.jerarquia} ${f.nombre} ${f.apellido} el ${cuando} · Código ${o.codigo}` + (url ? ` · Verificar: ${url.split("?")[0]}` : ""));
    for (const pg of pags) {
      const { width } = pg.getSize(), s = ajustar(reg, pie, width - 40, 6.5, 3.5);
      pg.drawText(pie, { x: (width - reg.widthOfTextAtSize(pie, s)) / 2, y: 12, size: s, font: reg, color: gris });
    }
    doc.setSubject(`Firmado electrónicamente por ${f.jerarquia} ${f.nombre} ${f.apellido} - Código ${o.codigo}`);
    doc.setKeywords([o.codigo]);
    doc.setProducer("Sistema de Firmas - Policía de Salta");
    doc.setModificationDate(new Date(o.fecha || Date.now()));
    return await doc.save();
  }

  g.Documento = { sha256, crearActa, firmar, fechaHora, ALTO };
})(typeof window !== "undefined" ? window : globalThis);

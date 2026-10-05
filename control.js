"use strict";

/*
 * El área Control de la consola.
 *
 * No entra a ningún turnero. Todo sale del repositorio privado de datos (ver
 * Control/control-datos): sitios.json, el último chequeo que deja la tarea de GitHub en
 * estado/ultimo.json, los issues (incidentes y tickets) y las notas. Se habla con la API de
 * GitHub con un token de grano fino que ve solamente ese repositorio.
 *
 * Lo único que va directo a un turnero es la consulta en vivo a su ruta de salud, que es
 * pública y no lleva credenciales.
 *
 * Reglas de la casa para este archivo:
 *  - Nada de lo que viene del repositorio o de una API se escribe como HTML. Todo pasa por
 *    `el()`, que arma nodos y pone el texto como texto. Los títulos de un ticket, el cuerpo
 *    de una nota o el nombre de un cliente los escribo yo, pero el día que alguien más
 *    escriba en el repositorio no tiene que poder correr código en la página que guarda el
 *    token.
 *  - Los enlaces que se arman con datos (WhatsApp, teléfono, mail, GitHub) pasan por
 *    `enlaceSeguro()`: solo https, mailto y tel.
 *  - El token vive en sessionStorage: se borra al cerrar la pestaña.
 */
(() => {
  if (window.top !== window.self) return;

  const API = "https://api.github.com";
  const CLAVE_TOKEN = "control-token";
  const CLAVE_REPO = "control-repo";
  const CLAVE_VISTA = "control-vista";
  const WORKFLOW = "control.yml";
  const REFRESCO_MS = 5 * 60 * 1000;
  const PUNTOS_SERIE = 48;

  const NIVELES = { ok: "Bien", aviso: "Aviso", falla: "Falla", info: "Dato" };
  const TIPOS = { relevamiento: "Relevamiento", analisis: "Análisis", nota: "Nota" };
  const PRIORIDADES = { alta: "Alta", media: "Media", baja: "Baja" };
  const COLORES_ETIQUETA = {
    ticket: "1d76db",
    incidente: "d73a4a",
    "prioridad:alta": "d73a4a",
    "prioridad:media": "fbca04",
    "prioridad:baja": "c2e0c6",
  };

  const $ = (id) => document.getElementById(id);
  const dormir = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* ============================================================
     Dibujo seguro
     ============================================================ */

  /** Solo https, mailto y tel. Cualquier otra cosa no se vuelve un enlace. */
  function enlaceSeguro(direccion) {
    try {
      const url = new URL(String(direccion), location.href);
      return ["https:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  /**
   * Un elemento con sus propiedades y sus hijos. Los hijos de texto entran como texto, nunca
   * como HTML. Los manejadores se pasan como funciones (`onclick`), no como texto.
   */
  function el(etiqueta, props = {}, ...hijos) {
    const nodo = document.createElement(etiqueta);
    for (const [clave, valor] of Object.entries(props)) {
      if (valor === undefined || valor === null || valor === false) continue;
      if (clave === "class") nodo.className = valor;
      else if (clave === "text") nodo.textContent = valor;
      else if (clave === "href") {
        const seguro = enlaceSeguro(valor);
        if (seguro) nodo.href = seguro;
      } else if (clave.startsWith("on") && typeof valor === "function") nodo.addEventListener(clave.slice(2), valor);
      else nodo.setAttribute(clave, valor === true ? "" : String(valor));
    }
    for (const hijo of hijos.flat()) {
      if (hijo === null || hijo === undefined || hijo === false) continue;
      nodo.append(hijo instanceof Node ? hijo : String(hijo));
    }
    return nodo;
  }

  const NS = "http://www.w3.org/2000/svg";
  function svg(etiqueta, atributos = {}, ...hijos) {
    const nodo = document.createElementNS(NS, etiqueta);
    for (const [clave, valor] of Object.entries(atributos)) nodo.setAttribute(clave, String(valor));
    for (const hijo of hijos) if (hijo) nodo.append(hijo);
    return nodo;
  }

  /** Un enlace que abre afuera, sin pasarle esta página a la otra. */
  function afuera(direccion, texto, clase) {
    const seguro = enlaceSeguro(direccion);
    if (!seguro) return null;
    return el("a", { href: seguro, target: "_blank", rel: "noopener noreferrer", class: clase }, texto);
  }

  function aviso(destino, texto, clase) {
    const caja = typeof destino === "string" ? $(destino) : destino;
    caja.replaceChildren();
    if (texto) caja.appendChild(el("div", { class: `msg ${clase}`, text: texto }));
  }

  /** Un "listo" que se va solo. Los problemas, en cambio, quedan hasta que se resuelven. */
  let hechoTemporizador = null;
  function hecho(texto) {
    aviso("c-hecho", texto, "ok");
    clearTimeout(hechoTemporizador);
    hechoTemporizador = setTimeout(() => aviso("c-hecho", "", ""), 6000);
  }

  function chipNivel(nivel) {
    const clase = NIVELES[nivel] ? nivel : "nada";
    return el("span", { class: `nivel ${clase}`, text: NIVELES[nivel] ?? "Sin datos" });
  }

  /* ============================================================
     Formatos
     ============================================================ */

  const relativo = new Intl.RelativeTimeFormat("es-AR", { numeric: "auto" });
  const fechaHora = new Intl.DateTimeFormat("es-AR", { dateStyle: "medium", timeStyle: "short" });
  const fechaCorta = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short" });
  const dolares = new Intl.NumberFormat("es-AR", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function hace(iso) {
    const momento = new Date(iso).getTime();
    if (!Number.isFinite(momento)) return "";
    const segundos = Math.round((momento - Date.now()) / 1000);
    const abs = Math.abs(segundos);
    if (abs < 60) return relativo.format(0, "second");
    if (abs < 3600) return relativo.format(Math.round(segundos / 60), "minute");
    if (abs < 86400 * 2) return relativo.format(Math.round(segundos / 3600), "hour");
    return relativo.format(Math.round(segundos / 86400), "day");
  }

  const fecha = (iso) => {
    const d = new Date(iso);
    return Number.isFinite(d.getTime()) ? fechaHora.format(d) : "";
  };
  const usd = (valor) => (Number.isFinite(Number(valor)) ? dolares.format(Number(valor)) : "Sin dato");

  /** Hoy en la zona del consultorio, AAAA-MM-DD, para la fecha de una nota nueva. */
  function hoy() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  }

  /* ============================================================
     GitHub
     ============================================================ */

  let token = "";
  let repo = "";
  let rama = "main";

  function conEstado(error, estado) {
    error.status = estado;
    return error;
  }

  function explicar(estado, mensaje, respuesta) {
    if (estado === 401) return "El token no sirve o venció";
    if (estado === 403 || estado === 429) {
      if (/rate limit/i.test(mensaje) || respuesta.headers.get("x-ratelimit-remaining") === "0") return "GitHub limitó las consultas. Conviene esperar un rato";
      return "El token no tiene permiso para esto";
    }
    if (estado === 404) return "No se encontró en el repositorio";
    if (estado === 409) return "Cambió en el repositorio. Hay que recargar antes de guardar";
    if (estado === 422) return "GitHub rechazó los datos";
    return `GitHub contestó ${estado}`;
  }

  /** Un pedido a la API de GitHub con el token del control. Sin cookies y sin caché. */
  async function gh(ruta, { metodo = "GET", cuerpo, crudo = false } = {}) {
    let respuesta;
    try {
      respuesta = await fetch(API + ruta, {
        method: metodo,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: crudo ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          ...(cuerpo ? { "Content-Type": "application/json" } : {}),
        },
        body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      });
    } catch {
      throw conEstado(new Error("Sin conexión con GitHub"), 0);
    }

    if (respuesta.status === 204) return null;
    const texto = await respuesta.text();

    if (!respuesta.ok) {
      let mensaje = "";
      try {
        mensaje = JSON.parse(texto).message ?? "";
      } catch {
        /* sin cuerpo */
      }
      throw conEstado(new Error(explicar(respuesta.status, mensaje, respuesta)), respuesta.status);
    }

    if (crudo) return texto;
    return texto ? JSON.parse(texto) : null;
  }

  const enRepo = (ruta) => `/repos/${repo}${ruta}`;
  const rutaContenido = (ruta) => enRepo(`/contents/${ruta.split("/").map(encodeURIComponent).join("/")}`);

  /** Un archivo del repositorio como texto, o null si no está. */
  async function leerArchivo(ruta) {
    try {
      return await gh(`${rutaContenido(ruta)}?ref=${encodeURIComponent(rama)}`, { crudo: true });
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  /** Texto a base64 pasando por UTF-8, que es lo que pide la API de contenidos. */
  function aBase64(texto) {
    const bytes = new TextEncoder().encode(texto);
    let binario = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binario += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binario);
  }

  let etiquetas = null;

  /** Que existan las etiquetas antes de usarlas. Se crean con un color fijo por tipo. */
  async function asegurarEtiquetas(nombres) {
    if (!etiquetas) {
      const lista = await gh(enRepo("/labels?per_page=100"));
      etiquetas = new Set((lista ?? []).map((etiqueta) => etiqueta.name));
    }
    for (const nombre of nombres) {
      if (etiquetas.has(nombre)) continue;
      const color = COLORES_ETIQUETA[nombre] ?? (nombre.startsWith("cliente:") ? "0e8a16" : "bfdadc");
      try {
        await gh(enRepo("/labels"), { metodo: "POST", cuerpo: { name: nombre, color } });
      } catch (error) {
        if (error.status !== 422) throw error; // 422 es que ya estaba
      }
      etiquetas.add(nombre);
    }
  }

  /* ============================================================
     Datos
     ============================================================ */

  const datos = {
    sitios: [],
    ultimo: null,
    incidentes: [],
    abiertos: [],
    tickets: [],
    ticketsEstado: "open",
    arbol: [],
    notas: new Map(),
  };

  const ID_VALIDO = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const sitioPorId = (id) => datos.sitios.find((sitio) => sitio.id === id) ?? null;
  const nombreCliente = (id) => sitioPorId(id)?.nombre ?? id;

  async function cargarSitios() {
    const texto = await leerArchivo("sitios.json");
    if (texto === null) throw new Error("Falta sitios.json en el repositorio");
    let config;
    try {
      config = JSON.parse(texto);
    } catch {
      throw new Error("sitios.json no es un JSON válido");
    }
    datos.sitios = (Array.isArray(config.sitios) ? config.sitios : []).filter((sitio) => sitio && ID_VALIDO.test(String(sitio.id)));
  }

  async function cargarUltimo() {
    const texto = await leerArchivo("estado/ultimo.json");
    try {
      datos.ultimo = texto ? JSON.parse(texto) : null;
    } catch {
      datos.ultimo = null;
    }
  }

  const sinPedidos = (lista) => (Array.isArray(lista) ? lista.filter((issue) => !issue.pull_request) : []);
  const tieneEtiqueta = (issue, nombre) => (issue.labels ?? []).some((etiqueta) => (etiqueta?.name ?? etiqueta) === nombre);
  const valorEtiqueta = (issue, prefijo) => {
    const etiqueta = (issue.labels ?? []).map((e) => e?.name ?? e).find((nombre) => String(nombre).startsWith(prefijo));
    return etiqueta ? String(etiqueta).slice(prefijo.length) : "";
  };

  async function cargarIncidentes() {
    datos.incidentes = sinPedidos(await gh(enRepo("/issues?labels=incidente&state=open&per_page=50")));
  }

  async function cargarAbiertos() {
    datos.abiertos = sinPedidos(await gh(enRepo("/issues?labels=ticket&state=open&per_page=100&sort=updated")));
  }

  async function cargarTickets() {
    const estado = $("t-f-estado").value;
    datos.ticketsEstado = estado;
    datos.tickets = estado === "open" ? datos.abiertos : sinPedidos(await gh(enRepo(`/issues?labels=ticket&state=${estado}&per_page=100&sort=updated`)));
  }

  /** Las notas son `notas/<cliente>/<AAAA-MM-DD>-<slug>.md`. El árbol trae todas de una vez. */
  const PATRON_NOTA = /^notas\/([a-z0-9][a-z0-9-]*)\/(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.md$/;

  async function cargarArbol() {
    try {
      const arbol = await gh(enRepo(`/git/trees/${encodeURIComponent(rama)}?recursive=1`));
      datos.arbol = (arbol?.tree ?? [])
        .filter((entrada) => entrada.type === "blob" && PATRON_NOTA.test(entrada.path))
        .map((entrada) => {
          const [, cliente, dia, slug] = entrada.path.match(PATRON_NOTA);
          return { ruta: entrada.path, sha: entrada.sha, cliente, fecha: dia, slug };
        });
    } catch (error) {
      // Un repositorio recién creado, sin commits, contesta 409.
      if (error.status === 409) datos.arbol = [];
      else throw error;
    }
  }

  /** Lee las notas que cambiaron desde la última vez, de a cuatro. */
  async function cargarNotas() {
    const pendientes = datos.arbol.filter((entrada) => datos.notas.get(entrada.ruta)?.sha !== entrada.sha);
    for (const ruta of [...datos.notas.keys()]) if (!datos.arbol.some((entrada) => entrada.ruta === ruta)) datos.notas.delete(ruta);

    for (let i = 0; i < pendientes.length; i += 4) {
      await Promise.all(
        pendientes.slice(i, i + 4).map(async (entrada) => {
          const texto = await leerArchivo(entrada.ruta);
          if (texto === null) return;
          const { meta, cuerpo } = leerNota(texto);
          datos.notas.set(entrada.ruta, {
            ruta: entrada.ruta,
            sha: entrada.sha,
            cliente: entrada.cliente,
            fecha: /^\d{4}-\d{2}-\d{2}$/.test(meta.fecha ?? "") ? meta.fecha : entrada.fecha,
            tipo: TIPOS[meta.tipo] ? meta.tipo : "nota",
            titulo: meta.titulo || entrada.slug,
            cuerpo,
          });
        })
      );
    }
  }

  /** El encabezado de una nota: un YAML de pocas líneas `clave: valor`. */
  function leerNota(texto) {
    const partes = texto.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
    if (!partes) return { meta: {}, cuerpo: texto };
    const meta = {};
    for (const linea of partes[1].split(/\r?\n/)) {
      const par = linea.match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (!par) continue;
      let valor = par[2].trim();
      if (valor.startsWith('"')) {
        try {
          valor = JSON.parse(valor);
        } catch {
          valor = valor.replace(/^"|"$/g, "");
        }
      } else if (valor.startsWith("'") && valor.endsWith("'")) {
        valor = valor.slice(1, -1).replace(/''/g, "'");
      }
      meta[par[1]] = String(valor);
    }
    return { meta, cuerpo: partes[2].replace(/^\r?\n/, "") };
  }

  /** El título va entre comillas dobles con el escape de JSON, que también es YAML válido. */
  function escribirNota({ tipo, cliente, fecha: dia, titulo }, cuerpo) {
    return `---\ntipo: ${tipo}\ncliente: ${cliente}\nfecha: ${dia}\ntitulo: ${JSON.stringify(titulo)}\n---\n\n${cuerpo.replace(/\s+$/, "")}\n`;
  }

  function slug(texto) {
    const limpio = texto
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/, "");
    return limpio || "nota";
  }

  /* ============================================================
     Conexión
     ============================================================ */

  const REPO_VALIDO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
  let conectado = false;
  let iniciado = false;
  let temporizador = null;

  async function conectar({ silencioso = false } = {}) {
    const repoValor = $("c-repo").value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/+$/, "");
    const tokenValor = $("c-token").value.trim() || token;

    if (!REPO_VALIDO.test(repoValor)) return aviso("c-msg-conexion", "El repositorio va como usuario/nombre", "bad");
    if (!tokenValor) return aviso("c-msg-conexion", "Falta el token", "bad");

    const boton = $("c-conectar");
    boton.disabled = true;
    aviso("c-msg-conexion", "", "");
    repo = repoValor;
    token = tokenValor;

    try {
      const info = await gh(`/repos/${repo}`);
      rama = info?.default_branch || "main";
      try { sessionStorage.setItem(CLAVE_TOKEN, token); } catch {}
      try { localStorage.setItem(CLAVE_REPO, repo); } catch {}
      // El token no se queda escrito en la pantalla.
      $("c-token").value = "";
      conectado = true;
      $("c-repo-nombre").textContent = repo;
      $("c-conexion").hidden = true;
      $("c-panel").hidden = false;
      aviso(
        "c-aviso",
        info?.private === false ? "El repositorio es público. Los datos de los clientes quedan a la vista de cualquiera. Conviene pasarlo a privado." : "",
        "bad"
      );
      await refrescarTodo();
      if (!temporizador) temporizador = setInterval(refrescoPeriodico, REFRESCO_MS);
    } catch (error) {
      token = "";
      try { sessionStorage.removeItem(CLAVE_TOKEN); } catch {}
      if (!silencioso || error.status !== 401) aviso("c-msg-conexion", error.message, "bad");
      else aviso("c-msg-conexion", "El token guardado venció. Hace falta uno nuevo.", "bad");
    } finally {
      boton.disabled = false;
    }
  }

  function desconectar() {
    token = "";
    conectado = false;
    etiquetas = null;
    try { sessionStorage.removeItem(CLAVE_TOKEN); } catch {}
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
    $("c-panel").hidden = true;
    $("c-conexion").hidden = false;
    aviso("c-msg-conexion", "", "");
    $("c-token").focus();
  }

  async function refrescarTodo() {
    const resultados = await Promise.allSettled([cargarSitios(), cargarUltimo(), cargarIncidentes(), cargarAbiertos(), cargarArbol()]);
    const fallas = resultados.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? "Error");
    if (fallas.length) aviso("c-aviso", [...new Set(fallas)].join(". "), "bad");

    llenarSelectoresDeCliente();
    try {
      await cargarTickets();
    } catch (error) {
      aviso("c-aviso", error.message, "bad");
    }
    dibujarVista();

    try {
      await cargarNotas();
    } catch (error) {
      aviso("c-aviso", error.message, "bad");
    }
    if (vistaActual === "notas" || vistaActual === "clientes") dibujarVista();
  }

  async function refrescarEstado() {
    try {
      await Promise.all([cargarUltimo(), cargarIncidentes()]);
    } catch (error) {
      aviso("e-msg", error.message, "bad");
    }
    if (vistaActual === "estado" || vistaActual === "railway") dibujarVista();
  }

  function refrescoPeriodico() {
    if (!conectado || document.visibilityState !== "visible" || $("area-control").hidden) return;
    refrescarEstado();
  }

  /* ============================================================
     Vistas
     ============================================================ */

  const VISTAS = ["estado", "railway", "clientes", "tickets", "notas"];
  let vistaActual = "estado";

  function mostrarVista(nombre) {
    vistaActual = VISTAS.includes(nombre) ? nombre : "estado";
    aviso("c-hecho", "", "");
    for (const boton of document.querySelectorAll(".c-vistas button")) {
      const activa = boton.dataset.vista === vistaActual;
      boton.setAttribute("aria-selected", String(activa));
      boton.tabIndex = activa ? 0 : -1;
    }
    for (const vista of VISTAS) $(`v-${vista}`).hidden = vista !== vistaActual;
    try { localStorage.setItem(CLAVE_VISTA, vistaActual); } catch {}
    dibujarVista();
  }

  function dibujarVista() {
    if (!conectado) return;
    if (vistaActual === "estado") dibujarEstado();
    else if (vistaActual === "railway") dibujarRailway();
    else if (vistaActual === "clientes") dibujarClientes();
    else if (vistaActual === "tickets") dibujarTickets();
    else if (vistaActual === "notas") dibujarNotas();
  }

  /* ---------- Estado ---------- */

  const resultadoDe = (id) => (datos.ultimo?.sitios ?? []).find((sitio) => sitio.id === id) ?? null;

  /**
   * La serie corta de un sitio: una barra por chequeo, la más nueva a la derecha.
   *
   * El estado va en el color y también en la altura (falla llena, aviso a dos tercios, bien
   * según el tiempo de respuesta y nunca más de la mitad), para que no dependa solo del
   * color: el verde y el ámbar se confunden con daltonismo rojo-verde.
   */
  function serieDe(serie) {
    const puntos = (Array.isArray(serie) ? serie : []).slice(-PUNTOS_SERIE);
    const ancho = 5;
    const alto = 40;
    const dibujo = svg("svg", { class: "spark", viewBox: `0 0 ${PUNTOS_SERIE * ancho} ${alto}`, preserveAspectRatio: "none", role: "img" });

    const msBien = puntos.filter((p) => p.n === "ok" && Number.isFinite(p.ms)).map((p) => p.ms);
    const techo = Math.max(1000, ...msBien);
    const cuenta = { ok: 0, aviso: 0, falla: 0 };

    for (let i = 0; i < PUNTOS_SERIE; i++) {
      const punto = puntos[i - (PUNTOS_SERIE - puntos.length)];
      const x = i * ancho;
      if (!punto) {
        dibujo.append(svg("rect", { x, y: alto - 2, width: ancho - 1, height: 2, class: "vacio" }));
        continue;
      }
      const nivel = NIVELES[punto.n] && punto.n !== "info" ? punto.n : "ok";
      cuenta[nivel]++;
      const h = nivel === "falla" ? alto : nivel === "aviso" ? Math.round(alto * 0.66) : Math.max(4, Math.round(6 + 14 * Math.min(1, (punto.ms ?? 0) / techo)));
      const barra = svg("rect", { x, y: alto - h, width: ancho - 1, height: h, rx: 1, class: nivel });
      const titulo = svg("title");
      titulo.textContent = `${fecha(punto.t)}, ${NIVELES[nivel].toLowerCase()}${Number.isFinite(punto.ms) ? `, ${punto.ms} ms` : ""}`;
      barra.append(titulo);
      dibujo.append(barra);
    }

    const resumen = [`${cuenta.ok} bien`, cuenta.aviso ? `${cuenta.aviso} con aviso` : "", cuenta.falla ? `${cuenta.falla} con falla` : ""].filter(Boolean).join(", ");
    dibujo.setAttribute("aria-label", puntos.length ? `Últimos ${puntos.length} chequeos. ${resumen}` : "Sin chequeos todavía");

    return el(
      "div",
      {},
      dibujo,
      el("div", { class: "spark-pie" }, el("span", { text: puntos.length ? hace(puntos[0].t) : "" }), el("span", { text: puntos.length ? resumen : "Sin historia" }))
    );
  }

  /** La ruta de salud consultada desde el navegador, sin credenciales. */
  async function enVivo(sitio, destino) {
    const api = String(sitio.api ?? "").replace(/\/+$/, "");
    if (!/^https:\/\//.test(api)) return;
    destino.replaceChildren(el("span", { class: "rotulo", text: "En vivo" }), el("span", { text: "Consultando" }));

    const inicio = performance.now();
    let nivel = "nada";
    let texto = "Sin respuesta desde el navegador";
    try {
      const respuesta = await fetch(`${api}/health`, {
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.timeout(10_000),
      });
      const ms = Math.round(performance.now() - inicio);
      let cuerpo = null;
      try {
        cuerpo = await respuesta.json();
      } catch {
        /* sin JSON */
      }
      if (cuerpo && typeof cuerpo.db === "string") {
        const version = typeof cuerpo.version === "string" ? `, versión ${cuerpo.version.slice(0, 12)}` : "";
        if (cuerpo.db !== "ok") {
          nivel = "falla";
          texto = "La base de datos no responde";
        } else if (cuerpo.ok) {
          nivel = "ok";
          texto = `Bien, ${ms} ms${version}`;
        } else {
          const atrasadas = (Array.isArray(cuerpo.jobs) ? cuerpo.jobs : []).filter((tarea) => tarea?.late).map((tarea) => String(tarea.name).slice(0, 30));
          nivel = "aviso";
          texto = atrasadas.length ? `Atrasadas ${atrasadas.join(", ")}` : "Sin lectura de tareas";
        }
      } else if (respuesta.status === 429) {
        texto = "Limitado, conviene esperar un minuto";
      } else {
        nivel = "falla";
        texto = `Contesta ${respuesta.status}`;
      }
    } catch {
      // Un servidor caído y uno con una versión anterior a la ruta de salud se ven igual
      // desde acá: el navegador no deja leer la respuesta sin el permiso de CORS. El
      // chequeo de la tarea de GitHub sí los distingue.
    }

    destino.replaceChildren(el("span", { class: "rotulo", text: "En vivo" }), el("span", {}, el("span", { class: `punto ${nivel === "nada" ? "" : nivel}` }), " ", texto));
  }

  function tarjetaSitio(sitio) {
    const resultado = resultadoDe(sitio.id);
    const nivel = resultado?.nivel ?? null;
    const meta = resultado
      ? [
          `${NIVELES[nivel] ?? "Sin datos"} desde ${hace(resultado.desde)}`,
          resultado.version ? `versión ${resultado.version}` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : "Todavía sin chequear";

    const controles = (resultado?.controles ?? []).map((control) =>
      el(
        "li",
        {},
        el("span", { class: `punto ${control.nivel}`, title: NIVELES[control.nivel] ?? "" }),
        el("span", { text: control.nombre }),
        el("span", { class: "det", text: control.detalle ?? "" })
      )
    );

    const vivo = sitio.tipo === "turnero" && sitio.api ? el("div", { class: "vivo", "aria-live": "polite" }) : null;
    if (vivo) enVivo(sitio, vivo);

    const abiertos = datos.abiertos.filter((ticket) => tieneEtiqueta(ticket, `cliente:${sitio.id}`)).length;

    return el(
      "article",
      { class: `card sitio ${nivel ?? ""}` },
      el(
        "div",
        { class: "sitio-cabeza" },
        el("h3", {}, sitio.nombre, el("span", { class: "pill", text: sitio.tipo === "turnero" ? "turnero" : "web" })),
        chipNivel(nivel)
      ),
      el("p", { class: "meta", text: meta }),
      serieDe(resultado?.serie),
      controles.length ? el("ul", { class: "controles" }, controles) : null,
      vivo,
      el(
        "div",
        { class: "enlaces" },
        afuera(sitio.front, "Abrir la página"),
        el("button", { type: "button", class: "enlace", onclick: () => irATickets(sitio.id) }, abiertos === 1 ? "1 ticket abierto" : `${abiertos} tickets abiertos`)
      )
    );
  }

  function dibujarEstado() {
    const generado = datos.ultimo?.generado;
    $("e-generado").textContent = generado ? `Último chequeo ${hace(generado)}, ${fecha(generado)}` : "Sin chequeos todavía";

    const incidentes = $("e-incidentes");
    if (datos.incidentes.length) {
      incidentes.replaceChildren(
        el(
          "div",
          { class: "incidentes" },
          el("h3", { text: datos.incidentes.length === 1 ? "1 incidente abierto" : `${datos.incidentes.length} incidentes abiertos` }),
          el(
            "ul",
            {},
            datos.incidentes.map((issue) =>
              el(
                "li",
                {},
                el("span", {}, el("strong", { text: issue.title }), " ", el("span", { class: "meta", text: `abierto ${hace(issue.created_at)}` })),
                issue.html_url?.startsWith("https://github.com/") ? afuera(issue.html_url, "Ver en GitHub") : null
              )
            )
          )
        )
      );
    } else {
      incidentes.replaceChildren(el("p", { class: "sin-incidentes", text: "Sin incidentes abiertos." }));
    }

    const lista = $("e-sitios");
    lista.replaceChildren(...datos.sitios.map(tarjetaSitio));
    if (!datos.sitios.length) lista.replaceChildren(el("p", { class: "hint", text: "sitios.json no tiene sitios." }));
  }

  async function chequearAhora() {
    const boton = $("e-chequear");
    boton.disabled = true;
    const pedido = Date.now();
    try {
      await gh(enRepo(`/actions/workflows/${WORKFLOW}/dispatches`), { metodo: "POST", cuerpo: { ref: rama } });
      aviso("e-msg", "Chequeo pedido. El resultado tarda uno o dos minutos.", "ok");
      await seguirCorrida(pedido);
    } catch (error) {
      aviso("e-msg", error.status === 404 ? "No se encontró el flujo de control en el repositorio" : error.message, "bad");
    } finally {
      boton.disabled = false;
    }
  }

  /** Espera a que termine la corrida pedida, mirando cada ocho segundos, hasta tres minutos. */
  async function seguirCorrida(desde) {
    for (let vuelta = 0; vuelta < 24; vuelta++) {
      await dormir(8000);
      if (!conectado) return;
      const respuesta = await gh(enRepo(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`));
      // Un minuto de tolerancia por la diferencia de reloj con GitHub.
      const corrida = (respuesta?.workflow_runs ?? []).find((c) => new Date(c.created_at).getTime() >= desde - 60_000);
      if (!corrida) continue;
      if (corrida.status !== "completed") {
        aviso("e-msg", "Chequeo en curso.", "ok");
        continue;
      }
      if (corrida.conclusion === "success") {
        await refrescarEstado();
        aviso("e-msg", "Chequeo terminado.", "ok");
      } else {
        aviso("e-msg", "El chequeo terminó con error. El detalle está en la pestaña Actions del repositorio.", "bad");
      }
      return;
    }
    aviso("e-msg", "El chequeo sigue en curso. Conviene actualizar en un rato.", "ok");
  }

  /* ---------- Railway ---------- */

  const esRailway = (sitio) => {
    try {
      return Boolean(sitio.railwayProjectId) || new URL(sitio.api).hostname.endsWith(".up.railway.app");
    } catch {
      return Boolean(sitio.railwayProjectId);
    }
  };

  /** El gasto acumulado del período, un punto por día. Una sola serie, un solo color. */
  function serieDeCosto(serie) {
    const DIAS = 31;
    const puntos = (Array.isArray(serie) ? serie : []).filter((p) => Number.isFinite(p?.usd) && /^\d{4}-\d{2}-\d{2}$/.test(p?.fecha ?? ""));
    if (puntos.length < 2) return null;

    // Siempre treinta y un días, el más nuevo a la derecha, y cada barra en su día: con
    // pocos datos las barras no se ensanchan, y un día sin chequeo queda como hueco.
    const ancho = 10;
    const alto = 60;
    const diaDe = (texto) => Math.round(new Date(`${texto}T12:00:00Z`).getTime() / 86_400_000);
    const ultimo = diaDe(puntos.at(-1).fecha);
    const visibles = puntos.filter((p) => ultimo - diaDe(p.fecha) < DIAS);
    const techo = Math.max(...visibles.map((p) => p.usd), 0.01);
    const dibujo = svg("svg", { class: "spark alta", viewBox: `0 0 ${DIAS * ancho} ${alto}`, preserveAspectRatio: "none", role: "img" });
    dibujo.setAttribute("aria-label", `Gasto acumulado por día, de ${usd(visibles[0].usd)} a ${usd(visibles.at(-1).usd)}`);

    const porDia = new Map(visibles.map((p) => [DIAS - 1 - (ultimo - diaDe(p.fecha)), p]));
    for (let lugar = 0; lugar < DIAS; lugar++) {
      const punto = porDia.get(lugar);
      if (!punto) {
        dibujo.append(svg("rect", { x: lugar * ancho, y: alto - 2, width: ancho - 3, height: 2, class: "vacio" }));
        continue;
      }
      const h = Math.max(2, Math.round((punto.usd / techo) * alto));
      const barra = svg("rect", { x: lugar * ancho, y: alto - h, width: ancho - 3, height: h, rx: 1.5, class: "costo" });
      const titulo = svg("title");
      titulo.textContent = `${punto.fecha}, ${usd(punto.usd)}`;
      barra.append(titulo);
      dibujo.append(barra);
    }

    const ultimoDia = new Date(`${puntos.at(-1).fecha}T12:00:00`);
    const primerDia = new Date(ultimoDia.getTime() - (DIAS - 1) * 86_400_000);
    return el(
      "div",
      {},
      el("h4", { text: "Gasto acumulado por día" }),
      dibujo,
      el("div", { class: "spark-pie" }, el("span", { text: fechaCorta.format(primerDia) }), el("span", { text: fechaCorta.format(ultimoDia) }))
    );
  }

  function cifra(rotulo, valor, chica) {
    return el("div", { class: "cifra" }, el("span", { class: "rotulo", text: rotulo }), el("span", { class: chica ? "valor chica" : "valor", text: valor }));
  }

  function dibujarRailway() {
    const rw = datos.ultimo?.railway;
    const destino = $("r-contenido");
    const partes = [];

    $("r-consultado").textContent = rw?.consultado ? `Uso y gasto del período, consultado ${hace(rw.consultado)}.` : "Uso y gasto del período, según el último chequeo.";

    if (!rw) {
      partes.push(el("p", { class: "hint", text: "Sin datos todavía." }));
    } else if (rw.estado === "sin token") {
      partes.push(el("div", { class: "card" }, el("h3", { text: "Sin token de Railway" }), el("p", { class: "hint", text: "El README del repositorio de datos explica cómo cargar RAILWAY_TOKEN." })));
    } else if (rw.estado === "error") {
      partes.push(el("div", { class: "msg bad", text: `No se pudo leer Railway. ${rw.mensaje ?? ""}` }));
    }

    const usados = new Set();
    for (const espacio of rw?.espacios ?? []) {
      const limites =
        espacio.limiteBlandoUsd || espacio.limiteDuroUsd
          ? [espacio.limiteBlandoUsd ? `aviso ${usd(espacio.limiteBlandoUsd)}` : "", espacio.limiteDuroUsd ? `corte ${usd(espacio.limiteDuroUsd)}` : ""].filter(Boolean).join(", ")
          : "Sin límite";
      // El período de Railway arranca a las 0 h UTC: en hora de Argentina sería el día anterior.
      const diaUtc = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", timeZone: "UTC" });
      const periodo = espacio.periodo ? `${diaUtc.format(new Date(espacio.periodo.inicio))} al ${diaUtc.format(new Date(espacio.periodo.fin))}` : "Sin dato";

      const filas = (espacio.proyectos ?? []).map((proyecto) => {
        const sitio = datos.sitios.find((s) => s.railwayProjectId && s.railwayProjectId === proyecto.id);
        if (sitio) usados.add(sitio.id);
        return el(
          "tr",
          {},
          el("td", {}, proyecto.nombre, proyecto.borrado ? el("span", { class: "sub-nombre", text: " (borrado)" }) : null, el("div", { class: "sub-nombre mono", text: proyecto.id })),
          el("td", { class: "num", text: usd(proyecto.usoUsd) }),
          el("td", { class: "num", text: usd(proyecto.estimadoUsd) }),
          el("td", { text: sitio ? sitio.nombre : "" })
        );
      });

      partes.push(
        el(
          "div",
          { class: "card" },
          el("div", { class: "sitio-cabeza" }, el("h3", {}, espacio.nombre ?? "Espacio de trabajo", espacio.plan ? el("span", { class: "pill", text: String(espacio.plan).toLowerCase() }) : null), espacio.superaLimite ? el("span", { class: "nivel falla", text: "Pasó el límite" }) : null),
          el("div", { class: "cifras" }, cifra("Uso del período", usd(espacio.usoUsd)), cifra("Estimado al cierre", usd(espacio.estimadoUsd)), cifra("Límites", limites, true), cifra("Período", periodo, true)),
          serieDeCosto(rw.serie),
          filas.length
            ? el(
                "table",
                {},
                el("thead", {}, el("tr", {}, el("th", { text: "Proyecto" }), el("th", { class: "num", text: "Uso" }), el("th", { class: "num", text: "Estimado" }), el("th", { text: "Sitio" }))),
                el("tbody", {}, filas)
              )
            : el("p", { class: "hint", text: "Sin proyectos con uso en el período." })
        )
      );
    }

    const sinDatos = datos.sitios.filter((sitio) => !usados.has(sitio.id));
    if (sinDatos.length) {
      partes.push(
        el(
          "div",
          { class: "card" },
          el("h3", { text: "Sin datos de uso" }),
          el(
            "ul",
            { class: "mini-lista" },
            sinDatos.map((sitio) => {
              let motivo = "Sin datos de uso";
              if (sitio.railwayProjectId && rw?.estado === "ok") motivo = "El proyecto no aparece en Railway";
              else if (!sitio.railwayProjectId && esRailway(sitio)) motivo = "Falta el id del proyecto en sitios.json";
              return el("li", {}, el("span", { text: sitio.nombre }), el("span", { class: "meta", text: motivo }));
            })
          )
        )
      );
    }

    destino.replaceChildren(...partes);
  }

  /* ---------- Clientes ---------- */

  function enlacesDeContacto(contacto = {}) {
    const enlaces = [];
    const wa = String(contacto.whatsapp ?? "").replace(/\D/g, "");
    if (wa.length >= 8 && wa.length <= 15) enlaces.push(afuera(`https://wa.me/${wa}`, "WhatsApp", "boton principal"));
    const tel = String(contacto.telefono ?? "").replace(/[^\d+]/g, "");
    if (tel.replace(/\D/g, "").length >= 6) enlaces.push(el("a", { href: `tel:${tel}`, class: "boton" }, "Llamar"));
    const mail = String(contacto.email ?? "").trim();
    if (/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(mail)) enlaces.push(el("a", { href: `mailto:${mail}`, class: "boton" }, "Mail"));
    return enlaces.filter(Boolean);
  }

  function dibujarClientes() {
    const tarjetas = datos.sitios.map((sitio) => {
      const contacto = sitio.contacto ?? {};
      const enlaces = enlacesDeContacto(contacto);
      const tickets = datos.abiertos.filter((ticket) => tieneEtiqueta(ticket, `cliente:${sitio.id}`));
      const notas = [...datos.notas.values()].filter((nota) => nota.cliente === sitio.id).sort((a, b) => b.fecha.localeCompare(a.fecha));

      return el(
        "article",
        { class: "card" },
        el("div", { class: "sitio-cabeza" }, el("h3", {}, sitio.nombre, el("span", { class: "pill", text: sitio.tipo === "turnero" ? "turnero" : "web" })), chipNivel(resultadoDe(sitio.id)?.nivel)),
        el("p", { class: "meta", text: contacto.nombre || "Sin contacto cargado" }),
        enlaces.length ? el("div", { class: "botones-contacto" }, enlaces) : el("p", { class: "hint", text: "Sin teléfono ni mail en sitios.json." }),
        contacto.notas ? el("p", { class: "nota-cliente", text: contacto.notas }) : null,
        el("h4", { text: tickets.length === 1 ? "1 ticket abierto" : `${tickets.length} tickets abiertos` }),
        el(
          "ul",
          { class: "mini-lista" },
          tickets.length
            ? tickets.slice(0, 6).map((ticket) => el("li", {}, el("button", { type: "button", onclick: () => irATickets(sitio.id, ticket.number) }, ticket.title), el("span", { class: "meta", text: `#${ticket.number}` })))
            : el("li", { class: "vacio", text: "Ninguno." })
        ),
        el("h4", { text: notas.length === 1 ? "1 nota" : `${notas.length} notas` }),
        el(
          "ul",
          { class: "mini-lista" },
          notas.length
            ? notas.slice(0, 6).map((nota) => el("li", {}, el("button", { type: "button", onclick: () => irANota(nota.ruta) }, nota.titulo), el("span", { class: "meta", text: `${TIPOS[nota.tipo]}, ${nota.fecha}` })))
            : el("li", { class: "vacio", text: "Ninguna." })
        ),
        el(
          "div",
          { class: "acciones" },
          el("button", { type: "button", class: "ghost chico", onclick: () => nuevoTicket(sitio.id) }, "Nuevo ticket"),
          el("button", { type: "button", class: "ghost chico", onclick: () => nuevaNota(sitio.id) }, "Nueva nota")
        )
      );
    });
    $("k-lista").replaceChildren(...tarjetas);
  }

  /* ---------- Tickets ---------- */

  let ticketElegido = null;

  function llenarSelectoresDeCliente() {
    const opciones = (conTodos, textoTodos) => [
      ...(conTodos ? [el("option", { value: "", text: textoTodos })] : []),
      ...datos.sitios.map((sitio) => el("option", { value: sitio.id, text: sitio.nombre })),
    ];
    for (const [id, todos, texto] of [
      ["t-f-cliente", true, "Todos"],
      ["n-f-cliente", true, "Todos"],
      ["t-cliente", true, "Sin cliente"],
      ["n-cliente", false, ""],
    ]) {
      const select = $(id);
      const valor = select.value;
      select.replaceChildren(...opciones(todos, texto));
      if ([...select.options].some((o) => o.value === valor)) select.value = valor;
    }
  }

  function ticketsFiltrados() {
    const cliente = $("t-f-cliente").value;
    const prioridad = $("t-f-prioridad").value;
    const texto = $("t-f-texto").value.trim().toLowerCase();
    return datos.tickets.filter(
      (ticket) =>
        (!cliente || tieneEtiqueta(ticket, `cliente:${cliente}`)) &&
        (!prioridad || tieneEtiqueta(ticket, `prioridad:${prioridad}`)) &&
        (!texto || `${ticket.title}\n${ticket.body ?? ""}\n#${ticket.number}`.toLowerCase().includes(texto))
    );
  }

  function pastillasDe(ticket) {
    const cliente = valorEtiqueta(ticket, "cliente:");
    const prioridad = valorEtiqueta(ticket, "prioridad:");
    return [
      ticket.state === "closed" ? el("span", { class: "pill cerrado", text: "cerrado" }) : null,
      cliente ? el("span", { class: "pill cliente", text: nombreCliente(cliente) }) : null,
      PRIORIDADES[prioridad] ? el("span", { class: `pill ${prioridad}`, text: PRIORIDADES[prioridad] }) : null,
    ];
  }

  function dibujarTickets() {
    const lista = $("t-lista");
    const tickets = ticketsFiltrados();
    lista.replaceChildren(
      ...(tickets.length
        ? tickets.map((ticket) =>
            el(
              "button",
              { type: "button", class: "item", "aria-current": ticketElegido === ticket.number ? "true" : null, onclick: () => abrirTicket(ticket.number) },
              el("span", { class: "titulo", text: ticket.title }),
              el(
                "span",
                { class: "linea" },
                el("span", { text: `#${ticket.number}` }),
                pastillasDe(ticket),
                el("span", { text: `actualizado ${hace(ticket.updated_at)}` }),
                ticket.comments ? el("span", { text: ticket.comments === 1 ? "1 comentario" : `${ticket.comments} comentarios` }) : null
              )
            )
          )
        : [el("p", { class: "vacio", text: "Sin tickets con estos filtros." })])
    );
    if (ticketElegido && !tickets.some((t) => t.number === ticketElegido)) cerrarDetalle();
  }

  function cerrarDetalle() {
    ticketElegido = null;
    $("t-detalle").hidden = true;
    $("t-detalle").replaceChildren();
  }

  async function abrirTicket(numero) {
    ticketElegido = numero;
    const ticket = datos.tickets.find((t) => t.number === numero) ?? datos.abiertos.find((t) => t.number === numero);
    if (!ticket) return;
    dibujarTickets();

    const detalle = $("t-detalle");
    const comentarios = el("div", {}, el("p", { class: "hint", text: "Cargando comentarios" }));
    const texto = el("textarea", { rows: 4, id: "t-comentario", "aria-label": "Comentario" });
    const mensaje = el("div");
    const abierto = ticket.state === "open";

    const comentar = el("button", { type: "button", class: "ghost chico" }, "Comentar");
    const cambiar = el("button", { type: "button", class: "chico" }, abierto ? "Cerrar ticket" : "Reabrir ticket");

    comentar.addEventListener("click", async () => {
      if (!texto.value.trim()) return aviso(mensaje, "Falta el comentario", "bad");
      comentar.disabled = true;
      try {
        await gh(enRepo(`/issues/${numero}/comments`), { metodo: "POST", cuerpo: { body: texto.value.trim() } });
        texto.value = "";
        ticket.comments = (ticket.comments ?? 0) + 1;
        await cargarComentarios(numero, comentarios);
        aviso(mensaje, "Comentario agregado", "ok");
      } catch (error) {
        aviso(mensaje, error.message, "bad");
      } finally {
        comentar.disabled = false;
      }
    });

    cambiar.addEventListener("click", async () => {
      cambiar.disabled = true;
      try {
        if (texto.value.trim()) await gh(enRepo(`/issues/${numero}/comments`), { metodo: "POST", cuerpo: { body: texto.value.trim() } });
        await gh(enRepo(`/issues/${numero}`), {
          metodo: "PATCH",
          cuerpo: abierto ? { state: "closed", state_reason: "completed" } : { state: "open" },
        });
        await cargarAbiertos();
        await cargarTickets();
        ticketElegido = null;
        dibujarTickets();
        cerrarDetalle();
        hecho(abierto ? `Ticket #${numero} cerrado` : `Ticket #${numero} reabierto`);
      } catch (error) {
        aviso(mensaje, error.message, "bad");
        cambiar.disabled = false;
      }
    });

    detalle.replaceChildren(
      el("h3", { text: ticket.title }),
      el(
        "div",
        { class: "linea meta" },
        `#${ticket.number}, abierto ${hace(ticket.created_at)}`,
        ticket.user?.login ? ` por ${ticket.user.login}` : "",
        " ",
        ...pastillasDe(ticket).filter(Boolean).flatMap((p) => [p, " "])
      ),
      ticket.html_url?.startsWith("https://github.com/") ? el("div", { class: "enlaces" }, afuera(ticket.html_url, "Ver en GitHub")) : null,
      el("div", { class: "cuerpo", text: ticket.body?.trim() || "Sin descripción." }),
      el("h4", { text: "Comentarios" }),
      comentarios,
      el("label", { for: "t-comentario", text: "Comentario" }),
      texto,
      el("div", { class: "acciones" }, el("button", { type: "button", class: "ghost chico", onclick: cerrarDetalle }, "Cerrar el detalle"), comentar, cambiar),
      mensaje
    );
    detalle.hidden = false;
    await cargarComentarios(numero, comentarios);
  }

  async function cargarComentarios(numero, destino) {
    try {
      const lista = await gh(enRepo(`/issues/${numero}/comments?per_page=100`));
      destino.replaceChildren(
        ...((lista ?? []).length
          ? lista.map((c) =>
              el(
                "div",
                { class: "comentario" },
                el("div", { class: "quien", text: `${c.user?.login ?? "alguien"}, ${hace(c.created_at)}` }),
                el("div", { class: "cuerpo", text: c.body ?? "" })
              )
            )
          : [el("p", { class: "hint", text: "Sin comentarios." })])
      );
    } catch (error) {
      destino.replaceChildren(el("p", { class: "hint", text: error.message }));
    }
  }

  function nuevoTicket(cliente = "") {
    mostrarVista("tickets");
    $("t-form").hidden = false;
    $("t-cliente").value = cliente;
    aviso("t-msg-form", "", "");
    $("t-titulo").focus();
  }

  function irATickets(cliente, numero) {
    $("t-f-cliente").value = cliente;
    $("t-f-estado").value = "open";
    datos.tickets = datos.abiertos;
    mostrarVista("tickets");
    if (numero) abrirTicket(numero);
  }

  async function crearTicket(evento) {
    evento.preventDefault();
    const titulo = $("t-titulo").value.trim();
    const cliente = $("t-cliente").value;
    const prioridad = $("t-prioridad").value;
    const cuerpo = $("t-texto").value.trim();
    if (!titulo) return aviso("t-msg-form", "Falta el título", "bad");

    const nombres = ["ticket", ...(cliente && ID_VALIDO.test(cliente) ? [`cliente:${cliente}`] : []), ...(PRIORIDADES[prioridad] ? [`prioridad:${prioridad}`] : [])];
    const boton = $("t-crear");
    boton.disabled = true;
    try {
      await asegurarEtiquetas(nombres);
      const ticket = await gh(enRepo("/issues"), { metodo: "POST", cuerpo: { title: titulo, body: cuerpo, labels: nombres } });
      $("t-titulo").value = "";
      $("t-texto").value = "";
      $("t-prioridad").value = "";
      $("t-form").hidden = true;
      await cargarAbiertos();
      // La lista de GitHub tarda un momento en mostrar un issue recién creado.
      if (!datos.abiertos.some((t) => t.number === ticket.number)) datos.abiertos.unshift(ticket);
      $("t-f-estado").value = "open";
      await cargarTickets();
      dibujarTickets();
      hecho(`Ticket #${ticket.number} creado`);
      abrirTicket(ticket.number);
    } catch (error) {
      aviso("t-msg-form", error.message, "bad");
    } finally {
      boton.disabled = false;
    }
  }

  /* ---------- Notas ---------- */

  let notaAbierta = null;

  function notasFiltradas() {
    const cliente = $("n-f-cliente").value;
    const tipo = $("n-f-tipo").value;
    return [...datos.notas.values()]
      .filter((nota) => (!cliente || nota.cliente === cliente) && (!tipo || nota.tipo === tipo))
      .sort((a, b) => b.fecha.localeCompare(a.fecha) || a.titulo.localeCompare(b.titulo));
  }

  function dibujarNotas() {
    const notas = notasFiltradas();
    const pendientes = datos.arbol.length > datos.notas.size;
    $("n-lista").replaceChildren(
      ...(notas.length
        ? notas.map((nota) =>
            el(
              "button",
              { type: "button", class: "item", "aria-current": notaAbierta === nota.ruta ? "true" : null, onclick: () => abrirNota(nota.ruta) },
              el("span", { class: "titulo", text: nota.titulo }),
              el("span", { class: "linea" }, el("span", { class: "pill", text: TIPOS[nota.tipo] }), el("span", { class: "pill cliente", text: nombreCliente(nota.cliente) }), el("span", { text: nota.fecha }))
            )
          )
        : [el("p", { class: "vacio", text: pendientes ? "Cargando notas" : "Sin notas con estos filtros." })])
    );
  }

  function abrirNota(ruta) {
    const nota = datos.notas.get(ruta);
    if (!nota) return;
    notaAbierta = ruta;
    $("n-editor-titulo").textContent = "Editar nota";
    $("n-ruta").textContent = ruta;
    $("n-cliente").value = nota.cliente;
    // El cliente decide la carpeta: cambiarlo sería mover el archivo, y eso no se hace desde acá.
    $("n-cliente").disabled = true;
    $("n-tipo").value = nota.tipo;
    $("n-fecha").value = nota.fecha;
    $("n-titulo").value = nota.titulo;
    $("n-texto").value = nota.cuerpo;
    aviso("n-msg", "", "");
    $("n-editor").hidden = false;
    dibujarNotas();
  }

  function nuevaNota(cliente) {
    mostrarVista("notas");
    notaAbierta = null;
    $("n-editor-titulo").textContent = "Nueva nota";
    $("n-ruta").textContent = "";
    $("n-cliente").disabled = false;
    if (cliente) $("n-cliente").value = cliente;
    $("n-tipo").value = "relevamiento";
    $("n-fecha").value = hoy();
    $("n-titulo").value = "";
    $("n-texto").value = "";
    aviso("n-msg", "", "");
    $("n-editor").hidden = false;
    dibujarNotas();
    $("n-titulo").focus();
  }

  function irANota(ruta) {
    mostrarVista("notas");
    abrirNota(ruta);
  }

  function cerrarNota() {
    notaAbierta = null;
    $("n-editor").hidden = true;
    dibujarNotas();
  }

  async function guardarNota(evento) {
    evento.preventDefault();
    const cliente = $("n-cliente").value;
    const tipo = $("n-tipo").value;
    const dia = $("n-fecha").value;
    const titulo = $("n-titulo").value.trim();
    const cuerpo = $("n-texto").value;

    if (!ID_VALIDO.test(cliente)) return aviso("n-msg", "Falta el cliente", "bad");
    if (!TIPOS[tipo]) return aviso("n-msg", "Falta el tipo", "bad");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return aviso("n-msg", "Falta la fecha", "bad");
    if (!titulo) return aviso("n-msg", "Falta el título", "bad");

    const existente = notaAbierta ? datos.notas.get(notaAbierta) : null;
    let ruta = existente?.ruta;
    if (!ruta) {
      const base = `notas/${cliente}/${dia}-${slug(titulo)}`;
      ruta = `${base}.md`;
      for (let n = 2; datos.arbol.some((entrada) => entrada.ruta === ruta); n++) ruta = `${base}-${n}.md`;
    }

    const contenido = escribirNota({ tipo, cliente, fecha: dia, titulo }, cuerpo);
    const boton = $("n-guardar");
    boton.disabled = true;
    try {
      const respuesta = await gh(rutaContenido(ruta), {
        metodo: "PUT",
        cuerpo: {
          message: `${existente ? "Nota editada" : "Nota nueva"} · ${titulo}`.slice(0, 120),
          content: aBase64(contenido),
          branch: rama,
          ...(existente ? { sha: existente.sha } : {}),
        },
      });
      const sha = respuesta?.content?.sha;
      const nota = { ruta, sha, cliente, fecha: dia, tipo, titulo, cuerpo };
      datos.notas.set(ruta, nota);
      const entrada = datos.arbol.find((e) => e.ruta === ruta);
      if (entrada) entrada.sha = sha;
      else datos.arbol.push({ ruta, sha, cliente, fecha: ruta.match(PATRON_NOTA)?.[2] ?? dia, slug: ruta.match(PATRON_NOTA)?.[3] ?? "" });
      notaAbierta = ruta;
      $("n-editor-titulo").textContent = "Editar nota";
      $("n-ruta").textContent = ruta;
      $("n-cliente").disabled = true;
      dibujarNotas();
      aviso("n-msg", "Nota guardada", "ok");
    } catch (error) {
      aviso("n-msg", error.status === 409 ? "La nota cambió en el repositorio. Actualizar la vista antes de guardar." : error.message, "bad");
    } finally {
      boton.disabled = false;
    }
  }

  /* ============================================================
     Arranque
     ============================================================ */

  function iniciar() {
    if (iniciado) return;
    iniciado = true;

    $("c-conectar").addEventListener("click", () => conectar());
    for (const id of ["c-repo", "c-token"]) {
      $(id).addEventListener("keydown", (evento) => {
        if (evento.key === "Enter") conectar();
      });
    }
    $("c-desconectar").addEventListener("click", desconectar);

    const botonesVista = [...document.querySelectorAll(".c-vistas button")];
    for (const boton of botonesVista) {
      boton.addEventListener("click", () => mostrarVista(boton.dataset.vista));
      boton.addEventListener("keydown", (evento) => {
        if (evento.key !== "ArrowRight" && evento.key !== "ArrowLeft") return;
        const i = botonesVista.indexOf(boton);
        const otro = botonesVista[(i + (evento.key === "ArrowRight" ? 1 : botonesVista.length - 1)) % botonesVista.length];
        mostrarVista(otro.dataset.vista);
        otro.focus();
      });
    }

    $("e-actualizar").addEventListener("click", async () => {
      $("e-actualizar").disabled = true;
      aviso("e-msg", "", "");
      await refrescarEstado();
      $("e-actualizar").disabled = false;
    });
    $("e-chequear").addEventListener("click", chequearAhora);

    $("t-nuevo").addEventListener("click", () => nuevoTicket($("t-f-cliente").value));
    $("t-cancelar").addEventListener("click", () => {
      $("t-form").hidden = true;
    });
    $("t-form").addEventListener("submit", crearTicket);
    $("t-f-estado").addEventListener("change", async () => {
      try {
        await cargarTickets();
      } catch (error) {
        aviso("c-aviso", error.message, "bad");
      }
      dibujarTickets();
    });
    for (const id of ["t-f-cliente", "t-f-prioridad"]) $(id).addEventListener("change", dibujarTickets);
    $("t-f-texto").addEventListener("input", dibujarTickets);

    $("n-nueva").addEventListener("click", () => nuevaNota($("n-f-cliente").value));
    $("n-cancelar").addEventListener("click", cerrarNota);
    $("n-editor").addEventListener("submit", guardarNota);
    for (const id of ["n-f-cliente", "n-f-tipo"]) $(id).addEventListener("change", dibujarNotas);

    try {
      const vista = localStorage.getItem(CLAVE_VISTA);
      if (VISTAS.includes(vista)) vistaActual = vista;
    } catch {}
    mostrarVista(vistaActual);

    let repoGuardado = "";
    let tokenGuardado = "";
    try { repoGuardado = localStorage.getItem(CLAVE_REPO) ?? ""; } catch {}
    try { tokenGuardado = sessionStorage.getItem(CLAVE_TOKEN) ?? ""; } catch {}
    $("c-repo").value = repoGuardado;

    if (repoGuardado && tokenGuardado) {
      token = tokenGuardado;
      conectar({ silencioso: true });
    } else {
      (repoGuardado ? $("c-token") : $("c-repo")).focus();
    }
  }

  // Se inicia la primera vez que se muestra el área, no antes: quien entra a crear un
  // administrador no tiene por qué disparar consultas a GitHub.
  document.addEventListener("consola:area", (evento) => {
    if (evento.detail === "control") iniciar();
  });
  if (!$("area-control").hidden) iniciar();
})();

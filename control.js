"use strict";

/*
 * El área Control de la consola.
 *
 * No entra a ningún turnero. Todo sale del repositorio privado de datos (ver
 * Control/control-datos): sitios.json, el último chequeo que deja la tarea de GitHub en
 * estado/ultimo.json, las corridas de esa tarea, los issues (incidentes y tickets) y las
 * notas. Se habla con la API de GitHub con un token de grano fino que ve solamente ese
 * repositorio, con Contents, Issues y Actions en lectura y escritura.
 *
 * Desde acá se edita todo sitios.json (sitios, contactos, umbrales, presupuesto de Railway,
 * a quién avisar), se atienden los incidentes y se sigue cada corrida paso por paso. Queda
 * para GitHub solo lo que el token no puede tocar, a propósito: los secretos (el token de
 * Railway), las variables y los flujos.
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
 *  - Los registros de una corrida no se piden. GitHub los sirve con una redirección a otro
 *    dominio, que la política de contenido de la página corta (y está bien que la corte).
 *    Lo que falló se saca de la lista de pasos, y el registro completo queda a un enlace.
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
  /** Cuántas corridas se listan. */
  const CORRIDAS = 8;
  /** Cada cuánto se mira una corrida en curso. */
  const VUELTA_CORRIDA_MS = 4000;
  /** Hasta cuándo se sigue una: el trabajo tiene cinco minutos de tope, más la cola. */
  const TOPE_SEGUIMIENTO_MS = 7 * 60 * 1000;
  /** Un chequeo más viejo que esto quiere decir que las corridas programadas no están entrando. */
  const VIEJO_MS = 90 * 60 * 1000;
  /** Lo que check.mjs usa si sitios.json no dice otra cosa. */
  const UMBRALES_POR_DEFECTO = { lentoMs: 5000, certificadoAvisoDias: 14, certificadoFallaDias: 3 };

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

  const ESTADO_CORRIDA = { queued: "En cola", in_progress: "En curso", pending: "En espera", waiting: "En espera", requested: "Pedida" };
  const FINAL_CORRIDA = {
    success: "Bien",
    failure: "Falló",
    cancelled: "Cancelada",
    timed_out: "Sin tiempo",
    skipped: "Salteada",
    startup_failure: "No arrancó",
    action_required: "Pide aprobación",
    neutral: "Terminada",
    stale: "Vencida",
  };
  const ORIGEN_CORRIDA = { schedule: "Programada", workflow_dispatch: "A mano", push: "Por un cambio" };
  const FALLIDAS = new Set(["failure", "timed_out", "startup_failure"]);

  /**
   * Qué suele querer decir que falle cada paso de control.yml. Las claves son los nombres de
   * los pasos del flujo: si se cambian allá, se cambian acá.
   */
  const PASOS = {
    "Verificar el script":
      "La huella de scripts/check.mjs no coincide con la de control.yml. El script cambió sin actualizar la huella, y la corrida se corta antes de darle el token de Railway.",
    "Chequear los sitios": "El script del chequeo no pudo terminar. Lo más común es un sitios.json mal armado.",
    "Guardar el estado": "No se pudo guardar estado/ultimo.json. Pasa si otra corrida guardó al mismo tiempo. La próxima lo arregla.",
  };
  const PASO_DE_GITHUB = "Falla de GitHub al preparar la máquina. Suele arreglarse sola en la próxima corrida.";

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
    for (const hijo of hijos.flat(2)) {
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

  /** Un enlace a GitHub, solo si de verdad apunta a github.com. */
  const aGitHub = (direccion, texto, clase) => (String(direccion ?? "").startsWith("https://github.com/") ? afuera(direccion, texto, clase) : null);

  /** El nombre de un sitio, como enlace a su página. Sin dirección válida, el nombre solo. */
  function nombreSitio(sitio) {
    const enlace = afuera(sitio.front, sitio.nombre, "sitio-link");
    if (enlace) enlace.title = "Abrir el sitio";
    return enlace ?? sitio.nombre;
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

  const chip = (texto, clase) => el("span", { class: `nivel ${clase}`, text: texto });

  function chipNivel(nivel) {
    const clase = NIVELES[nivel] ? nivel : "nada";
    return chip(NIVELES[nivel] ?? "Sin datos", clase);
  }

  const cargando = (texto = "Cargando") => el("p", { class: "cargando", text: texto });

  /** Un botón que dice que está trabajando, y vuelve a lo suyo al terminar. */
  async function trabajando(boton, texto, tarea) {
    const antes = boton.textContent;
    boton.disabled = true;
    boton.textContent = texto;
    try {
      return await tarea();
    } finally {
      boton.disabled = false;
      boton.textContent = antes;
    }
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
  const usd = (valor) => (valor !== null && valor !== "" && Number.isFinite(Number(valor)) ? dolares.format(Number(valor)) : "Sin dato");

  function duracion(ms) {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const segundos = Math.round(ms / 1000);
    if (segundos < 60) return `${segundos} s`;
    const minutos = Math.floor(segundos / 60);
    return segundos % 60 ? `${minutos} min ${segundos % 60} s` : `${minutos} min`;
  }

  /** La primera letra en minúscula, para encadenar un detalle detrás de una coma. */
  const seguido = (texto) => {
    const limpio = String(texto ?? "").trim();
    return limpio.charAt(0).toLowerCase() + limpio.slice(1);
  };

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

  function conEstado(error, estado, detalle = "") {
    error.status = estado;
    error.detalle = detalle;
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
      const error = conEstado(new Error(explicar(respuesta.status, mensaje, respuesta)), respuesta.status, String(mensaje).slice(0, 200));
      error.limite = /limitó/.test(error.message);
      throw error;
    }

    if (crudo) return texto;
    return texto ? JSON.parse(texto) : null;
  }

  const enRepo = (ruta) => `/repos/${repo}${ruta}`;
  const rutaContenido = (ruta) => enRepo(`/contents/${ruta.split("/").map(encodeURIComponent).join("/")}`);
  /** Una página del repositorio en github.com, para lo que se hace allá. */
  const enGitHub = (ruta = "") => `https://github.com/${repo}${ruta}`;

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

  /** Lo contrario: lo que devuelve la API de contenidos, de vuelta a texto. */
  function deBase64(base64) {
    const binario = atob(String(base64 ?? "").replace(/\s+/g, ""));
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
    return new TextDecoder().decode(bytes);
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
    /** Falso hasta la primera carga completa: mientras tanto se muestra "Cargando". */
    listo: false,
    /** sitios.json entero, tal como está en el repositorio, y su sha para poder guardarlo. */
    config: null,
    shaSitios: null,
    sitios: [],
    ultimo: null,
    incidentes: [],
    /** Los incidentes cerrados se piden recién cuando se quieren ver. */
    cerrados: null,
    abiertos: [],
    tickets: [],
    ticketsEstado: "open",
    arbol: [],
    notas: new Map(),
    /** null mientras no se cargaron. */
    corridas: null,
    errorCorridas: "",
    /** Los pasos de las corridas terminadas, que ya no cambian. */
    trabajos: new Map(),
  };

  const ID_VALIDO = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const sitioPorId = (id) => datos.sitios.find((sitio) => sitio.id === id) ?? null;
  const nombreCliente = (id) => sitioPorId(id)?.nombre ?? id;
  const sitiosValidos = (config) => (Array.isArray(config?.sitios) ? config.sitios : []).filter((sitio) => sitio && ID_VALIDO.test(String(sitio.id)));

  /**
   * sitios.json con su sha. Se pide en el formato de la API de contenidos (base64 más sha) y
   * no crudo, porque para guardarlo hay que decir qué versión se está pisando.
   */
  async function cargarSitios() {
    let archivo;
    try {
      archivo = await gh(`${rutaContenido("sitios.json")}?ref=${encodeURIComponent(rama)}`);
    } catch (error) {
      if (error.status === 404) throw conEstado(new Error("Falta sitios.json en el repositorio"), 404);
      throw error;
    }
    let config;
    try {
      config = JSON.parse(deBase64(archivo?.content));
    } catch {
      datos.config = null;
      throw new Error("sitios.json no es un JSON válido. Se arregla en GitHub, y hasta entonces no se edita desde acá");
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      datos.config = null;
      throw new Error("sitios.json no tiene la forma esperada");
    }
    datos.config = config;
    datos.shaSitios = archivo.sha ?? null;
    datos.sitios = sitiosValidos(config);
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

  async function cargarCerrados() {
    datos.cerrados = sinPedidos(await gh(enRepo("/issues?labels=incidente&state=closed&per_page=10&sort=updated")));
  }

  async function cargarAbiertos() {
    datos.abiertos = sinPedidos(await gh(enRepo("/issues?labels=ticket&state=open&per_page=100&sort=updated")));
  }

  async function cargarTickets() {
    const estado = $("t-f-estado").value;
    datos.ticketsEstado = estado;
    datos.tickets = estado === "open" ? datos.abiertos : sinPedidos(await gh(enRepo(`/issues?labels=ticket&state=${estado}&per_page=100&sort=updated`)));
  }

  /** Las últimas corridas del flujo. No tira: un token sin Actions no tiene que tapar el resto. */
  async function cargarCorridas() {
    try {
      const respuesta = await gh(enRepo(`/actions/workflows/${WORKFLOW}/runs?per_page=${CORRIDAS}`));
      datos.corridas = Array.isArray(respuesta?.workflow_runs) ? respuesta.workflow_runs : [];
      datos.errorCorridas = "";
    } catch (error) {
      datos.corridas ??= [];
      if (error.status === 404) datos.errorCorridas = "No se encontró el flujo control.yml en el repositorio.";
      else if (error.status === 403 && !error.limite) datos.errorCorridas = "El token no puede leer las corridas. Le falta el permiso Actions.";
      else datos.errorCorridas = error.message;
    }
  }

  /** Los pasos de una corrida. Los de una terminada no cambian, así que se guardan. */
  async function trabajosDe(corrida, { forzar = false } = {}) {
    if (!forzar && datos.trabajos.has(corrida.id)) return datos.trabajos.get(corrida.id);
    const respuesta = await gh(enRepo(`/actions/runs/${encodeURIComponent(corrida.id)}/jobs?per_page=20`));
    const trabajos = Array.isArray(respuesta?.jobs) ? respuesta.jobs : [];
    if (corrida.status === "completed") datos.trabajos.set(corrida.id, trabajos);
    return trabajos;
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

  /** Minúsculas, números y guiones, sin acentos. Sirve para las notas y para el id de un sitio. */
  function aGuiones(texto, largo) {
    return String(texto ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, largo)
      .replace(/-+$/, "");
  }

  const slug = (texto) => aGuiones(texto, 60) || "nota";

  /* ============================================================
     sitios.json: validar y guardar
     ============================================================ */

  /*
   * Las reglas son las que necesita scripts/check.mjs para chequear sin tropezar, más las
   * que necesita esta página para armar los enlaces de contacto:
   *  - el id es la etiqueta cliente:<id> y la carpeta de notas, así que va en minúsculas,
   *    números y guiones (el mismo patrón que usa check.mjs para no saltearlo);
   *  - las direcciones van con https (check.mjs lee el certificado, y sin https es aviso);
   *  - un turnero sin servidor no se puede chequear entero;
   *  - teléfono y WhatsApp, solo números y espacios (wa.me no acepta otra cosa).
   * Los umbrales, el presupuesto y los usuarios a avisar van con los tipos que check.mjs
   * compara: números y nombres de usuario de GitHub.
   */
  const SOLO_NUMEROS = /^\d[\d ]*$/;
  const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
  const USUARIO_GITHUB = /^[A-Za-z0-9-]{1,39}$/;
  const ID_RAILWAY = /^[A-Za-z0-9-]{1,64}$/;
  const digitos = (texto) => String(texto).replace(/\D/g, "").length;

  function esHttps(texto) {
    try {
      const url = new URL(texto);
      return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  }

  /** El primer problema de un sitio como [campo, texto], o null si está bien. */
  function problemaDeSitio(sitio, { nuevo, ids }) {
    if (!sitio.nombre) return ["nombre", "Falta el nombre"];
    if (!ID_VALIDO.test(sitio.id)) return ["id", "El id va en minúsculas, con números y guiones"];
    if (nuevo && ids.includes(sitio.id)) return ["id", "Ya hay un sitio con ese id"];
    if (sitio.tipo !== "turnero" && sitio.tipo !== "web") return ["tipo", "Falta el tipo"];
    if (!esHttps(sitio.front)) return ["front", "La página va con https://"];
    if (sitio.tipo === "turnero" && !sitio.api) return ["api", "Un turnero necesita la dirección del servidor"];
    if (sitio.api && !esHttps(sitio.api)) return ["api", "El servidor va con https://"];
    if (sitio.railwayProjectId && !ID_RAILWAY.test(sitio.railwayProjectId)) return ["railway", "El id del proyecto va con letras, números y guiones"];
    const contacto = sitio.contacto;
    if (contacto.telefono && (!SOLO_NUMEROS.test(contacto.telefono) || digitos(contacto.telefono) < 6)) return ["telefono", "El teléfono va solo con números y espacios"];
    if (contacto.whatsapp && (!SOLO_NUMEROS.test(contacto.whatsapp) || digitos(contacto.whatsapp) < 8 || digitos(contacto.whatsapp) > 15))
      return ["whatsapp", "El WhatsApp va con código de país, solo números y espacios"];
    if (contacto.email && !EMAIL.test(contacto.email)) return ["email", "El mail no parece válido"];
    return null;
  }

  /** Un entero de un campo de texto, o NaN. */
  const entero = (texto) => (/^\d{1,6}$/.test(String(texto).trim()) ? Number(String(texto).trim()) : NaN);

  function problemaDeAjustes({ umbrales, avisar }) {
    const { lentoMs, certificadoAvisoDias, certificadoFallaDias } = umbrales;
    if (!Number.isInteger(lentoMs) || lentoMs < 100 || lentoMs > 15000) return ["lento", "Lento va de 100 a 15000 ms"];
    if (!Number.isInteger(certificadoAvisoDias) || certificadoAvisoDias < 1 || certificadoAvisoDias > 90) return ["cert-aviso", "El aviso de certificado va de 1 a 90 días"];
    if (!Number.isInteger(certificadoFallaDias) || certificadoFallaDias >= certificadoAvisoDias) return ["cert-falla", "La falla de certificado va en menos días que el aviso"];
    const malo = avisar.find((usuario) => !USUARIO_GITHUB.test(usuario));
    if (malo) return ["avisar", `${malo} no es un usuario de GitHub válido`];
    return null;
  }

  /** Dólares escritos a mano, con coma o con punto. "" es sin presupuesto. */
  function leerPresupuesto(texto) {
    const limpio = String(texto).replace(/US\$|\$|\s/gi, "").replace(",", ".");
    if (!limpio) return { valor: null };
    const valor = Number(limpio);
    if (!/^\d+(\.\d{1,2})?$/.test(limpio) || !(valor > 0) || valor > 100000) return { problema: "El presupuesto va en dólares, mayor que cero y con hasta dos decimales" };
    return { valor };
  }

  /** Marca el campo con el problema y lo dice. Sin campo, limpia las marcas. */
  function marcar(formulario, idCampo, texto, destino) {
    for (const campo of formulario.querySelectorAll("[aria-invalid]")) campo.removeAttribute("aria-invalid");
    if (idCampo && $(idCampo)) {
      $(idCampo).setAttribute("aria-invalid", "true");
      $(idCampo).focus();
    }
    aviso(destino, texto, "bad");
  }

  let guardandoSitios = false;

  /**
   * Cambia sitios.json en el repositorio con un commit. `cambiar` recibe una copia de lo que
   * hay y la modifica en el lugar; si devuelve un texto, es un problema y no se guarda nada.
   *
   * Va con el sha de la versión leída: si alguien lo cambió en el medio (otra pestaña, un
   * commit a mano), GitHub contesta 409 y no se pisa nada. Entonces se recarga y se pide
   * repetir el cambio, que ya sale sobre la versión nueva.
   *
   * Se escribe con dos espacios y un salto al final, como el archivo de siempre, y sin
   * tocar los campos que esta página no conoce.
   */
  async function guardarConfig(mensaje, cambiar) {
    if (!datos.config || !datos.shaSitios) throw new Error("sitios.json no se pudo leer. Hay que arreglarlo en GitHub antes de editar desde acá");
    if (guardandoSitios) throw new Error("Hay otro cambio guardándose. Probar de nuevo en un momento");
    const copia = structuredClone(datos.config);
    const problema = cambiar(copia);
    if (problema) throw new Error(problema);

    guardandoSitios = true;
    try {
      const respuesta = await gh(rutaContenido("sitios.json"), {
        metodo: "PUT",
        cuerpo: {
          message: `Sitios · ${mensaje}`.slice(0, 120),
          content: aBase64(`${JSON.stringify(copia, null, 2)}\n`),
          sha: datos.shaSitios,
          branch: rama,
        },
      });
      datos.config = copia;
      datos.sitios = sitiosValidos(copia);
      datos.shaSitios = respuesta?.content?.sha ?? null;
      if (!datos.shaSitios) await cargarSitios();
      llenarSelectoresDeCliente();
    } catch (error) {
      if (error.status === 409 || error.status === 422) {
        try {
          await cargarSitios();
          llenarSelectoresDeCliente();
        } catch {
          /* el mensaje de abajo alcanza */
        }
        throw conEstado(new Error("sitios.json cambió en el repositorio mientras tanto. Ya se recargó. Revisar y guardar otra vez."), error.status);
      }
      throw error;
    } finally {
      guardandoSitios = false;
    }
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
      datos.listo = false;
      $("c-repo-nombre").textContent = repo;
      $("c-conexion").hidden = true;
      $("c-panel").hidden = false;
      aviso(
        "c-aviso",
        info?.private === false ? "El repositorio es público. Los datos de los clientes quedan a la vista de cualquiera. Conviene pasarlo a privado." : "",
        "bad"
      );
      dibujarVista();
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
    seguimiento = null;
    generacion++;
    try { sessionStorage.removeItem(CLAVE_TOKEN); } catch {}
    if (temporizador) clearInterval(temporizador);
    temporizador = null;
    $("c-panel").hidden = true;
    $("c-conexion").hidden = false;
    aviso("c-msg-conexion", "", "");
    $("c-token").focus();
  }

  async function refrescarTodo() {
    const resultados = await Promise.allSettled([cargarSitios(), cargarUltimo(), cargarIncidentes(), cargarAbiertos(), cargarArbol(), cargarCorridas()]);
    const fallas = resultados.filter((r) => r.status === "rejected").map((r) => r.reason?.message ?? "Error");
    if (fallas.length) aviso("c-aviso", [...new Set(fallas)].join(". "), "bad");

    llenarSelectoresDeCliente();
    try {
      await cargarTickets();
    } catch (error) {
      aviso("c-aviso", error.message, "bad");
    }
    if (datos.cerrados) await cargarCerrados().catch(() => {});
    datos.listo = true;
    dibujarVista();
    prepararUltimaFalla();
    vigilarCorridaEnCurso();

    try {
      await cargarNotas();
    } catch (error) {
      aviso("c-aviso", error.message, "bad");
    }
    if ((vistaActual === "notas" || vistaActual === "clientes") && !ocupado()) dibujarVista();
  }

  async function refrescarEstado() {
    try {
      await Promise.all([cargarUltimo(), cargarIncidentes(), cargarCorridas()]);
    } catch (error) {
      aviso("e-msg", error.message, "bad");
    }
    if ((vistaActual === "estado" || vistaActual === "railway") && !ocupado()) dibujarVista();
    else dibujarResumen();
    prepararUltimaFalla();
    vigilarCorridaEnCurso();
  }

  function refrescoPeriodico() {
    if (!conectado || document.visibilityState !== "visible" || $("area-control").hidden) return;
    refrescarEstado();
  }

  /**
   * Si se está escribiendo algo en la vista. Un redibujo la armaría de nuevo y se perdería
   * lo escrito, así que el refresco periódico espera.
   */
  function ocupado() {
    const activo = document.activeElement;
    return Boolean(activo?.matches?.("input, textarea, select") && activo.closest(`#v-${vistaActual}`));
  }

  /* ============================================================
     Vistas
     ============================================================ */

  const VISTAS = ["estado", "railway", "clientes", "tickets", "notas", "ajustes"];
  let vistaActual = "estado";

  function mostrarVista(nombre) {
    vistaActual = VISTAS.includes(nombre) ? nombre : "estado";
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
    dibujarResumen();
    if (!datos.listo) return mostrarCargando();
    if (vistaActual === "estado") dibujarEstado();
    else if (vistaActual === "railway") dibujarRailway();
    else if (vistaActual === "clientes") dibujarClientes();
    else if (vistaActual === "tickets") dibujarTickets();
    else if (vistaActual === "notas") dibujarNotas();
    else if (vistaActual === "ajustes") dibujarAjustes();
  }

  function mostrarCargando() {
    for (const id of ["e-incidentes", "e-corridas"]) $(id).replaceChildren();
    for (const id of ["e-sitios", "r-contenido", "k-lista", "t-lista", "n-lista", "a-github"]) $(id).replaceChildren(cargando("Leyendo el repositorio"));
  }

  /** Lleva a un sitio del estado y lo resalta un momento. */
  function irA(vista, idElemento) {
    mostrarVista(vista);
    const destino = idElemento && $(idElemento);
    if (!destino) return window.scrollTo({ top: 0, behavior: "smooth" });
    destino.scrollIntoView({ behavior: "smooth", block: "start" });
    destino.classList.add("resaltado");
    setTimeout(() => destino.classList.remove("resaltado"), 1600);
  }

  /* ---------- Resumen ---------- */

  const resultadoDe = (id) => (datos.ultimo?.sitios ?? []).find((sitio) => sitio.id === id) ?? null;
  const ultimaTerminada = () => (datos.corridas ?? []).find((corrida) => corrida.status === "completed") ?? null;
  const corridaFallida = (corrida) => corrida?.status === "completed" && FALLIDAS.has(corrida.conclusion);

  function presupuestoActual() {
    const valor = datos.config?.railway?.presupuestoMensualUsd;
    return valor !== null && valor !== "" && Number(valor) > 0 ? Number(valor) : null;
  }

  /**
   * Todo lo que está mal ahora, del más grave al más leve. Cada problema dice qué es, el
   * detalle y adónde ir a verlo.
   */
  function problemas() {
    const lista = [];

    for (const sitio of datos.sitios) {
      const resultado = resultadoDe(sitio.id);
      if (resultado?.nivel !== "falla" && resultado?.nivel !== "aviso") continue;
      const malos = (resultado.controles ?? []).filter((control) => control.nivel === "falla" || control.nivel === "aviso");
      lista.push({
        nivel: resultado.nivel,
        titulo: sitio.nombre,
        detalle: malos.map((control) => `${control.nombre}, ${seguido(control.detalle)}`).join(". ") || NIVELES[resultado.nivel],
        ir: () => irA("estado", `sitio-${sitio.id}`),
      });
    }

    const generado = datos.ultimo?.generado;
    if (generado && Date.now() - new Date(generado).getTime() > VIEJO_MS) {
      lista.push({
        nivel: "aviso",
        titulo: "Chequeo atrasado",
        detalle: `El último es de ${hace(generado)}. Las corridas programadas no están entrando.`,
        ir: () => irA("estado", "e-corridas"),
      });
    }

    const ultima = ultimaTerminada();
    if (corridaFallida(ultima)) {
      const paso = queFallo(ultima, datos.trabajos.get(ultima.id) ?? [])[0]?.paso;
      lista.push({
        nivel: "aviso",
        titulo: "La última corrida falló",
        detalle: `#${ultima.run_number}, ${hace(ultima.created_at)}${paso ? `. Falló en ${paso}` : ""}.`,
        ir: () => irA("estado", "e-corridas"),
      });
    }

    const rw = datos.ultimo?.railway;
    if (rw?.estado === "error") lista.push({ nivel: "aviso", titulo: "Railway", detalle: `No se pudo leer el uso. ${rw.mensaje ?? ""}`.trim(), ir: () => irA("railway") });
    else if (rw?.estado === "sin token") lista.push({ nivel: "aviso", titulo: "Railway", detalle: "Falta el token. Se carga en GitHub.", ir: () => irA("railway") });
    const presupuesto = presupuestoActual();
    for (const espacio of rw?.espacios ?? []) {
      const nombre = espacio.nombre ?? "El espacio de trabajo";
      if (espacio.superaLimite) lista.push({ nivel: "falla", titulo: "Railway", detalle: `${nombre} pasó el límite de uso.`, ir: () => irA("railway") });
      if (presupuesto && Number(espacio.estimadoUsd) > presupuesto)
        lista.push({ nivel: "aviso", titulo: "Railway", detalle: `El estimado al cierre es ${usd(espacio.estimadoUsd)} y el presupuesto ${usd(presupuesto)}.`, ir: () => irA("railway") });
    }

    return lista.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === "falla" ? -1 : 1));
  }

  function dibujarResumen() {
    const caja = $("c-resumen");
    if (!datos.listo) return caja.replaceChildren(el("div", { class: "resumen nada" }, cargando("Leyendo el repositorio")));

    const lista = problemas();
    const compacto = vistaActual !== "estado";
    const generado = datos.ultimo?.generado;

    if (!lista.length) {
      if (!datos.ultimo) {
        return caja.replaceChildren(
          el(
            "div",
            { class: "resumen nada" },
            el("span", { class: "resumen-marca" }),
            el("div", {}, el("strong", { text: "Sin chequeos todavía" }), compacto ? null : el("p", { text: "El primero corre solo en menos de media hora, o ahora con Chequear ahora." }))
          )
        );
      }
      const sinChequear = datos.sitios.filter((sitio) => !resultadoDe(sitio.id)).length;
      const bien = datos.sitios.length - sinChequear;
      const partes = [
        `${bien === 1 ? "1 sitio bien" : `${bien} sitios bien`}${sinChequear ? `, ${sinChequear} sin chequear todavía` : ""}`,
        `Último chequeo ${hace(generado)}`,
      ];
      return caja.replaceChildren(
        el("div", { class: `resumen ok${compacto ? " compacto" : ""}` }, el("span", { class: "resumen-marca" }), el("div", {}, el("strong", { text: "Todo en orden" }), el("p", { text: `${partes.join(". ")}.` })))
      );
    }

    const peor = lista.some((p) => p.nivel === "falla") ? "falla" : "aviso";
    const titulo = lista.length === 1 ? "1 problema" : `${lista.length} problemas`;

    if (compacto) {
      const nombres = [...new Set(lista.map((p) => p.titulo))].join(", ");
      return caja.replaceChildren(
        el(
          "div",
          { class: `resumen ${peor} compacto` },
          el("span", { class: "resumen-marca" }),
          el("div", { class: "crece" }, el("strong", { text: titulo }), el("p", { text: `${nombres}.` })),
          el("button", { type: "button", class: "enlace", onclick: () => mostrarVista("estado") }, "Ver en Estado")
        )
      );
    }

    caja.replaceChildren(
      el(
        "div",
        { class: `resumen ${peor}` },
        el("span", { class: "resumen-marca" }),
        el(
          "div",
          { class: "crece" },
          el("strong", { text: titulo }),
          el(
            "ul",
            {},
            lista.map((p) =>
              el(
                "li",
                {},
                el("span", { class: `punto ${p.nivel}` }),
                el("span", { class: "que" }, el("span", { class: "quien", text: p.titulo }), " ", el("span", { class: "detalle", text: p.detalle })),
                p.ir ? el("button", { type: "button", class: "enlace", onclick: p.ir }, "Ver") : null
              )
            )
          )
        )
      )
    );
  }

  /* ---------- Estado ---------- */

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
      ? [`${NIVELES[nivel] ?? "Sin datos"} desde ${hace(resultado.desde)}`, resultado.version ? `versión ${resultado.version}` : ""].filter(Boolean).join(" · ")
      : "Todavía sin chequear. Aparece después de la próxima corrida.";

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
      { class: `card sitio ${nivel ?? ""}`, id: `sitio-${sitio.id}` },
      el(
        "div",
        { class: "sitio-cabeza" },
        el("h3", {}, nombreSitio(sitio), el("span", { class: "pill", text: sitio.tipo === "turnero" ? "turnero" : "web" })),
        chipNivel(nivel)
      ),
      el("p", { class: "meta", text: meta }),
      resultado ? serieDe(resultado.serie) : null,
      controles.length ? el("ul", { class: "controles" }, controles) : null,
      vivo,
      el(
        "div",
        { class: "enlaces" },
        afuera(sitio.front, "Abrir la página"),
        el("button", { type: "button", class: "enlace", onclick: () => irATickets(sitio.id) }, abiertos === 1 ? "1 ticket abierto" : `${abiertos} tickets abiertos`),
        el("button", { type: "button", class: "enlace", onclick: () => editarSitio(sitio.id) }, "Editar")
      )
    );
  }

  function dibujarEstado() {
    const generado = datos.ultimo?.generado;
    $("e-generado").textContent = generado ? `Último chequeo ${hace(generado)}, ${fecha(generado)}` : "Sin chequeos todavía";
    $("e-chequear").disabled = Boolean(seguimiento && !seguimiento.terminado);

    dibujarSeguimiento();
    dibujarIncidentes();

    const lista = $("e-sitios");
    if (datos.sitios.length) lista.replaceChildren(...datos.sitios.map(tarjetaSitio));
    else
      lista.replaceChildren(
        el(
          "div",
          { class: "card vacio-grande" },
          el("p", { text: "Todavía no hay sitios para chequear." }),
          el("button", { type: "button", class: "chico", onclick: () => editarSitio(null) }, "Agregar el primero")
        )
      );

    dibujarCorridas();
  }

  /* ---------- Incidentes ---------- */

  /** Los detalles abiertos y lo escrito en cada uno, para que un redibujo no los pierda. */
  const desplegados = new Set();
  const borradores = new Map();
  let verCerrados = false;

  const nivelDeIncidente = (issue) => (/^falla/i.test(issue.title ?? "") ? "falla" : /^aviso/i.test(issue.title ?? "") ? "aviso" : "nada");

  function dibujarIncidentes() {
    const caja = $("e-incidentes");
    const abiertos = datos.incidentes;
    const alternar = el(
      "button",
      {
        type: "button",
        class: "enlace",
        "aria-expanded": String(verCerrados),
        onclick: async () => {
          verCerrados = !verCerrados;
          if (verCerrados && !datos.cerrados) {
            dibujarIncidentes();
            try {
              await cargarCerrados();
            } catch (error) {
              datos.cerrados = [];
              aviso("e-msg", error.message, "bad");
            }
          }
          dibujarIncidentes();
        },
      },
      verCerrados ? "Ocultar los cerrados" : "Ver los cerrados"
    );

    const partes = [
      el("div", { class: "bloque-cabeza" }, el("h3", { text: abiertos.length === 1 ? "1 incidente abierto" : abiertos.length ? `${abiertos.length} incidentes abiertos` : "Incidentes" }), alternar),
      abiertos.length
        ? el("div", { class: "incidentes-lista" }, abiertos.map(itemIncidente))
        : el("p", { class: "vacio-linea" }, el("span", { class: "punto ok" }), " Sin incidentes abiertos."),
    ];

    if (verCerrados) {
      partes.push(el("h4", { text: "Cerrados hace poco" }));
      if (!datos.cerrados) partes.push(cargando("Buscando los cerrados"));
      else if (!datos.cerrados.length) partes.push(el("p", { class: "vacio-linea", text: "No hay incidentes cerrados." }));
      else partes.push(el("div", { class: "incidentes-lista" }, datos.cerrados.map(itemIncidente)));
    }

    caja.replaceChildren(...partes);
  }

  function itemIncidente(issue) {
    const numero = issue.number;
    const abierto = issue.state === "open";
    const nivel = abierto ? nivelDeIncidente(issue) : "cerrado";
    const cliente = valorEtiqueta(issue, "cliente:");
    const cuerpo = el("div", { class: "inc-cuerpo" });
    const detalles = el(
      "details",
      { class: `incidente ${nivel}`, open: desplegados.has(numero) },
      el(
        "summary",
        {},
        el("span", { class: "inc-titulo" }, abierto ? chip(NIVELES[nivel] ?? "Abierto", nivel) : chip("Cerrado", "nada"), el("strong", { text: issue.title })),
        el(
          "span",
          { class: "meta" },
          `#${numero}`,
          cliente && sitioPorId(cliente) ? `, ${nombreCliente(cliente)}` : "",
          abierto ? `, abierto ${hace(issue.created_at)}` : `, cerrado ${hace(issue.closed_at ?? issue.updated_at)}`
        )
      ),
      cuerpo
    );

    const llenar = () => {
      if (cuerpo.childElementCount) return;
      cuerpo.append(
        ...panelIssue(issue, {
          incidente: true,
          idTexto: `i-comentario-${numero}`,
          despues: [aGitHub(issue.html_url, "Ver en GitHub")],
          alCambiar: async (estabaAbierto) => {
            desplegados.delete(numero);
            await Promise.all([cargarIncidentes(), datos.cerrados ? cargarCerrados() : null]);
            dibujarIncidentes();
            dibujarResumen();
            hecho(estabaAbierto ? `Incidente #${numero} cerrado` : `Incidente #${numero} reabierto`);
          },
        })
      );
    };
    if (detalles.open) llenar();
    detalles.addEventListener("toggle", () => {
      if (detalles.open) {
        desplegados.add(numero);
        llenar();
      } else desplegados.delete(numero);
    });
    return detalles;
  }

  /*
   * El cuerpo de un incidente, como lo escribe check.mjs: párrafos con alguna negrita, una
   * tabla de controles y las menciones. Se arma con nodos: lo que no es tabla queda como
   * texto, sin interpretar nada más.
   */
  const PALABRA_NIVEL = { bien: "ok", aviso: "aviso", falla: "falla", dato: "info" };

  const celdas = (linea) =>
    linea
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((celda) => celda.replace(/\\\|/g, "|").replace(/\*\*/g, "").trim());

  function celdaConNivel(texto) {
    const nivel = PALABRA_NIVEL[texto.toLowerCase()];
    return nivel ? [el("span", { class: `punto ${nivel}` }), " ", texto] : texto;
  }

  function textoConTablas(texto) {
    const limpio = String(texto ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
    const caja = el("div", { class: "cuerpo rico" });
    if (!limpio) return el("div", { class: "cuerpo", text: "Sin descripción." });
    for (const bloque of limpio.split(/\r?\n[ \t]*\r?\n/)) {
      const lineas = bloque.split(/\r?\n/).filter((linea) => linea.trim());
      if (!lineas.length) continue;
      if (lineas.length >= 2 && lineas.every((linea) => linea.trim().startsWith("|"))) {
        const [cabeza, ...filas] = lineas.filter((linea) => !/^[\s|:-]+$/.test(linea)).map(celdas);
        caja.append(
          el(
            "div",
            { class: "tabla-md" },
            el(
              "table",
              {},
              el("thead", {}, el("tr", {}, cabeza.map((celda) => el("th", { text: celda })))),
              el("tbody", {}, filas.map((fila) => el("tr", {}, fila.map((celda) => el("td", {}, celdaConNivel(celda))))))
            )
          )
        );
      } else {
        caja.append(el("p", { text: lineas.join("\n").replace(/\*\*/g, "") }));
      }
    }
    return caja;
  }

  /**
   * El detalle de un issue, ticket o incidente, con sus comentarios, para comentar y para
   * cerrarlo o reabrirlo. `alCambiar` corre después de cerrarlo o reabrirlo.
   */
  function panelIssue(issue, { incidente = false, idTexto, antes = [], botones = [], despues = [], alCambiar }) {
    const numero = issue.number;
    const abierto = issue.state === "open";
    const comentarios = el("div", { class: "comentarios" });
    const texto = el("textarea", { rows: 3, id: idTexto });
    texto.value = borradores.get(numero) ?? "";
    texto.addEventListener("input", () => (texto.value ? borradores.set(numero, texto.value) : borradores.delete(numero)));
    const mensaje = el("div", { role: "status" });
    const nombre = incidente ? "incidente" : "ticket";

    const comentar = el("button", { type: "button", class: "ghost chico" }, "Comentar");
    const cambiar = el("button", { type: "button", class: "chico" }, `${abierto ? "Cerrar" : "Reabrir"} ${nombre}`);

    comentar.addEventListener("click", async () => {
      const cuerpo = texto.value.trim();
      if (!cuerpo) return aviso(mensaje, "Falta el comentario", "bad");
      await trabajando(comentar, "Comentando", async () => {
        try {
          await gh(enRepo(`/issues/${numero}/comments`), { metodo: "POST", cuerpo: { body: cuerpo } });
          texto.value = "";
          borradores.delete(numero);
          issue.comments = (issue.comments ?? 0) + 1;
          await cargarComentarios(numero, comentarios, incidente);
          aviso(mensaje, "Comentario agregado", "ok");
        } catch (error) {
          aviso(mensaje, error.message, "bad");
        }
      });
    });

    cambiar.addEventListener("click", async () => {
      comentar.disabled = true;
      await trabajando(cambiar, abierto ? "Cerrando" : "Reabriendo", async () => {
        try {
          const cuerpo = texto.value.trim();
          if (cuerpo) await gh(enRepo(`/issues/${numero}/comments`), { metodo: "POST", cuerpo: { body: cuerpo } });
          await gh(enRepo(`/issues/${numero}`), {
            metodo: "PATCH",
            cuerpo: abierto ? { state: "closed", state_reason: "completed" } : { state: "open" },
          });
          borradores.delete(numero);
          await alCambiar(abierto);
        } catch (error) {
          aviso(mensaje, error.message, "bad");
        }
      });
      comentar.disabled = false;
    });

    cargarComentarios(numero, comentarios, incidente);

    // Va directo a replaceChildren, que escribiría "null" por cada hueco: se filtran.
    return [
      ...antes,
      incidente ? textoConTablas(issue.body) : el("div", { class: "cuerpo", text: issue.body?.trim() || "Sin descripción." }),
      el("h4", { text: "Comentarios" }),
      comentarios,
      el("label", { for: idTexto, text: "Comentario" }),
      texto,
      el("div", { class: "acciones" }, ...botones, comentar, cambiar),
      incidente
        ? el("p", {
            class: "ayuda",
            text: abierto
              ? "Cerrarlo no arregla nada. Si el problema sigue, el próximo chequeo abre otro."
              : "Si el sitio ya está bien, el próximo chequeo lo vuelve a cerrar.",
          })
        : null,
      mensaje,
      despues.some(Boolean) ? el("div", { class: "enlaces" }, despues) : null,
    ].filter(Boolean);
  }

  async function cargarComentarios(numero, destino, rico = false) {
    if (!destino.childElementCount) destino.replaceChildren(cargando("Cargando comentarios"));
    try {
      const lista = await gh(enRepo(`/issues/${numero}/comments?per_page=100`));
      destino.replaceChildren(
        ...((lista ?? []).length
          ? lista.map((c) =>
              el(
                "div",
                { class: "comentario" },
                el("div", { class: "quien", text: `${c.user?.login ?? "alguien"}, ${hace(c.created_at)}` }),
                rico ? textoConTablas(c.body) : el("div", { class: "cuerpo", text: c.body ?? "" })
              )
            )
          : [el("p", { class: "hint", text: "Sin comentarios." })])
      );
    } catch (error) {
      destino.replaceChildren(el("p", { class: "hint", text: error.message }));
    }
  }

  /* ---------- Corridas ---------- */

  function estadoDeCorrida(corrida) {
    if (corrida.status !== "completed") return { texto: ESTADO_CORRIDA[corrida.status] ?? "En curso", clase: "curso" };
    const clase = corrida.conclusion === "success" ? "ok" : FALLIDAS.has(corrida.conclusion) ? "falla" : "nada";
    return { texto: FINAL_CORRIDA[corrida.conclusion] ?? "Terminada", clase };
  }

  function explicarPaso(nombre) {
    if (PASOS[nombre]) return PASOS[nombre];
    if (/^(Set up job|Complete job|Run actions\/|Post Run actions\/)/.test(nombre)) return PASO_DE_GITHUB;
    return "";
  }

  /** Qué falló en una corrida, paso por paso, con lo que suele querer decir. */
  function queFallo(corrida, trabajos) {
    if (corrida.conclusion === "startup_failure") return [{ paso: "El arranque", explicacion: "El flujo no llegó a arrancar. Suele ser un error en control.yml." }];
    const fallas = [];
    for (const trabajo of trabajos) {
      const pasos = Array.isArray(trabajo.steps) ? trabajo.steps : [];
      const malos = pasos.filter((paso) => paso.conclusion === "failure" || paso.conclusion === "timed_out");
      for (const paso of malos) fallas.push({ paso: String(paso.name ?? "Un paso sin nombre"), explicacion: explicarPaso(String(paso.name ?? "")) });
      if (!malos.length && FALLIDAS.has(trabajo.conclusion)) {
        fallas.push({
          paso: String(trabajo.name ?? "El trabajo"),
          explicacion: !pasos.length
            ? "La corrida no llegó a empezar. Puede que se hayan terminado los minutos de Actions del mes."
            : trabajo.conclusion === "timed_out"
              ? "Pasó los cinco minutos que tiene de tope."
              : "",
        });
      }
    }
    return fallas;
  }

  function nodosDeFalla(corrida, fallas) {
    return [
      ...(fallas.length
        ? fallas.map((falla) => el("div", { class: "falla-paso" }, el("strong", {}, "Falló en ", falla.paso), falla.explicacion ? el("p", { text: falla.explicacion }) : null))
        : [el("p", { class: "hint", text: "GitHub no marca ningún paso. El registro completo está en la corrida." })]),
      el("div", { class: "enlaces" }, aGitHub(corrida.html_url, "Ver la corrida en GitHub")),
    ];
  }

  async function mostrarQueFallo(corrida, destino) {
    if (!datos.trabajos.has(corrida.id)) destino.replaceChildren(cargando("Buscando el paso que falló"));
    try {
      destino.replaceChildren(...nodosDeFalla(corrida, queFallo(corrida, await trabajosDe(corrida))));
    } catch (error) {
      destino.replaceChildren(el("p", { class: "hint", text: error.message }), el("div", { class: "enlaces" }, aGitHub(corrida.html_url, "Ver la corrida en GitHub")));
    }
  }

  /** Los pasos de la última corrida fallida se piden solos, para que el resumen diga dónde falló. */
  async function prepararUltimaFalla() {
    const ultima = ultimaTerminada();
    if (!corridaFallida(ultima) || datos.trabajos.has(ultima.id)) return;
    try {
      await trabajosDe(ultima);
    } catch {
      return;
    }
    dibujarResumen();
    if (vistaActual === "estado" && !ocupado()) dibujarCorridas();
  }

  const corridasDesplegadas = new Set();

  function filaCorrida(corrida, indice) {
    const { texto, clase } = estadoDeCorrida(corrida);
    const inicio = corrida.run_started_at ?? corrida.created_at;
    const dura = corrida.status === "completed" ? duracion(new Date(corrida.updated_at).getTime() - new Date(inicio).getTime()) : "";
    const quien = corrida.event === "workflow_dispatch" && corrida.triggering_actor?.login ? `, ${corrida.triggering_actor.login}` : "";

    const fila = el(
      "li",
      { class: "corrida" },
      chip(texto, clase),
      el("span", { class: "corrida-que" }, el("strong", { text: `#${corrida.run_number ?? "?"}` }), ` ${ORIGEN_CORRIDA[corrida.event] ?? corrida.event ?? ""}${quien}`),
      el("span", { class: "meta", title: fecha(corrida.created_at), text: `${hace(corrida.created_at)}${dura ? `, duró ${dura}` : ""}` }),
      aGitHub(corrida.html_url, "GitHub", "corrida-enlace")
    );

    if (corridaFallida(corrida)) {
      // La última que falló se muestra abierta; las anteriores, a pedido.
      const abierta = corridasDesplegadas.has(corrida.id) || (indice === 0 && !corridasDesplegadas.has(-corrida.id));
      const contenido = el("div", { class: "corrida-detalle" });
      const detalles = el("details", { class: "corrida-falla", open: abierta }, el("summary", { text: "Qué falló" }), contenido);
      if (abierta) mostrarQueFallo(corrida, contenido);
      detalles.addEventListener("toggle", () => {
        if (detalles.open) {
          corridasDesplegadas.add(corrida.id);
          corridasDesplegadas.delete(-corrida.id);
          mostrarQueFallo(corrida, contenido);
        } else {
          corridasDesplegadas.delete(corrida.id);
          corridasDesplegadas.add(-corrida.id);
        }
      });
      fila.append(detalles);
    }
    return fila;
  }

  function dibujarCorridas() {
    const caja = $("e-corridas");
    const cabeza = el(
      "div",
      { class: "bloque-cabeza" },
      el("h3", { text: "Últimas corridas" }),
      afuera(enGitHub(`/actions/workflows/${WORKFLOW}`), "Todas en GitHub")
    );
    if (datos.errorCorridas && !datos.corridas?.length) return caja.replaceChildren(cabeza, el("div", { class: "msg bad", text: datos.errorCorridas }));
    if (datos.corridas === null) return caja.replaceChildren(cabeza, cargando());
    if (!datos.corridas.length) return caja.replaceChildren(cabeza, el("p", { class: "vacio-linea", text: "Todavía no hay corridas. La primera llega sola en menos de media hora." }));
    const primeraFallida = datos.corridas.findIndex(corridaFallida);
    caja.replaceChildren(
      cabeza,
      el("p", { class: "hint", text: "Cada media hora corre una sola. Las de a mano son las de Chequear ahora." }),
      el("ul", { class: "corridas" }, datos.corridas.map((corrida, i) => filaCorrida(corrida, i === primeraFallida && corrida === ultimaTerminada() ? 0 : 1)))
    );
  }

  /* ---------- Chequear ahora ---------- */

  /**
   * La corrida que se está siguiendo: la pedida con Chequear ahora, o una que ya estaba en
   * curso al cargar. `generacion` corta los seguimientos viejos al desconectar.
   */
  let seguimiento = null;
  let generacion = 0;

  const FASES = [
    ["pedido", "Pedido"],
    ["cola", "En cola"],
    ["curso", "En curso"],
    ["fin", "Terminado"],
  ];

  function faseDe(s) {
    if (!s.corrida) return "pedido";
    if (s.corrida.status === "completed") return "fin";
    if (s.corrida.status === "in_progress") return "curso";
    return "cola";
  }

  function textoDeSeguimiento(s) {
    if (s.error) return s.error;
    if (s.terminado) {
      if (s.mensaje) return s.mensaje;
      const que = s.ajena ? "La corrida" : "El chequeo";
      const finales = {
        success: `${que} terminó. Todo quedó actualizado.`,
        failure: `${que} falló.`,
        timed_out: `${que} se quedó sin tiempo.`,
        cancelled: `${que} se canceló.`,
        startup_failure: `${que} no arrancó.`,
      };
      return finales[s.corrida?.conclusion] ?? `${que} terminó.`;
    }
    if (!s.corrida) return s.pidiendo ? "Pidiendo el chequeo a GitHub." : "Pedido. GitHub tarda unos segundos en tomarlo.";
    const { status } = s.corrida;
    if (status === "pending" || status === "waiting") return "En espera. Hay otra corrida en curso y esta va después.";
    if (status === "queued" || status === "requested") return "En cola. Esperando una máquina de GitHub.";
    return s.paso ? `En curso. ${s.paso}.` : "En curso.";
  }

  function dibujarSeguimiento() {
    const caja = $("e-progreso");
    $("e-chequear").disabled = Boolean(seguimiento && !seguimiento.terminado);
    if (!seguimiento) return caja.replaceChildren();

    const s = seguimiento;
    const fase = faseDe(s);
    const actual = FASES.findIndex(([clave]) => clave === fase);
    const salio = s.corrida?.status === "completed" ? (s.corrida.conclusion === "success" ? "bien" : "mal") : s.error ? "mal" : "";
    const pasos = el(
      "ol",
      { class: "fases" },
      FASES.map(([, texto], i) =>
        el("li", { class: i < actual ? "hecha" : i === actual ? (salio || (s.terminado ? "hecha" : "actual")) : "", "aria-current": i === actual ? "step" : null }, texto)
      )
    );

    const clase = s.error || (s.corrida?.status === "completed" && s.corrida.conclusion !== "success") ? "mal" : s.terminado ? "bien" : "";
    const corre = s.corrida && s.corrida.status !== "completed" ? duracion(Date.now() - new Date(s.corrida.created_at).getTime()) : "";

    caja.replaceChildren(
      el(
        "div",
        { class: `progreso ${clase}` },
        el(
          "div",
          { class: "progreso-cabeza" },
          el("strong", { text: s.ajena ? `Corrida ${s.corrida ? `#${s.corrida.run_number} ` : ""}en curso` : `Chequeo${s.corrida ? ` #${s.corrida.run_number}` : ""}` }),
          corre ? el("span", { class: "meta", text: `hace ${corre}` }) : null,
          s.terminado ? el("button", { type: "button", class: "enlace", onclick: () => ((seguimiento = null), dibujarSeguimiento()) }, "Cerrar") : null
        ),
        pasos,
        el("p", { class: "progreso-texto", text: textoDeSeguimiento(s) }),
        s.fallas ? el("div", { class: "progreso-fallas" }, nodosDeFalla(s.corrida, s.fallas)) : null,
        !s.fallas && s.corrida && !s.terminado ? el("div", { class: "enlaces" }, aGitHub(s.corrida.html_url, "Ver la corrida en GitHub")) : null
      )
    );
  }

  function mensajeDeDisparo(error) {
    if (error.status === 404) return "No se encontró el flujo control.yml en el repositorio.";
    if (error.status === 403 && !error.limite) return "El token no puede disparar corridas. Le falta el permiso Actions en lectura y escritura.";
    if (error.status === 422) return "GitHub no aceptó el pedido. Puede que el flujo esté desactivado en la pestaña Actions del repositorio.";
    return error.message;
  }

  function terminarSeguimiento(cambios) {
    if (!seguimiento) return;
    Object.assign(seguimiento, cambios, { terminado: true });
    dibujarSeguimiento();
  }

  /** Pone una corrida en la lista, o la reemplaza si ya estaba, y redibuja la lista. */
  function anotarCorrida(corrida) {
    const lista = datos.corridas ?? [];
    const i = lista.findIndex((c) => c.id === corrida.id);
    if (i >= 0) lista[i] = corrida;
    else lista.unshift(corrida);
    datos.corridas = lista.slice(0, CORRIDAS);
    if (vistaActual === "estado") dibujarCorridas();
  }

  async function chequearAhora() {
    if (seguimiento && !seguimiento.terminado) return;
    const mia = ++generacion;
    seguimiento = { pidiendo: true, desde: Date.now() };
    aviso("e-msg", "", "");
    dibujarSeguimiento();
    try {
      // Las corridas de a mano que ya había, para reconocer la nueva entre ellas.
      const antes = await gh(enRepo(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=10`));
      const conocidas = new Set((antes?.workflow_runs ?? []).map((corrida) => corrida.id));
      await gh(enRepo(`/actions/workflows/${WORKFLOW}/dispatches`), { metodo: "POST", cuerpo: { ref: rama } });
      seguimiento.pidiendo = false;
      dibujarSeguimiento();

      let corrida = null;
      for (let vuelta = 0; vuelta < 20 && !corrida; vuelta++) {
        await dormir(vuelta ? VUELTA_CORRIDA_MS : 2000);
        if (mia !== generacion) return;
        const respuesta = await gh(enRepo(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=5`));
        // Dos minutos de tolerancia por la diferencia de reloj con GitHub.
        corrida = (respuesta?.workflow_runs ?? []).find((c) => !conocidas.has(c.id) && new Date(c.created_at).getTime() >= seguimiento.desde - 120_000) ?? null;
      }
      if (!corrida) return terminarSeguimiento({ mensaje: "GitHub todavía no tomó el pedido. El resultado aparece solo al actualizar, en unos minutos." });
      await seguirCorrida(corrida, mia);
    } catch (error) {
      if (mia === generacion) terminarSeguimiento({ error: mensajeDeDisparo(error) });
    }
  }

  /** Mira una corrida hasta que termina, con el paso que está corriendo. */
  async function seguirCorrida(corrida, mia) {
    seguimiento.corrida = corrida;
    const tope = Date.now() + TOPE_SEGUIMIENTO_MS;
    let tropiezos = 0;

    while (corrida.status !== "completed") {
      if (mia !== generacion) return;
      if (Date.now() > tope) return terminarSeguimiento({ mensaje: "La corrida sigue en curso. El resultado aparece solo al actualizar." });
      if (corrida.status === "in_progress") {
        try {
          const paso = (await trabajosDe(corrida, { forzar: true })).flatMap((t) => t.steps ?? []).find((p) => p.status === "in_progress");
          seguimiento.paso = paso?.name ?? "";
        } catch {
          /* sin el paso se sigue igual */
        }
      }
      seguimiento.corrida = corrida;
      dibujarSeguimiento();
      anotarCorrida(corrida);
      await dormir(VUELTA_CORRIDA_MS);
      if (mia !== generacion) return;
      try {
        corrida = await gh(enRepo(`/actions/runs/${encodeURIComponent(corrida.id)}`));
        tropiezos = 0;
      } catch (error) {
        if (++tropiezos >= 4) throw error;
      }
    }

    seguimiento.corrida = corrida;
    anotarCorrida(corrida);
    if (corrida.conclusion === "success") {
      await refrescarEstado();
      if (mia !== generacion) return;
      // Una corrida programada que terminó bien no necesita quedar a la vista.
      if (seguimiento.ajena) {
        seguimiento = null;
        return dibujarSeguimiento();
      }
      return terminarSeguimiento({});
    }

    let fallas = [];
    try {
      fallas = queFallo(corrida, await trabajosDe(corrida, { forzar: true }));
    } catch {
      /* queda el enlace a la corrida */
    }
    if (mia !== generacion) return;
    terminarSeguimiento({ fallas });
    await refrescarEstado();
  }

  /** Si al cargar hay una corrida en curso, se la sigue también: al terminar se actualiza solo. */
  function vigilarCorridaEnCurso() {
    // Un seguimiento que terminó mal queda a la vista hasta que se lo cierra.
    if (seguimiento && (!seguimiento.terminado || seguimiento.error || seguimiento.fallas)) return;
    const enCurso = (datos.corridas ?? []).find((corrida) => corrida.status !== "completed");
    if (!enCurso) return;
    const mia = ++generacion;
    seguimiento = { ajena: true, desde: new Date(enCurso.created_at).getTime(), corrida: enCurso };
    dibujarSeguimiento();
    seguirCorrida(enCurso, mia).catch((error) => {
      if (mia === generacion) terminarSeguimiento({ error: error.message });
    });
  }

  /* ---------- Railway ---------- */

  const esRailway = (sitio) => {
    try {
      return Boolean(sitio.railwayProjectId) || new URL(sitio.api).hostname.endsWith(".up.railway.app");
    } catch {
      return Boolean(sitio.railwayProjectId);
    }
  };

  const TOKENS_RAILWAY = {
    proyecto: ["Token de proyecto", "Ve el uso de un solo proyecto. El nombre del espacio de trabajo, el plan y los límites de Railway no se leen con este token."],
    espacio: ["Token de espacio de trabajo", "Ve los proyectos de un espacio de trabajo."],
    cuenta: ["Token de cuenta", "Ve todos los espacios de trabajo de la cuenta."],
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

  /** Una barra de cuánto del presupuesto se va, con el color según cuánto falta. */
  function barraDe(valor, tope) {
    const proporcion = Math.max(0, Math.min(1, valor / tope));
    const clase = valor > tope ? "pasado" : valor > tope * 0.8 ? "cerca" : "dentro";
    return svg(
      "svg",
      { class: "barra", viewBox: "0 0 100 8", preserveAspectRatio: "none", role: "img", "aria-label": `${Math.round((valor / tope) * 100)} % del presupuesto` },
      svg("rect", { x: 0, y: 0, width: 100, height: 8, class: "fondo" }),
      svg("rect", { x: 0, y: 0, width: Math.max(1, proporcion * 100), height: 8, class: clase })
    );
  }

  /** Cómo se carga el token de Railway, que es lo único de Railway que no se hace desde acá. */
  function comoCargarToken(abierto) {
    return el(
      "details",
      { class: "como", open: abierto },
      el("summary", { text: abierto ? "Cómo se carga" : "Cómo se cambia" }),
      el("p", {
        class: "hint",
        text: "Es un secreto de GitHub Actions, RAILWAY_TOKEN. El token de esta página no tiene permiso sobre los secretos, a propósito, así que se carga en GitHub.",
      }),
      el(
        "ol",
        { class: "pasos" },
        el("li", { text: "En Railway, abrir el proyecto y entrar a Settings → Tokens. Crear un token del entorno donde corre el servidor." }),
        el("li", {}, "En GitHub, abrir ", afuera(enGitHub("/settings/secrets/actions"), "los secretos de Actions del repositorio"), "."),
        el("li", { text: "Editar RAILWAY_TOKEN, o crearlo con ese nombre si no está, pegar el token y guardar." }),
        el("li", { text: "Volver acá y tocar Chequear ahora. En un minuto el uso aparece en esta vista." })
      ),
      el("p", { class: "ayuda", text: "Un token de cuenta o de espacio de trabajo también sirve y ve más proyectos. Se crea en Railway, en Account Settings → Tokens." })
    );
  }

  function tarjetaToken(rw) {
    if (!rw) {
      return el("section", { class: "card" }, el("h3", { text: "Token de Railway" }), el("p", { class: "hint", text: "Sin datos todavía. Aparecen después del primer chequeo." }), comoCargarToken(false));
    }
    if (rw.estado === "sin token") {
      return el(
        "section",
        { class: "card sitio aviso" },
        el("div", { class: "sitio-cabeza" }, el("h3", { text: "Falta el token de Railway" }), chip("Sin token", "aviso")),
        el("p", { class: "hint", text: "El chequeo de las páginas corre igual. Sin el token no hay uso ni gasto." }),
        comoCargarToken(true)
      );
    }
    if (rw.estado === "error") {
      return el(
        "section",
        { class: "card sitio falla" },
        el("div", { class: "sitio-cabeza" }, el("h3", { text: "Railway no se pudo leer" }), chip("Error", "falla")),
        el("div", { class: "msg bad", text: rw.mensaje || "Sin detalle del error." }),
        el("p", { class: "hint", text: "Suele ser un token vencido o borrado, o espacios de trabajo cargados con un token que no es de cuenta." }),
        comoCargarToken(false)
      );
    }
    const [nombre, explicacion] = TOKENS_RAILWAY[rw.token] ?? ["Token de Railway", "El chequeo no dijo de qué clase es."];
    return el(
      "section",
      { class: "card" },
      el("div", { class: "sitio-cabeza" }, el("h3", { text: "Token de Railway" }), chip(nombre, "ok")),
      el("p", { class: "hint", text: explicacion }),
      comoCargarToken(false)
    );
  }

  function tarjetaPresupuesto(espacios) {
    const actual = presupuestoActual();
    const entrada = el("input", { id: "r-presupuesto", type: "text", inputmode: "decimal", autocomplete: "off", placeholder: "Por ejemplo 10", "aria-describedby": "r-presupuesto-ayuda" });
    entrada.value = actual === null ? "" : String(actual).replace(".", ",");
    const mensaje = el("div", { role: "status" });
    const guardar = el("button", { type: "submit", class: "chico" }, "Guardar");
    const quitar = el("button", { type: "button", class: "ghost chico", hidden: actual === null }, "Quitar");
    const formulario = el("form", { class: "en-fila", novalidate: true }, el("div", { class: "con-unidad" }, el("span", { text: "US$" }), entrada), guardar, quitar);

    const guardarValor = (valor, boton) =>
      trabajando(boton, "Guardando", async () => {
        try {
          await guardarConfig(valor === null ? "sin presupuesto de Railway" : `presupuesto de Railway US$ ${valor}`, (config) => {
            config.railway = { workspaceIds: [], ...(config.railway ?? {}), presupuestoMensualUsd: valor };
          });
          dibujarRailway();
          dibujarResumen();
          hecho(valor === null ? "Presupuesto quitado" : `Presupuesto guardado, ${usd(valor)} por mes`);
        } catch (error) {
          marcar(formulario, error.status ? null : "r-presupuesto", error.message, mensaje);
        }
      });

    formulario.addEventListener("submit", (evento) => {
      evento.preventDefault();
      const { valor, problema } = leerPresupuesto(entrada.value);
      if (problema) return marcar(formulario, "r-presupuesto", problema, mensaje);
      if (valor === actual) return aviso(mensaje, "Es el mismo presupuesto que ya está", "bad");
      guardarValor(valor, guardar);
    });
    quitar.addEventListener("click", () => guardarValor(null, quitar));

    const comparaciones = espacios
      .filter((espacio) => Number.isFinite(Number(espacio.estimadoUsd)) && actual)
      .map((espacio) => {
        const estimado = Number(espacio.estimadoUsd);
        const quien = espacios.length > 1 ? `${espacio.nombre ?? "Un espacio"}. ` : "";
        const texto =
          estimado > actual
            ? `${quien}El estimado al cierre, ${usd(estimado)}, pasa el presupuesto. Se abre un incidente.`
            : `${quien}El estimado al cierre es ${usd(estimado)}, el ${Math.round((estimado / actual) * 100)} % del presupuesto.`;
        return el("div", { class: "comparacion" }, barraDe(estimado, actual), el("p", { class: "meta", text: texto }));
      });

    return el(
      "section",
      { class: "card" },
      el("h3", { text: "Presupuesto mensual" }),
      el("p", { class: "valor-grande", text: actual === null ? "Sin presupuesto" : usd(actual) }),
      comparaciones,
      el("label", { for: "r-presupuesto", text: actual === null ? "Cargar un presupuesto" : "Cambiar el presupuesto" }),
      formulario,
      el("p", { class: "ayuda", id: "r-presupuesto-ayuda", text: "Si el estimado al cierre del mes lo pasa, se abre un incidente." }),
      mensaje
    );
  }

  /**
   * Un proyecto de Railway con su sitio. El sitio se cambia ahí mismo: se elige y se guarda,
   * y queda en railwayProjectId de sitios.json. Un proyecto va con un solo sitio.
   */
  function filaProyecto(proyecto) {
    const elegido = datos.sitios.find((sitio) => sitio.railwayProjectId && sitio.railwayProjectId === proyecto.id) ?? null;
    const celda = el("td", { class: "sitio-celda" });
    const mensaje = el("div", { role: "status" });

    const mostrar = () => {
      celda.replaceChildren(
        el(
          "div",
          { class: "asignado" },
          elegido ? nombreSitio(elegido) : el("span", { class: "sin", text: "Sin sitio" }),
          // Un proyecto borrado ya no se asigna; si tenía sitio, se le puede sacar.
          proyecto.borrado && !elegido ? null : el("button", { type: "button", class: "enlace", disabled: !datos.config, onclick: elegir }, elegido ? "Cambiar" : "Asignar")
        ),
        mensaje
      );
    };

    function elegir() {
      const lista = el(
        "select",
        { "aria-label": `Sitio del proyecto ${proyecto.nombre}` },
        el("option", { value: "", text: "Sin sitio" }),
        datos.sitios.map((sitio) => el("option", { value: sitio.id, text: sitio.nombre }))
      );
      lista.value = elegido?.id ?? "";
      const guardar = el("button", { type: "button", class: "chico" }, "Guardar");
      const cancelar = el("button", { type: "button", class: "ghost chico", onclick: mostrar }, "Cancelar");
      guardar.addEventListener("click", () =>
        trabajando(guardar, "Guardando", async () => {
          const id = lista.value;
          if (id === (elegido?.id ?? "")) return mostrar();
          try {
            await guardarConfig(id ? `proyecto de Railway de ${id}` : `proyecto de Railway ${proyecto.id} sin sitio`, (config) => {
              const sitios = Array.isArray(config.sitios) ? config.sitios : [];
              for (const sitio of sitios) if (sitio?.railwayProjectId === proyecto.id && sitio.id !== id) sitio.railwayProjectId = "";
              if (!id) return null;
              const sitio = sitios.find((s) => s?.id === id);
              if (!sitio) return "Ese sitio ya no está en sitios.json";
              sitio.railwayProjectId = proyecto.id;
              return null;
            });
            dibujarRailway();
            hecho(id ? `${proyecto.nombre} quedó con ${nombreCliente(id)}` : `${proyecto.nombre} quedó sin sitio`);
          } catch (error) {
            aviso(mensaje, error.message, "bad");
          }
        })
      );
      celda.replaceChildren(el("div", { class: "eligiendo" }, lista, guardar, cancelar), mensaje);
      lista.focus();
    }

    mostrar();
    return el(
      "tr",
      {},
      el("td", {}, el("span", { class: "proyecto-nombre", text: proyecto.nombre }), proyecto.borrado ? el("span", { class: "sub-nombre", text: " (borrado)" }) : null, el("div", { class: "sub-nombre mono", text: proyecto.id })),
      el("td", { class: "num", "data-rotulo": "Uso", text: usd(proyecto.usoUsd) }),
      el("td", { class: "num", "data-rotulo": "Estimado", text: usd(proyecto.estimadoUsd) }),
      celda
    );
  }

  function tarjetaEspacio(espacio, rw, conSerie) {
    const soloProyecto = rw.token === "proyecto";
    const hayLimite = espacio.limiteBlandoUsd || espacio.limiteDuroUsd;
    const limites = hayLimite
      ? [espacio.limiteBlandoUsd ? `aviso ${usd(espacio.limiteBlandoUsd)}` : "", espacio.limiteDuroUsd ? `corte ${usd(espacio.limiteDuroUsd)}` : ""].filter(Boolean).join(", ")
      : "Sin límite";
    // El período de Railway arranca a las 0 h UTC: en hora de Argentina sería el día anterior.
    const diaUtc = new Intl.DateTimeFormat("es-AR", { day: "numeric", month: "short", timeZone: "UTC" });
    const periodo = espacio.periodo ? `${diaUtc.format(new Date(espacio.periodo.inicio))} al ${diaUtc.format(new Date(espacio.periodo.fin))}` : null;

    const cifras = [cifra("Uso del período", usd(espacio.usoUsd)), cifra("Estimado al cierre", usd(espacio.estimadoUsd))];
    if (hayLimite || !soloProyecto) cifras.push(cifra("Límites", limites, true));
    if (periodo) cifras.push(cifra("Período", periodo, true));

    const proyectos = espacio.proyectos ?? [];
    return el(
      "section",
      { class: "card" },
      el(
        "div",
        { class: "sitio-cabeza" },
        el("h3", {}, espacio.nombre ?? (soloProyecto ? "Uso del proyecto" : "Espacio de trabajo"), espacio.plan ? el("span", { class: "pill", text: String(espacio.plan).toLowerCase() }) : null),
        espacio.superaLimite ? chip("Pasó el límite", "falla") : null
      ),
      el("div", { class: "cifras" }, cifras),
      conSerie ? serieDeCosto(rw.serie) : null,
      proyectos.length
        ? el(
            "table",
            { class: "proyectos" },
            el("thead", {}, el("tr", {}, el("th", { text: "Proyecto" }), el("th", { class: "num", text: "Uso" }), el("th", { class: "num", text: "Estimado" }), el("th", { text: "Sitio" }))),
            el("tbody", {}, proyectos.map(filaProyecto))
          )
        : el("p", { class: "vacio-linea", text: "Sin proyectos con uso en el período." })
    );
  }

  /** Los espacios de trabajo de sitios.json. Casi siempre van vacíos; ver la ayuda. */
  function tarjetaEspaciosDeTrabajo(rw) {
    const ids = Array.isArray(datos.config?.railway?.workspaceIds) ? datos.config.railway.workspaceIds : [];
    const entrada = el("input", { id: "r-espacios", class: "mono", type: "text", autocomplete: "off", spellcheck: "false", placeholder: "Vacío, salen del token", "aria-describedby": "r-espacios-ayuda" });
    entrada.value = ids.join(", ");
    const mensaje = el("div", { role: "status" });
    const guardar = el("button", { type: "submit", class: "chico" }, "Guardar");
    const formulario = el("form", { class: "en-fila", novalidate: true }, entrada, guardar);

    formulario.addEventListener("submit", (evento) => {
      evento.preventDefault();
      const nuevos = [...new Set(entrada.value.split(/[\s,;]+/).filter(Boolean))];
      const malo = nuevos.find((id) => !ID_RAILWAY.test(id));
      if (malo) return marcar(formulario, "r-espacios", `${malo} no parece un id de Railway`, mensaje);
      if (JSON.stringify(nuevos) === JSON.stringify(ids)) return aviso(mensaje, "No hay cambios para guardar", "bad");
      trabajando(guardar, "Guardando", async () => {
        try {
          await guardarConfig(nuevos.length ? "espacios de trabajo de Railway" : "sin espacios de trabajo de Railway", (config) => {
            config.railway = { ...(config.railway ?? {}), workspaceIds: nuevos };
            if (!("presupuestoMensualUsd" in config.railway)) config.railway.presupuestoMensualUsd = null;
          });
          dibujarRailway();
          hecho("Espacios de trabajo guardados. Se usan desde la próxima corrida.");
        } catch (error) {
          aviso(mensaje, error.message, "bad");
        }
      });
    });

    return el(
      "details",
      { class: "card como", open: ids.length > 0 },
      el("summary", { text: "Espacios de trabajo a mirar" }),
      el(
        "p",
        { class: "ayuda", id: "r-espacios-ayuda" },
        "Lo normal es dejarlo vacío, y los espacios salen del token. Sirve solo con un token de cuenta, para mirar algunos espacios y no todos. Con cualquier otro token tiene que quedar vacío, porque cargado el chequeo manda el token como de cuenta y la lectura falla. Si en GitHub está la variable RAILWAY_WORKSPACE_ID, manda ella. ",
        afuera(enGitHub("/settings/variables/actions"), "Ver las variables")
      ),
      ids.length && rw?.estado === "error" ? el("div", { class: "msg bad", text: "Hay espacios cargados y la lectura de Railway falló. Si el token no es de cuenta, conviene vaciar esta lista." }) : null,
      el("label", { for: "r-espacios", text: "Ids, separados por coma" }),
      formulario,
      mensaje
    );
  }

  function dibujarRailway() {
    const rw = datos.ultimo?.railway ?? null;
    const destino = $("r-contenido");
    $("r-consultado").textContent = rw?.consultado ? `Uso y gasto del período, consultado ${hace(rw.consultado)}.` : "Uso y gasto del período, según el último chequeo.";

    const espacios = rw?.espacios ?? [];
    const partes = [el("div", { class: "grilla dos" }, tarjetaToken(rw), tarjetaPresupuesto(espacios))];
    espacios.forEach((espacio, i) => partes.push(tarjetaEspacio(espacio, rw, i === 0)));

    // Los proyectos que todavía no son de ningún sitio. Con un token de cuenta o de espacio
    // aparecen todos los del espacio, y así es como un turnero nuevo entra al control.
    const usados = new Set(datos.sitios.map((sitio) => sitio.railwayProjectId).filter(Boolean));
    const libres = espacios.flatMap((espacio) => espacio.proyectos ?? []).filter((proyecto) => proyecto?.id && !proyecto.borrado && !usados.has(proyecto.id));
    if (libres.length) {
      partes.push(
        el(
          "section",
          { class: "card" },
          el("h3", { text: libres.length === 1 ? "1 proyecto sin sitio" : `${libres.length} proyectos sin sitio` }),
          el("p", { class: "hint", text: "Están en Railway y ningún sitio del control los usa. Se agregan como sitio, o se asignan a uno que ya existe en la lista de arriba." }),
          el(
            "ul",
            { class: "mini-lista libres" },
            libres.map((proyecto) =>
              el(
                "li",
                {},
                el("span", {}, el("span", { class: "proyecto-nombre", text: proyecto.nombre }), el("span", { class: "sub-nombre mono", text: ` ${proyecto.id}` })),
                el(
                  "button",
                  { type: "button", class: "ghost chico", disabled: !datos.config, onclick: () => editarSitio(null, { nombre: proyecto.nombre, railwayProjectId: proyecto.id }) },
                  "Agregar como sitio"
                )
              )
            )
          )
        )
      );
    }

    const enRailway = new Set(espacios.flatMap((espacio) => (espacio.proyectos ?? []).map((proyecto) => proyecto.id)));
    const sinDatos = datos.sitios.filter((sitio) => !sitio.railwayProjectId || !enRailway.has(sitio.railwayProjectId));
    if (sinDatos.length) {
      partes.push(
        el(
          "section",
          { class: "card" },
          el("h3", { text: "Sitios sin datos de uso" }),
          el(
            "ul",
            { class: "mini-lista" },
            sinDatos.map((sitio) => {
              let motivo = "No está en Railway";
              if (sitio.railwayProjectId && rw?.estado === "ok") motivo = "Su proyecto no aparece con este token";
              else if (sitio.railwayProjectId) motivo = "Sin datos de Railway todavía";
              else if (esRailway(sitio)) motivo = espacios.length ? "Sin proyecto. Se asigna en la lista de arriba" : "Sin proyecto asignado";
              return el("li", {}, el("span", {}, nombreSitio(sitio)), el("span", { class: "motivo", text: motivo }));
            })
          )
        )
      );
    }

    partes.push(tarjetaEspaciosDeTrabajo(rw));
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
    if (EMAIL.test(mail)) enlaces.push(el("a", { href: `mailto:${mail}`, class: "boton" }, "Mail"));
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
        el("div", { class: "sitio-cabeza" }, el("h3", {}, nombreSitio(sitio), el("span", { class: "pill", text: sitio.tipo === "turnero" ? "turnero" : "web" })), chipNivel(resultadoDe(sitio.id)?.nivel)),
        el("p", { class: "meta", text: contacto.nombre || "Sin contacto cargado" }),
        enlaces.length ? el("div", { class: "botones-contacto" }, enlaces) : el("p", { class: "hint", text: "Sin teléfono ni mail. Se cargan con Editar." }),
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
          el("button", { type: "button", class: "ghost chico", onclick: () => editarSitio(sitio.id) }, "Editar"),
          el("button", { type: "button", class: "ghost chico", onclick: () => nuevoTicket(sitio.id) }, "Nuevo ticket"),
          el("button", { type: "button", class: "ghost chico", onclick: () => nuevaNota(sitio.id) }, "Nueva nota")
        )
      );
    });
    $("k-lista").replaceChildren(
      ...(tarjetas.length
        ? tarjetas
        : [
            el(
              "div",
              { class: "card vacio-grande" },
              el("p", { text: "Todavía no hay clientes." }),
              el("button", { type: "button", class: "chico", onclick: () => editarSitio(null) }, "Agregar el primero")
            ),
          ])
    );
  }

  /* ---------- Editor de sitios ---------- */

  const OTRO_PROYECTO = "__otro";
  let sitioEditado = null;
  let idTocado = false;

  const CAMPOS_SITIO = {
    nombre: "k-nombre",
    id: "k-id",
    tipo: "k-tipo",
    front: "k-front",
    api: "k-api",
    railway: "k-proyecto",
    telefono: "k-c-telefono",
    whatsapp: "k-c-whatsapp",
    email: "k-c-email",
  };

  /** Los proyectos que vio el último chequeo, más el que tenga cargado el sitio. */
  function llenarProyectos(actual) {
    const conocidos = (datos.ultimo?.railway?.espacios ?? []).flatMap((espacio) => espacio.proyectos ?? []).filter((proyecto) => proyecto?.id && proyecto.id !== "");
    const opciones = [el("option", { value: "", text: "Sin proyecto" })];
    for (const proyecto of conocidos) opciones.push(el("option", { value: proyecto.id, text: `${proyecto.nombre}${proyecto.borrado ? " (borrado)" : ""}` }));
    if (actual && !conocidos.some((proyecto) => proyecto.id === actual)) opciones.push(el("option", { value: actual, text: `${actual} (no aparece en Railway)` }));
    opciones.push(el("option", { value: OTRO_PROYECTO, text: "Otro, escribiendo el id" }));
    $("k-proyecto").replaceChildren(...opciones);
    $("k-proyecto").value = actual ?? "";
    $("k-proyecto-otro").value = "";
    $("k-proyecto-otro").hidden = true;
  }

  function alternarTipo() {
    $("k-api-campo").hidden = $("k-tipo").value !== "turnero";
  }

  /**
   * Abre el editor. Con `id`, ese sitio; sin `id`, uno nuevo, que puede venir con algo ya
   * cargado (`base`), como un proyecto de Railway que todavía no es de ningún sitio.
   */
  function editarSitio(id, base = {}) {
    if (!datos.config) {
      mostrarVista("clientes");
      return aviso("c-aviso", "sitios.json no se pudo leer. Hay que arreglarlo en GitHub antes de editar desde acá.", "bad");
    }
    const sitio = id ? (datos.config.sitios ?? []).find((s) => s?.id === id) ?? null : null;
    const datosSitio = sitio ?? base;
    sitioEditado = sitio?.id ?? null;
    idTocado = Boolean(sitio);
    const contacto = datosSitio.contacto ?? {};
    const formulario = $("k-editor");

    if (vistaActual !== "clientes") mostrarVista("clientes");
    $("k-editor-titulo").textContent = sitio ? `Editar ${sitio.nombre}` : base.railwayProjectId ? `Nuevo sitio para ${base.nombre ?? "el proyecto"}` : "Nuevo sitio";
    $("k-nombre").value = datosSitio.nombre ?? "";
    $("k-id").value = sitio ? sitio.id : aGuiones(datosSitio.nombre ?? "", 63);
    $("k-id").disabled = Boolean(sitio);
    $("k-tipo").value = datosSitio.tipo === "web" ? "web" : "turnero";
    $("k-front").value = datosSitio.front ?? "";
    $("k-api").value = datosSitio.api ?? "";
    $("k-marcador").value = datosSitio.marcador ?? "";
    $("k-c-nombre").value = contacto.nombre ?? "";
    $("k-c-email").value = contacto.email ?? "";
    $("k-c-telefono").value = contacto.telefono ?? "";
    $("k-c-whatsapp").value = contacto.whatsapp ?? "";
    $("k-c-notas").value = contacto.notas ?? "";
    llenarProyectos(datosSitio.railwayProjectId ?? "");
    alternarTipo();
    $("k-borrar").hidden = !sitio;
    $("k-confirmar").hidden = true;
    marcar(formulario, null, "", "k-msg");
    formulario.hidden = false;
    formulario.scrollIntoView({ behavior: "smooth", block: "start" });
    $("k-nombre").focus({ preventScroll: true });
  }

  function cerrarEditor() {
    sitioEditado = null;
    $("k-editor").hidden = true;
    $("k-confirmar").hidden = true;
  }

  /** Un número escrito con espacios de más queda con uno solo entre grupos. */
  const espaciado = (texto) => texto.trim().replace(/\s+/g, " ");

  async function guardarSitio(evento) {
    evento.preventDefault();
    const formulario = $("k-editor");
    const nuevo = !sitioEditado;
    const tipo = $("k-tipo").value;
    const proyectoElegido = $("k-proyecto").value;
    const sitio = {
      id: nuevo ? $("k-id").value.trim() : sitioEditado,
      nombre: $("k-nombre").value.trim(),
      tipo,
      front: $("k-front").value.trim(),
      api: tipo === "turnero" ? $("k-api").value.trim().replace(/\/+$/, "") : "",
      railwayProjectId: proyectoElegido === OTRO_PROYECTO ? $("k-proyecto-otro").value.trim() : proyectoElegido,
      marcador: $("k-marcador").value.trim(),
      contacto: {
        nombre: $("k-c-nombre").value.trim(),
        telefono: espaciado($("k-c-telefono").value),
        whatsapp: espaciado($("k-c-whatsapp").value),
        email: $("k-c-email").value.trim(),
        notas: $("k-c-notas").value.trim(),
      },
    };

    const problema = problemaDeSitio(sitio, { nuevo, ids: (datos.config?.sitios ?? []).map((s) => s?.id) });
    if (problema) {
      const [campo, texto] = problema;
      const idCampo = campo === "railway" && proyectoElegido === OTRO_PROYECTO ? "k-proyecto-otro" : CAMPOS_SITIO[campo];
      return marcar(formulario, idCampo, texto, "k-msg");
    }

    await trabajando($("k-guardar"), "Guardando", async () => {
      try {
        await guardarConfig(nuevo ? `nuevo ${sitio.id}` : `editado ${sitio.id}`, (config) => {
          if (!Array.isArray(config.sitios)) config.sitios = [];
          if (nuevo) {
            if (config.sitios.some((s) => s?.id === sitio.id)) return "Ya hay un sitio con ese id";
            config.sitios.push(sitio);
            return null;
          }
          const i = config.sitios.findIndex((s) => s?.id === sitioEditado);
          if (i < 0) return "Ese sitio ya no está en sitios.json";
          const previo = config.sitios[i];
          // Lo que esta página no conoce, si alguien lo agregó a mano, se queda.
          config.sitios[i] = { ...previo, ...sitio, contacto: { ...(previo.contacto ?? {}), ...sitio.contacto } };
          return null;
        });
        cerrarEditor();
        dibujarClientes();
        dibujarResumen();
        hecho(nuevo ? `${sitio.nombre} agregado. Se chequea desde la próxima corrida.` : `${sitio.nombre} guardado`);
      } catch (error) {
        aviso("k-msg", error.message, "bad");
      }
    });
  }

  function pedirBorrado() {
    const sitio = sitioPorId(sitioEditado);
    if (!sitio) return;
    const marca = `<!-- control:sitio=${sitio.id} -->`;
    const incidente = datos.incidentes.find((issue) => String(issue.body ?? "").includes(marca));
    $("k-confirmar-texto").textContent = [
      `Borrar ${sitio.nombre} lo saca de sitios.json y deja de chequearse.`,
      "Los tickets y las notas quedan en el repositorio.",
      incidente ? `El incidente #${incidente.number} queda abierto. Se cierra desde Estado.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    $("k-confirmar").hidden = false;
    $("k-confirmar-no").focus();
  }

  async function borrarSitio() {
    const sitio = sitioPorId(sitioEditado);
    if (!sitio) return;
    await trabajando($("k-confirmar-si"), "Borrando", async () => {
      try {
        await guardarConfig(`borrado ${sitio.id}`, (config) => {
          const antes = (config.sitios ?? []).length;
          config.sitios = (config.sitios ?? []).filter((s) => s?.id !== sitio.id);
          return config.sitios.length === antes ? "Ese sitio ya no estaba en sitios.json" : null;
        });
        cerrarEditor();
        dibujarClientes();
        dibujarResumen();
        hecho(`${sitio.nombre} borrado`);
      } catch (error) {
        $("k-confirmar").hidden = true;
        aviso("k-msg", error.message, "bad");
      }
    });
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
    const filtrando = $("t-f-cliente").value || $("t-f-prioridad").value || $("t-f-texto").value.trim();
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
        : [el("p", { class: "vacio", text: filtrando ? "Sin tickets con estos filtros." : datos.ticketsEstado === "open" ? "Sin tickets abiertos." : "Sin tickets." })])
    );
    if (ticketElegido && !tickets.some((t) => t.number === ticketElegido)) cerrarDetalle();
  }

  function cerrarDetalle() {
    ticketElegido = null;
    $("t-detalle").hidden = true;
    $("t-detalle").replaceChildren();
  }

  function abrirTicket(numero) {
    ticketElegido = numero;
    const ticket = datos.tickets.find((t) => t.number === numero) ?? datos.abiertos.find((t) => t.number === numero);
    if (!ticket) return;
    dibujarTickets();

    const detalle = $("t-detalle");
    detalle.replaceChildren(
      ...panelIssue(ticket, {
        idTexto: "t-comentario",
        antes: [
          el("h3", { text: ticket.title }),
          el(
            "div",
            { class: "linea meta" },
            `#${ticket.number}, abierto ${hace(ticket.created_at)}`,
            ticket.user?.login ? ` por ${ticket.user.login}` : "",
            " ",
            ...pastillasDe(ticket)
              .filter(Boolean)
              .flatMap((p) => [p, " "])
          ),
          aGitHub(ticket.html_url, "Ver en GitHub") ? el("div", { class: "enlaces" }, aGitHub(ticket.html_url, "Ver en GitHub")) : null,
        ],
        botones: [el("button", { type: "button", class: "ghost chico", onclick: cerrarDetalle }, "Cerrar el detalle")],
        alCambiar: async (estabaAbierto) => {
          await cargarAbiertos();
          await cargarTickets();
          ticketElegido = null;
          dibujarTickets();
          cerrarDetalle();
          hecho(estabaAbierto ? `Ticket #${numero} cerrado` : `Ticket #${numero} reabierto`);
        },
      })
    );
    detalle.hidden = false;
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
    const filtrando = $("n-f-cliente").value || $("n-f-tipo").value;
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
        : [pendientes ? cargando("Cargando notas") : el("p", { class: "vacio", text: filtrando ? "Sin notas con estos filtros." : "Todavía no hay notas." })])
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

  /* ---------- Ajustes ---------- */

  /** Si el formulario de ajustes tiene cambios sin guardar: un redibujo no los pisa. */
  let ajustesTocados = false;

  const CAMPOS_AJUSTES = { lento: "a-lento", "cert-aviso": "a-cert-aviso", "cert-falla": "a-cert-falla", avisar: "a-avisar" };

  function dibujarAjustes() {
    const config = datos.config;
    const formulario = $("a-form");
    for (const campo of formulario.querySelectorAll("input, button")) campo.disabled = !config;
    if (!config) aviso("a-msg", "sitios.json no se pudo leer. Hay que arreglarlo en GitHub antes de editar desde acá.", "bad");
    else if (!ajustesTocados) {
      const umbrales = { ...UMBRALES_POR_DEFECTO, ...(config.umbrales ?? {}) };
      $("a-lento").value = umbrales.lentoMs;
      $("a-cert-aviso").value = umbrales.certificadoAvisoDias;
      $("a-cert-falla").value = umbrales.certificadoFallaDias;
      $("a-avisar").value = (Array.isArray(config.avisar) ? config.avisar : []).join(", ");
    }

    const item = (titulo, texto, ...enlaces) => el("li", {}, el("strong", { text: titulo }), el("p", { class: "hint", text: texto }), enlaces.some(Boolean) ? el("div", { class: "enlaces" }, enlaces) : null);
    $("a-github").replaceChildren(
      el("h3", { text: "Lo que se hace en GitHub" }),
      el("p", { class: "hint", text: "El token de esta página no tiene permiso para estas cosas, y es a propósito." }),
      el(
        "ul",
        { class: "lista-github" },
        item(
          "El token de Railway",
          "Es el secreto RAILWAY_TOKEN de Actions, y el token de esta página no puede leer ni escribir secretos.",
          afuera(enGitHub("/settings/secrets/actions"), "Abrir los secretos"),
          el("button", { type: "button", class: "enlace", onclick: () => mostrarVista("railway") }, "Cómo se carga")
        ),
        item(
          "La frecuencia del chequeo y su script",
          "Están en control.yml y en scripts/check.mjs, fijados por huella. Se cambian con git, desde la computadora, con credenciales que pueden tocar flujos.",
          afuera(enGitHub(`/blob/${encodeURIComponent(rama)}/.github/workflows/${WORKFLOW}`), "Ver control.yml")
        ),
        item(
          "El token de esta página",
          "Vence a los 90 días. Se renueva en la configuración de GitHub, en los tokens de grano fino, y se pega de nuevo al conectar.",
          afuera("https://github.com/settings/personal-access-tokens", "Abrir los tokens")
        ),
        item(
          "Deshacer un cambio de sitios.json",
          "Cada cambio de esta página es un commit. El historial muestra qué cambió y cuándo.",
          afuera(enGitHub(`/commits/${encodeURIComponent(rama)}/sitios.json`), "Ver el historial"),
          afuera(enGitHub(`/blob/${encodeURIComponent(rama)}/sitios.json`), "Ver sitios.json")
        )
      )
    );
  }

  async function guardarAjustes(evento) {
    evento.preventDefault();
    const formulario = $("a-form");
    const umbrales = {
      lentoMs: entero($("a-lento").value),
      certificadoAvisoDias: entero($("a-cert-aviso").value),
      certificadoFallaDias: entero($("a-cert-falla").value),
    };
    const avisar = [...new Set($("a-avisar").value.split(/[\s,;]+/).map((usuario) => usuario.replace(/^@/, "")).filter(Boolean))];
    const problema = problemaDeAjustes({ umbrales, avisar });
    if (problema) return marcar(formulario, CAMPOS_AJUSTES[problema[0]], problema[1], "a-msg");

    await trabajando($("a-guardar"), "Guardando", async () => {
      try {
        await guardarConfig("ajustes del chequeo", (config) => {
          config.avisar = avisar;
          config.umbrales = { ...(config.umbrales ?? {}), ...umbrales };
        });
        ajustesTocados = false;
        marcar(formulario, null, "", "a-msg");
        dibujarAjustes();
        hecho("Ajustes guardados. Se usan desde la próxima corrida.");
      } catch (error) {
        if (error.status === 409 || error.status === 422) ajustesTocados = true;
        aviso("a-msg", error.message, "bad");
      }
    });
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

    $("e-actualizar").addEventListener("click", () =>
      trabajando($("e-actualizar"), "Actualizando", async () => {
        aviso("e-msg", "", "");
        await refrescarTodo();
      })
    );
    $("e-chequear").addEventListener("click", chequearAhora);

    // Editor de sitios
    $("k-nuevo").addEventListener("click", () => editarSitio(null));
    $("k-editor").addEventListener("submit", guardarSitio);
    $("k-cancelar").addEventListener("click", cerrarEditor);
    $("k-tipo").addEventListener("change", alternarTipo);
    $("k-nombre").addEventListener("input", () => {
      if (!idTocado) $("k-id").value = aGuiones($("k-nombre").value, 63);
    });
    $("k-id").addEventListener("input", () => {
      idTocado = true;
    });
    $("k-proyecto").addEventListener("change", () => {
      const otro = $("k-proyecto").value === OTRO_PROYECTO;
      $("k-proyecto-otro").hidden = !otro;
      if (otro) $("k-proyecto-otro").focus();
    });
    $("k-borrar").addEventListener("click", pedirBorrado);
    $("k-confirmar-no").addEventListener("click", () => {
      $("k-confirmar").hidden = true;
      $("k-borrar").focus();
    });
    $("k-confirmar-si").addEventListener("click", borrarSitio);

    // Una marca de error se va apenas se corrige el campo.
    for (const formulario of [$("k-editor"), $("a-form"), $("v-railway")]) {
      formulario.addEventListener("input", (evento) => evento.target.removeAttribute?.("aria-invalid"));
    }

    // Ajustes
    $("a-form").addEventListener("submit", guardarAjustes);
    $("a-form").addEventListener("input", () => {
      ajustesTocados = true;
    });

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

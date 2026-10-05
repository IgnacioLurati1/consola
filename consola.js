"use strict";

/*
 * La consola de instalaciones: crear el administrador de un consultorio y fijar sus reglas.
 *
 * Antes vivía adentro de index.html. Pasó a un archivo para que la página pueda tener una
 * política de contenido estricta (script-src 'self'): con eso, aunque algún texto llegara
 * a meterse como HTML, no puede correr código. El comportamiento es el mismo.
 *
 * Va todo adentro de una función para no compartir nombres con control.js, que corre en la
 * misma página.
 */
(() => {
  // GitHub Pages no deja mandar cabeceras, así que `frame-ancestors` no se puede poner y
  // otra página podría mostrar esta adentro de un marco invisible para hacer clic por mí.
  // Si está enmarcada, no se dibuja nada.
  if (window.top !== window.self) {
    document.body.replaceChildren();
    return;
  }

  /* ---- las tres áreas: Instalaciones, Control y Ayuda ---- */
  const AREA_GUARDADA = "consola-area";
  const pestañas = [
    { boton: document.getElementById("tab-instalaciones"), area: document.getElementById("area-instalaciones"), nombre: "instalaciones" },
    { boton: document.getElementById("tab-control"), area: document.getElementById("area-control"), nombre: "control" },
    { boton: document.getElementById("tab-ayuda"), area: document.getElementById("area-ayuda"), nombre: "ayuda" },
  ];

  function mostrarArea(nombre) {
    for (const pestaña of pestañas) {
      const activa = pestaña.nombre === nombre;
      pestaña.boton.setAttribute("aria-selected", String(activa));
      pestaña.boton.tabIndex = activa ? 0 : -1;
      pestaña.area.hidden = !activa;
    }
    try { localStorage.setItem(AREA_GUARDADA, nombre); } catch {}
    // control.js escucha esto para cargar sus datos recién cuando se lo mira.
    document.dispatchEvent(new CustomEvent("consola:area", { detail: nombre }));
  }

  for (const pestaña of pestañas) {
    pestaña.boton.addEventListener("click", () => mostrarArea(pestaña.nombre));
    pestaña.boton.addEventListener("keydown", (evento) => {
      if (evento.key !== "ArrowRight" && evento.key !== "ArrowLeft") return;
      const paso = evento.key === "ArrowRight" ? 1 : -1;
      const otra = pestañas[(pestañas.indexOf(pestaña) + paso + pestañas.length) % pestañas.length];
      mostrarArea(otra.nombre);
      otra.boton.focus();
    });
  }

  // El token vive en sessionStorage y no en localStorage: cerrar la pestaña termina la
  // sesión. La contraseña no se guarda en ningún lado, ni siquiera entre los dos pasos.
  const GUARDADO = "consola-servidor";
  let api = "";
  let token = "";

  const $ = (id) => document.getElementById(id);
  const ver = (id, mostrar) => { $(id).hidden = !mostrar; };

  // El texto va como texto: los mensajes vienen del servidor, y lo que viene de afuera no
  // se interpreta como HTML.
  function aviso(destino, texto, clase) {
    const caja = $(destino);
    caja.replaceChildren();
    if (!texto) return;
    const mensaje = document.createElement("div");
    mensaje.className = `msg ${clase}`;
    mensaje.textContent = texto;
    caja.appendChild(mensaje);
  }

  function leerGuardado(clave) {
    try { return sessionStorage.getItem(clave) ?? localStorage.getItem(clave) ?? ""; } catch { return ""; }
  }

  /**
   * Si la página puede hablarle a esa dirección. Es lo mismo que deja el connect-src de
   * index.html: con cualquier otra, el navegador corta el pedido antes de salir y lo único
   * que dice es "Failed to fetch".
   */
  function servidorPermitido(direccion) {
    try {
      const url = new URL(direccion);
      if (url.protocol === "https:" && url.hostname.endsWith(".up.railway.app")) return true;
      return url.protocol === "http:" && url.hostname === "localhost" && url.port === "3000";
    } catch {
      return false;
    }
  }

  async function pedir(ruta, opciones = {}) {
    let respuesta;
    try {
      respuesta = await fetch(api + ruta, {
        ...opciones,
        // Sin cookies: la consola se identifica solamente con su token.
        credentials: "omit",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(opciones.headers ?? {}),
        },
      });
    } catch {
      throw new Error("No se pudo conectar con el servidor. Revisá la dirección y la conexión");
    }

    let cuerpo = {};
    try { cuerpo = await respuesta.json(); } catch { /* una respuesta sin cuerpo */ }

    if (!respuesta.ok) {
      const error = new Error(cuerpo.message || `El servidor contestó ${respuesta.status}`);
      error.status = respuesta.status;
      throw error;
    }

    return cuerpo;
  }

  /* ---- paso 1: la instalación ---- */
  $("btn-destino").addEventListener("click", () => {
    // Sin barras ni /api al final: la consola agrega /api/console/... por su cuenta.
    const valor = $("api").value.trim().replace(/\/+$/, "").replace(/\/api$/i, "");
    if (!/^https?:\/\/.+/.test(valor)) {
      aviso("msg-login", "La dirección tiene que empezar con https://", "bad");
      ver("paso-login", true);
      return;
    }
    if (!servidorPermitido(valor)) {
      aviso("msg-login", "Va la dirección del servidor en Railway, la que termina en .up.railway.app. La de la página del consultorio no sirve acá.", "bad");
      ver("paso-login", true);
      return;
    }
    api = valor;
    try { localStorage.setItem(GUARDADO, api); } catch {}
    aviso("msg-login", "", "");
    ver("paso-destino", false);
    ver("paso-login", true);
    $("email").focus();
  });

  $("btn-volver").addEventListener("click", () => {
    ver("paso-login", false);
    ver("paso-destino", true);
    $("api").focus();
  });

  /* ---- paso 2: entrar ---- */
  $("btn-login").addEventListener("click", async () => {
    const boton = $("btn-login");
    const email = $("email").value.trim();
    const password = $("pass").value;

    if (!email || !password) return aviso("msg-login", "Faltan los datos", "bad");

    boton.disabled = true;
    aviso("msg-login", "", "");

    try {
      const sesion = await pedir("/api/console/login", { method: "POST", body: JSON.stringify({ email, password }) });
      token = sesion.token;
      try { sessionStorage.setItem("consola-token", token); } catch {}
      // La contraseña no se queda escrita en la pantalla.
      $("pass").value = "";
      $("acct").textContent = sesion.email;
      await cargarEstado();
      await cargarReglas();
      ver("paso-login", false);
      ver("paso-estado", true);
      ver("paso-crear", true);
      ver("paso-reglas", true);
    } catch (error) {
      aviso("msg-login", error.message, "bad");
    } finally {
      boton.disabled = false;
    }
  });

  $("btn-salir").addEventListener("click", () => {
    token = "";
    try { sessionStorage.removeItem("consola-token"); } catch {}
    ver("paso-estado", false);
    ver("paso-crear", false);
    ver("paso-reglas", false);
    ver("paso-login", true);
  });

  /* ---- paso 3: qué hay ---- */
  function pastilla(texto, clase) {
    const elemento = document.createElement("span");
    elemento.className = clase ? `pill ${clase}` : "pill";
    elemento.textContent = texto;
    return elemento;
  }

  async function cargarEstado() {
    const estado = await pedir("/api/console/status");

    $("inst").textContent = estado.issuer || "sin nombre de instalación";

    aviso(
      "aviso-transicion",
      estado.claimsRequired
        ? ""
        : "Esta instalación todavía acepta sesiones firmadas antes del cambio. Pasado un mes del despliegue, poner TOKEN_STRICT en 1.",
      "bad"
    );

    const cuerpo = $("tabla-admins").querySelector("tbody");
    cuerpo.replaceChildren();

    for (const admin of estado.admins) {
      const fila = document.createElement("tr");

      const quien = document.createElement("td");
      quien.className = "mono";
      quien.textContent = admin.email;
      const nombre = document.createElement("div");
      nombre.className = "sub-nombre";
      nombre.textContent = `${admin.name} ${admin.surname}`.trim();
      quien.appendChild(nombre);
      fila.appendChild(quien);

      const estados = document.createElement("td");
      const caja = document.createElement("div");
      caja.className = "pills";
      const pastillas = [];
      if (admin.owner) pastillas.push(pastilla("consola", "yo"));
      if (!admin.active) pastillas.push(pastilla("cerrada", "sin"));
      // Solo mientras tiene la contraseña al azar con la que se creó. `passwordSetAt` no
      // sirve para esto: es null en toda cuenta anterior a esa columna. Un servidor viejo
      // no manda `provisionalPassword`, y entonces no se marca nada.
      if (admin.provisionalPassword === true) pastillas.push(pastilla("sin contraseña", "pendiente"));
      if (!pastillas.length) pastillas.push(pastilla("al día", "bien"));
      caja.append(...pastillas);
      estados.appendChild(caja);
      fila.appendChild(estados);

      cuerpo.appendChild(fila);
    }
  }

  /* ---- crear ---- */
  $("btn-crear").addEventListener("click", async () => {
    const boton = $("btn-crear");
    const datos = {
      email: $("n-email").value.trim(),
      name: $("n-name").value.trim(),
      surname: $("n-surname").value.trim(),
      password: $("n-pass").value,
    };

    if (!datos.email || !datos.name || !datos.surname) return aviso("msg-crear", "Faltan datos del administrador", "bad");
    if (!datos.password) return aviso("msg-crear", "Falta tu contraseña", "bad");

    boton.disabled = true;
    aviso("msg-crear", "", "");

    try {
      const resultado = await pedir("/api/console/admins", { method: "POST", body: JSON.stringify(datos) });
      aviso("msg-crear", resultado.message, "ok");
      $("n-email").value = "";
      $("n-name").value = "";
      $("n-surname").value = "";
      $("n-pass").value = "";
      await cargarEstado();
    } catch (error) {
      if (error.status === 401) {
        aviso("msg-crear", "La sesión venció. Entrá de nuevo.", "bad");
        $("btn-salir").click();
      } else {
        aviso("msg-crear", error.message, "bad");
      }
    } finally {
      boton.disabled = false;
    }
  });

  /* ---- reglas ---- */
  // Lo que vino del servidor y lo que se está editando. Se guarda solo lo que cambió.
  let reglas = null;
  let borrador = {};
  let bloqueadas = new Set();

  // Qué regla se muestra según otra. Es el mismo "showIf" del catálogo del servidor.
  const MOSTRAR_SI = {
    cancelNoticeHours: (v) => v.patientCancel !== false,
    proOverbook: (v) => v.proCreate !== false,
    markWhen: (v) => v.markMode === "assisted" || v.markMode === "missed",
    payWhen: (v) => v.payMode === "always",
    reminderHoursBefore: (v) => v.reminders !== false,
    rentMorning: (v) => v.rentModule !== false,
    rentAfternoon: (v) => v.rentModule !== false,
  };

  async function cargarReglas() {
    reglas = await pedir("/api/console/rules");
    borrador = { ...reglas.values };
    bloqueadas = new Set(reglas.locked);
    dibujarReglas();
  }

  /**
   * El control de una regla, que va a la derecha de su nombre. El primer elemento que lleva
   * `id` es el que nombra la etiqueta de la regla.
   */
  function campoDe(regla, id) {
    const valor = borrador[regla.key];
    const cambiar = (nuevo) => {
      borrador[regla.key] = nuevo;
      dibujarReglas();
    };

    if (regla.kind === "bool") {
      // Un interruptor: es una casilla de siempre, dibujada distinto.
      const check = document.createElement("input");
      check.type = "checkbox";
      check.id = id;
      check.className = "interruptor";
      check.setAttribute("role", "switch");
      check.checked = valor === true;
      check.addEventListener("change", () => cambiar(check.checked));
      return [check];
    }

    if (regla.kind === "choice") {
      const lista = document.createElement("select");
      lista.id = id;
      for (const opcion of regla.options) {
        const item = document.createElement("option");
        item.value = opcion.value;
        item.textContent = opcion.label;
        lista.appendChild(item);
      }
      lista.value = String(valor);
      lista.addEventListener("change", () => cambiar(lista.value));
      return [lista];
    }

    if (regla.kind === "span") {
      const texto = document.createElement("input");
      texto.id = id;
      texto.className = "mono franja";
      texto.value = String(valor ?? "");
      texto.placeholder = "09:00-13:00";
      texto.addEventListener("change", () => cambiar(texto.value.trim()));
      return [texto];
    }

    // Número, y si acepta "nada", con su casilla al lado.
    const piezas = [];
    const sinValor = regla.nullLabel && valor === null;
    if (regla.nullLabel) {
      const nada = document.createElement("label");
      nada.className = "check";
      const check = document.createElement("input");
      check.type = "checkbox";
      if (sinValor) check.id = id;
      check.checked = valor === null;
      check.addEventListener("change", () => cambiar(check.checked ? null : regla.key === "reminderHoursBefore" ? 24 : 30));
      nada.append(check, document.createTextNode(regla.nullLabel));
      piezas.push(nada);
    }
    if (!sinValor) {
      const numero = document.createElement("input");
      numero.type = "number";
      numero.id = id;
      numero.className = "numero";
      numero.min = regla.min;
      numero.max = regla.max;
      numero.value = valor ?? "";
      numero.addEventListener("change", () => cambiar(numero.value === "" ? null : Number(numero.value)));
      piezas.push(numero);
    }
    return piezas;
  }

  /** Un candado abierto o cerrado, dibujado con dos trazos. */
  function iconoCandado(cerrado) {
    const NS = "http://www.w3.org/2000/svg";
    const dibujo = document.createElementNS(NS, "svg");
    dibujo.setAttribute("viewBox", "0 0 16 16");
    dibujo.setAttribute("aria-hidden", "true");
    dibujo.setAttribute("class", "icono");
    const cuerpo = document.createElementNS(NS, "rect");
    for (const [clave, valor] of Object.entries({ x: 3, y: 7, width: 10, height: 7, rx: 1.5 })) cuerpo.setAttribute(clave, valor);
    const arco = document.createElementNS(NS, "path");
    arco.setAttribute("d", cerrado ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 4.9-.7");
    dibujo.append(cuerpo, arco);
    return dibujo;
  }

  /**
   * El candado de una regla del consultorio: una casilla con su candado dibujado y lo que
   * quiere decir escrito al lado, para que no dependa del ícono.
   */
  function candadoDe(regla) {
    const candado = document.createElement("label");
    candado.className = "candado";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = bloqueadas.has(regla.key);
    check.setAttribute("aria-label", `Candado de ${regla.label}`);
    const texto = document.createElement("span");
    const pintar = () => {
      candado.classList.toggle("puesto", check.checked);
      candado.title = check.checked ? "El consultorio no la puede cambiar desde su panel" : "El consultorio la puede cambiar desde su panel";
      texto.textContent = check.checked ? "Con candado" : "Sin candado";
      candado.querySelector("svg")?.remove();
      candado.insertBefore(iconoCandado(check.checked), texto);
    };
    check.addEventListener("change", () => {
      if (check.checked) bloqueadas.add(regla.key);
      else bloqueadas.delete(regla.key);
      pintar();
      candado.closest(".regla")?.classList.toggle("fija", check.checked);
    });
    candado.append(check, texto);
    pintar();
    return candado;
  }

  function dibujarReglas() {
    const presets = $("presets");
    presets.replaceChildren();
    for (const preset of reglas.presets ?? []) {
      const boton = document.createElement("button");
      boton.type = "button";
      boton.className = "ghost";
      // La descripción entera queda en el globo: en el botón va en una sola línea.
      boton.title = preset.description;
      const nombre = document.createElement("span");
      nombre.className = "preset-nombre";
      nombre.textContent = "Partir de " + preset.label;
      const detalle = document.createElement("small");
      detalle.textContent = preset.description;
      boton.append(nombre, detalle);
      boton.addEventListener("click", () => {
        Object.assign(borrador, preset.values);
        dibujarReglas();
        aviso("msg-reglas", "Cargado el punto de partida. Falta guardar.", "ok");
      });
      presets.appendChild(boton);
    }
    $("presets-titulo").hidden = !(reglas.presets ?? []).length;

    const destino = $("reglas");
    destino.replaceChildren();

    for (const grupo of reglas.groups) {
      const caja = document.createElement("fieldset");
      const titulo = document.createElement("legend");
      titulo.textContent = grupo.title;
      caja.appendChild(titulo);

      for (const regla of reglas.rules.filter((r) => r.group === grupo.key)) {
        if (MOSTRAR_SI[regla.key] && !MOSTRAR_SI[regla.key](borrador)) continue;
        const id = `regla-${regla.key}`;

        const fila = document.createElement("div");
        fila.className = "regla";
        if (regla.scope !== "client") fila.classList.add("de-consola");
        else if (bloqueadas.has(regla.key)) fila.classList.add("fija");

        // A la izquierda, el nombre y la ayuda.
        const texto = document.createElement("div");
        texto.className = "regla-texto";
        const nombre = document.createElement("label");
        nombre.htmlFor = id;
        nombre.textContent = regla.label;
        texto.appendChild(nombre);
        if (regla.hint) {
          const ayuda = document.createElement("p");
          ayuda.className = "hint";
          ayuda.textContent = regla.hint;
          texto.appendChild(ayuda);
        }
        fila.appendChild(texto);

        // A la derecha, el control y, pegado, el candado o la marca de "solo consola".
        const campo = document.createElement("div");
        campo.className = "campo";
        campo.append(...campoDe(regla, id));
        if (regla.scope === "client") {
          campo.appendChild(candadoDe(regla));
        } else {
          const marca = document.createElement("span");
          marca.className = "dueño";
          marca.title = "El consultorio ni siquiera la ve";
          marca.textContent = "solo consola";
          campo.appendChild(marca);
        }
        fila.appendChild(campo);

        caja.appendChild(fila);
      }

      // Un grupo con todas sus reglas escondidas (por otra regla) no se muestra vacío.
      if (caja.querySelector(".regla")) destino.appendChild(caja);
    }
  }

  $("btn-reglas").addEventListener("click", async () => {
    const boton = $("btn-reglas");
    const values = {};
    for (const [clave, valor] of Object.entries(borrador)) {
      if (JSON.stringify(valor) !== JSON.stringify(reglas.values[clave])) values[clave] = valor;
    }
    const locked = [...bloqueadas];
    const mismosBloqueos = JSON.stringify([...locked].sort()) === JSON.stringify([...reglas.locked].sort());

    if (!Object.keys(values).length && mismosBloqueos) return aviso("msg-reglas", "No hay cambios para guardar", "bad");

    boton.disabled = true;
    aviso("msg-reglas", "", "");

    try {
      const resultado = await pedir("/api/console/rules", {
        method: "PATCH",
        body: JSON.stringify({ values, ...(mismosBloqueos ? {} : { locked }) }),
      });
      reglas = resultado;
      borrador = { ...reglas.values };
      bloqueadas = new Set(reglas.locked);
      dibujarReglas();
      aviso("msg-reglas", resultado.message || "Reglas guardadas", "ok");
    } catch (error) {
      if (error.status === 401) {
        aviso("msg-reglas", "La sesión venció. Entrá de nuevo.", "bad");
        $("btn-salir").click();
      } else {
        aviso("msg-reglas", error.message, "bad");
      }
    } finally {
      boton.disabled = false;
    }
  });

  /* ---- arranque ---- */
  const recordado = leerGuardado(GUARDADO);
  if (recordado) {
    $("api").value = recordado;
    api = recordado;
  }

  let areaInicial = "instalaciones";
  try {
    const guardada = localStorage.getItem(AREA_GUARDADA);
    if (pestañas.some((p) => p.nombre === guardada)) areaInicial = guardada;
  } catch {}
  mostrarArea(areaInicial);
  if (areaInicial === "instalaciones") $("api").focus();

  // Enter manda el paso que está a la vista.
  document.addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter") return;
    const dentroDe = (id) => !$(id).hidden && $(id).contains(document.activeElement);
    if (dentroDe("paso-crear")) $("btn-crear").click();
    else if (dentroDe("paso-login")) $("btn-login").click();
    else if (dentroDe("paso-destino")) $("btn-destino").click();
  });
})();

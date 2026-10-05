# Consola

Una página estática, sin build ni dependencias, con dos áreas:

- **Instalaciones**: la única página habilitada para crear un administrador en la base de un
  consultorio y fijar sus reglas. Habla con el servidor de cada turnero por
  `/api/console/*`.
- **Control**: el estado de todas las páginas, los incidentes, las corridas del chequeo, el
  gasto de Railway, los clientes, los tickets, las notas y los ajustes del control. No entra
  a ningún turnero; todo sale del repositorio privado de datos (`Control/control-datos`)
  por la API de GitHub, y casi todo se edita desde acá sin abrir el repositorio.

No va adentro de `frontend/`. Tiene que vivir en **su propio dominio**, porque el dominio
es uno de los cuatro controles de la puerta: el servidor de cada consultorio acepta
`/api/console/*` solamente desde el origen que tenga cargado en `CONSOLE_ORIGIN`, y ahí, a
diferencia del resto de la aplicación, una request sin `Origin` se rechaza.

## Archivos

| Archivo | Qué es |
|---|---|
| `index.html` | El marcado y la política de contenido |
| `consola.css`, `consola.js` | Instalaciones y las pestañas. Mismos pasos y mismas llamadas de siempre; en pantalla ancha la cuenta y el alta van lado a lado, y cada regla es una fila con el control y el candado a la derecha |
| `control.css`, `control.js` | Control |
| `ayuda.css`, `ayuda/` | Ayuda: un recorrido corto por todo lo que hace la consola, con capturas de datos de ejemplo |

Los estilos y los scripts están en archivos y no adentro del HTML por la política de
contenido: `script-src 'self'` no deja correr nada escrito en la página.

## Cómo se publica

Cualquier hosting estático sirve: subir todos los archivos juntos, con la carpeta `ayuda/`. Lo que importa es que
quede en un dominio distinto del de la página del consultorio, y que ese dominio sea el que
figura en `CONSOLE_ORIGIN` de cada instalación, sin la barra final.

Una sola consola alcanza para todos los consultorios. La página pregunta a qué servidor
hablarle y lo recuerda en el navegador; cada servidor la acepta porque todos tienen el mismo
`CONSOLE_ORIGIN`.

Con GitHub Pages: un repositorio público solo con estos archivos (sin datos), **Settings →
Pages → Deploy from a branch**, rama `main`, carpeta `/`. Queda en
`https://ignaciolurati1.github.io/<repositorio>/`, y `CONSOLE_ORIGIN` es
`https://ignaciolurati1.github.io` (el origen no lleva la ruta).

## La política de contenido

El `<meta http-equiv="Content-Security-Policy">` de `index.html` deja:

- scripts y estilos solo de este mismo sitio;
- conexiones solo a `https://api.github.com`, a `https://*.up.railway.app` (los servidores
  de los turneros) y a `http://localhost:3000` (el backend local, para probar);
- nada más: ni imágenes de afuera, ni formularios que se manden a otro lado, ni `<base>`.

**Un turnero con dominio propio para su servidor** (por ejemplo `api.cliente.com.ar`) se
agrega a `connect-src`. Si no, ni Instalaciones ni la consulta en vivo de Control le pueden
hablar: el navegador corta el pedido antes de salir.

GitHub Pages no deja mandar cabeceras, así que `frame-ancestors` no se puede poner. En su
lugar, los dos scripts se niegan a dibujar si la página está adentro de un marco.

## Lo que hace falta del lado del servidor

| Variable | Qué es |
|---|---|
| `CONSOLE_ORIGIN` | El dominio de esta página, y nada más |
| `CONSOLE_JWT_SECRET` | La clave de firma de la consola. Distinta de `JWT_SECRET`; el arranque lo comprueba |
| `OWNER_EMAILS` | Las cuentas que pueden entrar. Sin lista cargada no entra nadie |
| `TOKEN_ISSUER` | El nombre corto de la instalación, que la consola muestra para no operar a ciegas |
| `INITIAL_ADMINS` | La cuenta con la que se abre la consola la primera vez, en una base nueva |

La marca "sin contraseña" de la lista de administradores sale de `provisionalPassword` en
`GET /api/console/status`: es verdadera solo mientras la cuenta tiene la contraseña al azar
con la que se creó. Un servidor anterior a ese campo no lo manda, y entonces no se marca
nada.

Control no necesita ninguna. Usa solo `GET /api/health`, que es pública (ver abajo).

## Los cuatro controles

1. **El origen.** Obligatorio y en la lista. Esto no autoriza —lo aplica el navegador, así
   que una terminal lo ignora—; está para que una página cualquiera abierta en mi navegador
   no pueda usar mi sesión.
2. **El token.** Firmado con la clave de la consola y con su propia audiencia, así que una
   sesión del consultorio no abre nada de acá, ni siquiera la de un administrador.
3. **La cuenta.** Tiene que estar en `OWNER_EMAILS` y además existir, estar activa y ser de
   tipo admin en la base de esa instalación.
4. **La contraseña, otra vez**, en el momento de crear. Un token robado de una pestaña
   abierta no alcanza.

Los controles 2, 3 y 4 son los que frenan a alguien con una terminal.

## Control

Pide dos cosas: el repositorio de datos (`usuario/control-datos`) y un token de GitHub de
grano fino que vea solo ese repositorio, con Contents, Issues y Actions en lectura y
escritura. Cómo crearlo está en el README de `control-datos`.

El token queda en `sessionStorage`: se borra al cerrar la pestaña. El nombre del
repositorio queda en `localStorage`, que no es secreto.

Arriba de todas las vistas va un **resumen**: "Todo en orden", o cuántos problemas hay y
cuáles (sitios con falla o aviso, la última corrida fallida, un chequeo atrasado, Railway
sin token, con error, pasado del límite o del presupuesto), cada uno con un enlace a donde
se ve.

| Vista | Qué muestra y qué se hace |
|---|---|
| Estado | Cada sitio con su último resultado, la serie del último día y, en los turneros, la ruta de salud consultada en vivo. Los **incidentes**, abiertos y cerrados hace poco, con su detalle y comentarios: comentar, cerrar y reabrir. Las **últimas corridas** del flujo (estado, resultado, cuándo, si fue programada o a mano), y en las fallidas el paso que falló con lo que suele querer decir. **Chequear ahora** dispara el flujo y lo sigue (pedido, en cola, en curso, terminado); si falla, dice en qué paso |
| Railway | La clase de token en uso (cuenta, espacio o proyecto), el **presupuesto mensual** con cuánto se lleva del estimado, y el uso por espacio y por proyecto. A cada proyecto se le **asigna el sitio** ahí mismo. Los proyectos que ningún sitio usa se listan con **Agregar como sitio**, que abre el alta con el proyecto ya cargado. Los espacios de trabajo a mirar, si hicieran falta |
| Clientes | WhatsApp, teléfono y mail de cada cliente, con sus tickets abiertos y sus notas. **Nuevo sitio** y **Editar**: datos del sitio y del contacto, y borrar |
| Tickets | Issues con la etiqueta `ticket`. Filtrar, crear, comentar, cerrar y reabrir |
| Notas | Relevamientos, análisis y notas por cliente, en `notas/`. Crear y editar; se guardan con un commit cada una |
| Ajustes | Umbrales del chequeo y los usuarios de GitHub que se mencionan en cada incidente. Y lo que se hace en GitHub, con sus enlaces |

### Cómo se edita `sitios.json`

Cada cambio (un sitio, un contacto, un proyecto asignado, el presupuesto, los ajustes) es
un commit `Sitios · …` con la API de contenidos. Se manda con el `sha` de la versión leída:
si el archivo cambió en el medio, GitHub contesta 409, la página lo vuelve a leer y pide
guardar otra vez, y el cambio sale sobre la versión nueva sin pisar la otra. Se escribe con
dos espacios y un salto al final, como siempre, y los campos que la página no conoce se
dejan como están.

Antes de guardar se valida lo mismo que `scripts/check.mjs` necesita para no tropezar:

- el id en minúsculas, números y guiones, único, y fijo después de creado (es la etiqueta
  `cliente:<id>` y la carpeta de notas);
- la página y el servidor con `https://`, y el servidor obligatorio en un turnero;
- teléfono y WhatsApp solo con números y espacios, el WhatsApp con código de país;
- los umbrales como enteros (lento de 100 a 15000 ms, la falla de certificado en menos
  días que el aviso), el presupuesto mayor que cero, y los usuarios a avisar con el formato
  de GitHub.

### Lo que no se puede hacer desde acá

| Qué | Por qué | Dónde |
|---|---|---|
| El token de Railway (`RAILWAY_TOKEN`) | Es un secreto de Actions, y el token de la consola no tiene permiso **Secrets**. A propósito | Settings → Secrets and variables → Actions. La vista Railway tiene los pasos y el enlace |
| La variable `RAILWAY_WORKSPACE_ID` | Tampoco tiene permiso **Variables** | Al lado de los secretos |
| La frecuencia del chequeo y `scripts/check.mjs` | El flujo fija la huella del script, y el token no tiene **Workflows** | Con git, desde la computadora |
| Leer el registro completo de una corrida | GitHub lo sirve con una redirección a otro dominio, que la política de contenido corta. La página muestra el paso que falló y enlaza la corrida | La corrida en GitHub |
| Renovar el token de la consola | Es de la cuenta, no del repositorio | Settings → Developer settings → Fine-grained tokens |
| Borrar una nota | No está hecho | En el repositorio |

Todo lo que viene del repositorio o de una API se dibuja como texto (`textContent`), nunca
como HTML. Los enlaces armados con datos solo pueden ser `https:`, `mailto:` o `tel:`. El
cuerpo de un incidente (la tabla de controles que escribe `check.mjs`) se arma con nodos de
tabla, también sin interpretar HTML.

## La ruta de salud de los turneros

`GET /api/health`, en `backend/src/health/`. Pública, sin credenciales, con su propio
limitador (veinte por minuto por dirección) y `Access-Control-Allow-Origin: *`, que es la
única excepción a la lista de orígenes del servidor. Contesta:

```json
{ "ok": true, "time": "…", "version": "3f9a2c1", "db": "ok",
  "jobs": [{ "name": "recordatorios", "lastRun": "…", "late": false }] }
```

Sin mails, sin variables de entorno, sin conteos. 503 si la base no contesta.

## Seguridad del control

**El origen compartido.** `https://ignaciolurati1.github.io` es el origen de *todas* mis
páginas de GitHub Pages que no tienen dominio propio, no solo de esta. Para el navegador
son la misma página. Eso quiere decir que cualquier otra de esas páginas, o una dependencia
comprometida de alguna:

- lee el `localStorage` de la consola (el servidor recordado y el repositorio);
- lee el `sessionStorage`, y con él el token de GitHub, si se abre en la misma pestaña
  después de la consola;
- pasa el primer control de `/api/console/*`, porque su origen es el de `CONSOLE_ORIGIN`.
  Los otros tres controles siguen en pie, pero uno de los cuatro se pierde.

**Cómo mudarla a un subdominio propio**, que es lo recomendado:

1. Un dominio mío, no el de un cliente. Por ejemplo `consola.<mi-dominio>.com.ar`.
2. En el repositorio de la consola, **Settings → Pages → Custom domain**: el subdominio.
   GitHub agrega el archivo `CNAME`.
3. En el DNS, un `CNAME` del subdominio a `ignaciolurati1.github.io`. Si el DNS está en
   Cloudflare, en "DNS only" (sin el proxy naranja), o GitHub no puede emitir el
   certificado.
4. Esperar el certificado y marcar **Enforce HTTPS**.
5. En cada turnero, en Railway, `CONSOLE_ORIGIN=https://consola.<mi-dominio>.com.ar` y
   redeploy.
6. Abrir la consola en la dirección nueva y volver a conectar Control: el token y lo
   recordado no pasan de un origen a otro.

**Si me roban el token de GitHub** se pueden leer contactos y notas y tocar issues y
archivos del repositorio de datos (`sitios.json` incluido, así que también qué se chequea y
a quién se avisa), pero no el token de Railway: el flujo fija la huella del script que lo
usa, y el token de la consola no puede cambiar flujos ni leer secretos. Cada cambio queda
como commit, así que se ve y se deshace. Se revoca en GitHub → Settings → Developer
settings → Fine-grained tokens.

**Si me roban la sesión de la consola de Instalaciones**, valen los cuatro controles de
siempre.

## Qué no hace

No cambia de rol a una cuenta que ya existe. Subir a administrador a un paciente o a un
profesional es otra operación, con otras consecuencias —se queda con su historia de turnos
y con sus pacientes—, y no es lo que esta pantalla dice que hace.

No elige la contraseña del administrador nuevo. Le pone una al azar que nadie ve y le manda
el mail para que elija la suya, igual que con cualquier alta del panel.

Control no entra a ningún turnero ni toca su base. Para ver lo que pasa adentro de una
instalación está Instalaciones.

## Registro

Cada llamada a `/api/console/*`, la que entra y la que no, se escribe en el log de la
plataforma con la cuenta, el origen y el resultado. Va al log y no a una tabla a propósito:
la tabla vive en la base que esta puerta puede cambiar, y un registro que el atacante puede
editar no es un registro.
